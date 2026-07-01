const { ts, isTokenExpired } = require("./crypto-utils");
const { USAGE_URL } = require("./config");
const { httpJson, buildCodexHeaders } = require("./http-client");
const { loadIdx, saveIdx, saveAcct } = require("./storage");
const { logWarn } = require("./logger");

function extractCodeFromError(err) {
  const message = String(err?.message || err || "");
  return message.match(/HTTP\s+\d+\s+([a-z0-9_]+)/i)?.[1] ||
    message.match(/\b(error_code|code)=([a-z0-9_]+)/i)?.[2] ||
    null;
}

async function ensureAccessTokenForQuota(acct) {
  if (!isTokenExpired(acct.tokens?.access_token || "")) return;

  const { refreshOneTok } = require("./token-refresh");
  const result = await refreshOneTok(acct);
  if (!result?.ok) {
    throw new Error("Token 已过期且刷新失败: " + (result?.error || "未知错误"));
  }
}

async function fetchQuota(acct) {
  const headers = buildCodexHeaders(acct);
  const resp = await httpJson(USAGE_URL, { headers });
  if (resp.status >= 400) {
    const { extractErrorCode } = require("./http-client");
    const code = extractErrorCode(resp.body);
    throw new Error("HTTP " + resp.status + (code ? " " + code : ""));
  }
  const data = JSON.parse(resp.body);
  return parseQuotaPayload(data);
}

function parseQuotaPayload(data) {
  const rl2 = data.rate_limit || {};
  const pw = rl2.primary_window || null;
  const sw = rl2.secondary_window || null;

  const remaining = (win) => {
    if (!win) return null;
    const used = Number(win.used_percent ?? 0);
    const normalized = Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : 0;
    return 100 - normalized;
  };
  const resetTime = (win) => {
    if (!win) return null;
    if (win.reset_at) return win.reset_at;
    if (win.reset_after_seconds != null) return ts() + win.reset_after_seconds;
    return null;
  };
  const windowMin = (win) => win && win.limit_window_seconds ? Math.ceil(win.limit_window_seconds / 60) : null;

  const hourlyRemaining = remaining(pw);
  const weeklyRemaining = remaining(sw);
  const weeklyBlocksHourly = weeklyRemaining === 0 && hourlyRemaining != null;
  const resetCreditsAvailable = (data.rate_limit_reset_credits || {}).available_count;

  return {
    hourly_percentage: weeklyBlocksHourly ? 0 : hourlyRemaining,
    hourly_remaining_percentage: weeklyBlocksHourly ? 0 : hourlyRemaining,
    hourly_reset_time: resetTime(pw),
    hourly_window_minutes: windowMin(pw),
    hourly_window_present: !!pw,
    weekly_percentage: weeklyRemaining,
    weekly_remaining_percentage: weeklyRemaining,
    weekly_reset_time: resetTime(sw),
    weekly_window_minutes: windowMin(sw),
    weekly_window_present: !!sw,
    weekly_blocks_hourly: weeklyBlocksHourly,
    reset_credits_available: resetCreditsAvailable == null ? null : Math.max(0, Number(resetCreditsAvailable) || 0),
    reset_credits: [],
    reset_credits_next_expires_at: null,
    plan_type: data.chatgpt_plan_type || data.plan_type || null,
    raw_data: data,
  };
}

function quotaRetryDelaySeconds(acct, error) {
  const failures = Math.max(1, Number(acct.quota_refresh_failures || 0));
  if (/\b429\b|rate.?limit/i.test(String(error?.message || error || ""))) return 15 * 60;
  return Math.min(30 * 60, 60 * (2 ** Math.min(5, failures - 1)));
}

async function refreshQuota(acct, options = {}) {
  const force = options.force !== false;
  const now = ts();
  if (!force && acct.quota_next_retry_at && Number(acct.quota_next_retry_at) > now) {
    const retryError = new Error(`Quota refresh is waiting for retry until ${acct.quota_next_retry_at}`);
    retryError.code = "quota_retry_pending";
    throw retryError;
  }
  try {
    await ensureAccessTokenForQuota(acct);
    const q = await fetchQuota(acct);
    acct.quota = q;
    acct.quota_error = null;
    acct.usage_updated_at = now;
    acct.quota_last_attempt_at = now;
    acct.quota_refresh_failures = 0;
    acct.quota_next_retry_at = null;
    if (q.plan_type && acct.plan_type !== q.plan_type) {
      acct.plan_type = q.plan_type;
      const idx = loadIdx();
      const ai = idx.accounts.find((a) => a.id === acct.id);
      if (ai) ai.plan_type = q.plan_type;
      saveIdx(idx);
    }
    if (q.reset_credits_available != null) {
      acct.reset_credits = {
        available_count: q.reset_credits_available,
        credits: acct.reset_credits?.credits || [],
        next_expires_at: q.reset_credits_available > 0 ? (acct.reset_credits?.next_expires_at || null) : null,
      };
    }
    saveAcct(acct);
    return q;
  } catch (err) {
    acct.quota_last_attempt_at = now;
    acct.quota_refresh_failures = Number(acct.quota_refresh_failures || 0) + 1;
    acct.quota_next_retry_at = now + quotaRetryDelaySeconds(acct, err);
    acct.quota_error = {
      code: extractCodeFromError(err),
      message: err?.message || String(err),
      timestamp: ts(),
    };
    saveAcct(acct);
    logWarn(`Quota refresh failed and was scheduled for retry: ${err?.message || err}`);
    throw err;
  }
}

// 自动切号指标提取
function extractQuotaMetrics(acct) {
  const q = acct.quota;
  if (!q) return [];
  const hasPresence = q.hourly_window_present != null || q.weekly_window_present != null;
  const hourlyRemaining = q.hourly_remaining_percentage ?? q.hourly_percentage;
  const weeklyRemaining = q.weekly_remaining_percentage ?? q.weekly_percentage;
  const metrics = [];
  if ((!hasPresence || q.hourly_window_present) && hourlyRemaining != null) {
    const label = q.hourly_window_minutes
      ? (q.hourly_window_minutes >= 60 ? Math.round(q.hourly_window_minutes / 60) + "h" : q.hourly_window_minutes + "m")
      : "5h";
    metrics.push({ key: "primary_window", label, percentage: Math.max(0, Math.min(100, hourlyRemaining)) });
  }
  if ((!hasPresence || q.weekly_window_present) && weeklyRemaining != null) {
    metrics.push({ key: "secondary_window", label: "Weekly", percentage: Math.max(0, Math.min(100, weeklyRemaining)) });
  }
  return metrics;
}

module.exports = { fetchQuota, refreshQuota, extractQuotaMetrics, quotaRetryDelaySeconds, parseQuotaPayload };

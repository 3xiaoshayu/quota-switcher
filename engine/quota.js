const { ts, isTokenExpired } = require("./crypto-utils");
const { USAGE_URL } = require("./config");
const { httpJson, buildCodexHeaders } = require("./http-client");
const { loadIdx, saveIdx, saveAcct } = require("./storage");

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
  const rl2 = data.rate_limit || {};
  const pw = rl2.primary_window || null;
  const sw = rl2.secondary_window || null;

  const remaining = (win) => win ? 100 - (win.used_percent || 0) : 100;
  const resetTime = (win) => {
    if (!win) return null;
    if (win.reset_at) return win.reset_at;
    if (win.reset_after_seconds != null) return ts() + win.reset_after_seconds;
    return null;
  };
  const windowMin = (win) => win && win.limit_window_seconds ? Math.ceil(win.limit_window_seconds / 60) : null;

  return {
    hourly_percentage: remaining(pw),
    hourly_reset_time: resetTime(pw),
    hourly_window_minutes: windowMin(pw),
    hourly_window_present: !!pw,
    weekly_percentage: remaining(sw),
    weekly_reset_time: resetTime(sw),
    weekly_window_minutes: windowMin(sw),
    weekly_window_present: !!sw,
    reset_credits_available: (data.rate_limit_reset_credits || {}).available_count || null,
    reset_credits: [],
    reset_credits_next_expires_at: null,
    plan_type: data.chatgpt_plan_type || data.plan_type || null,
    raw_data: data,
  };
}

async function refreshQuota(acct) {
  try {
    await ensureAccessTokenForQuota(acct);
    const q = await fetchQuota(acct);
    acct.quota = q;
    acct.quota_error = null;
    acct.usage_updated_at = ts();
    if (q.plan_type && acct.plan_type !== q.plan_type) {
      acct.plan_type = q.plan_type;
      const idx = loadIdx();
      const ai = idx.accounts.find((a) => a.id === acct.id);
      if (ai) ai.plan_type = q.plan_type;
      saveIdx(idx);
    }
    if (q.reset_credits_available != null && q.reset_credits_available > 0 && !acct.reset_credits) {
      acct.reset_credits = { available_count: q.reset_credits_available, credits: [], next_expires_at: null };
    }
    saveAcct(acct);
    return q;
  } catch (err) {
    acct.quota_error = {
      code: extractCodeFromError(err),
      message: err?.message || String(err),
      timestamp: ts(),
    };
    saveAcct(acct);
    throw err;
  }
}

// 自动切号指标提取
function extractQuotaMetrics(acct) {
  const q = acct.quota;
  if (!q) return [];
  const hasPresence = q.hourly_window_present != null || q.weekly_window_present != null;
  const metrics = [];
  if (!hasPresence || q.hourly_window_present) {
    const label = q.hourly_window_minutes
      ? (q.hourly_window_minutes >= 60 ? Math.round(q.hourly_window_minutes / 60) + "h" : q.hourly_window_minutes + "m")
      : "5h";
    metrics.push({ key: "primary_window", label, percentage: Math.max(0, Math.min(100, q.hourly_percentage)) });
  }
  if (!hasPresence || q.weekly_window_present) {
    metrics.push({ key: "secondary_window", label: "Weekly", percentage: Math.max(0, Math.min(100, q.weekly_percentage)) });
  }
  if (metrics.length === 0) {
    metrics.push({ key: "primary_window", label: "5h", percentage: Math.max(0, Math.min(100, q.hourly_percentage)) });
  }
  return metrics;
}

module.exports = { fetchQuota, refreshQuota, extractQuotaMetrics };

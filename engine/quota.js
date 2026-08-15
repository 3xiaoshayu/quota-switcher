const { ts, isTokenExpired } = require("./crypto-utils");
const { USAGE_URL } = require("./config");
const { httpJson, buildCodexHeaders } = require("./http-client");
const { loadIdx, saveIdx, saveAcct } = require("./storage");
const { logWarn } = require("./logger");
const {
  STATUS_BANNED,
  STATUS_USAGE_LIMITED,
  STATUS_PROBE_FAILED,
  classifyProbe,
  classifyThrownError,
  classifyMissingToken,
  isLeftoverAccessRejected,
  probeError,
  applyProbeToAccount,
} = require("./account-probe");

const TOKEN_REPAIR_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "invalid_refresh_token",
  "token_revoked",
  "token_invalidated",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

function extractCodeFromError(err) {
  const message = String(err?.message || err || "");
  return message.match(/HTTP\s+\d+\s+([a-z0-9_]+)/i)?.[1] ||
    message.match(/\b(error_code|code)=([a-z0-9_]+)/i)?.[2] ||
    null;
}

function isQuotaAuthError(error) {
  const code = String(error?.code || extractCodeFromError(error) || "").toLowerCase();
  return TOKEN_REPAIR_CODES.has(code) || /\bHTTP\s+401\b/i.test(String(error?.message || error || ""));
}

function probeFromRefreshResult(result) {
  return classifyProbe({
    source: "refresh",
    httpStatus: 0,
    body: result?.detail || result?.error || "",
    headers: {},
    code: result?.code || null,
  });
}

async function ensureAccessTokenForQuota(acct, refreshTask) {
  if (!acct?.tokens?.access_token && !acct?.tokens?.refresh_token) {
    throw probeError(classifyMissingToken());
  }
  if (!isTokenExpired(acct.tokens?.access_token || "")) return;

  const refresh = refreshTask || require("./token-refresh").refreshOneTok;
  const result = await refresh(acct);
  if (!result?.ok) {
    const probe = probeFromRefreshResult(result);
    const error = new Error("Token 已过期且刷新失败: " + (result?.error || "未知错误"));
    error.code = probe.error_code || result?.code || "token_refresh_failed";
    error.probe = probe;
    throw error;
  }
}

function shouldSkipTokenRepair(error) {
  const probe = error?.probe || classifyThrownError(error, "usage");
  return probe.status === STATUS_BANNED || probe.status === STATUS_USAGE_LIMITED;
}

async function fetchQuotaWithTokenRepair(acct, dependencies = {}) {
  const fetchTask = dependencies.fetchQuota || fetchQuota;
  const refreshTask = dependencies.refreshOneTok || require("./token-refresh").refreshOneTok;
  await ensureAccessTokenForQuota(acct, refreshTask);
  try {
    return await fetchTask(acct);
  } catch (error) {
    if (!error.probe) error.probe = classifyThrownError(error, "usage");
    if (shouldSkipTokenRepair(error) || !isQuotaAuthError(error)) throw error;
    const refreshResult = await refreshTask(acct, { force: true });
    if (!refreshResult?.ok) {
      const probe = probeFromRefreshResult(refreshResult);
      const repairError = new Error(`Quota authorization could not be repaired: ${refreshResult?.error || error.message || error}`);
      repairError.code = probe.error_code || extractCodeFromError(error) || "quota_auth_repair_failed";
      repairError.probe = probe;
      repairError.cause = error;
      throw repairError;
    }
    try {
      return await fetchTask(acct);
    } catch (retryError) {
      if (!retryError.probe) retryError.probe = classifyThrownError(retryError, "usage");
      throw retryError;
    }
  }
}

function responseDiagnostics(resp) {
  const headers = resp.headers || {};
  const requestId = headers["request-id"] || headers["x-request-id"] || null;
  const cfRay = headers["cf-ray"] || null;
  const parts = [];
  if (requestId) parts.push(`request-id=${requestId}`);
  if (cfRay) parts.push(`cf-ray=${cfRay}`);
  parts.push(`body_len=${String(resp.body || "").length}`);
  return parts.join(" ");
}

async function fetchQuota(acct) {
  if (!acct?.tokens?.access_token) {
    throw probeError(classifyMissingToken());
  }
  const headers = buildCodexHeaders(acct);
  const resp = await httpJson(USAGE_URL, { headers });
  const probe = classifyProbe({
    source: "usage",
    httpStatus: resp.status,
    body: resp.body,
    headers: resp.headers,
  });
  if (probe.status !== "active") {
    logWarn(`Quota request failed: status=${resp.status}${probe.error_code ? ` code=${probe.error_code}` : ""} ${responseDiagnostics(resp)}`);
    const error = new Error("HTTP " + resp.status + (probe.error_code ? " " + probe.error_code : ""));
    error.code = probe.error_code || String(resp.status);
    error.probe = probe;
    throw error;
  }
  try {
    return parseQuotaPayload(JSON.parse(resp.body || "{}"));
  } catch {
    throw probeError(classifyProbe({
      source: "usage",
      httpStatus: resp.status,
      body: resp.body,
      headers: resp.headers,
    }));
  }
}

// Upstream currently ships only a weekly window and puts it in
// primary_window, so windows must be classified by their duration rather
// than their position. Anything up to a day counts as the short (5h) slot.
const HOURLY_WINDOW_MAX_SECONDS = 24 * 60 * 60;

function classifyRateLimitWindows(rateLimit) {
  const slots = { hourly: null, weekly: null };
  const candidates = [
    [rateLimit.primary_window, "hourly"],
    [rateLimit.secondary_window, "weekly"],
  ];
  for (const [win, positional] of candidates) {
    if (!win) continue;
    const seconds = Number(win.limit_window_seconds);
    const preferred = Number.isFinite(seconds) && seconds > 0
      ? (seconds <= HOURLY_WINDOW_MAX_SECONDS ? "hourly" : "weekly")
      : positional;
    if (!slots[preferred]) slots[preferred] = win;
    else if (!slots[preferred === "hourly" ? "weekly" : "hourly"]) {
      slots[preferred === "hourly" ? "weekly" : "hourly"] = win;
    }
  }
  return slots;
}

function parseQuotaPayload(data) {
  const rl2 = data.rate_limit || {};
  const { hourly: pw, weekly: sw } = classifyRateLimitWindows(rl2);

  const remaining = (win) => {
    if (!win) return null;
    if (win.used_percent == null || win.used_percent === "") return null;
    const used = Number(win.used_percent);
    if (!Number.isFinite(used)) return null;
    const normalized = Math.max(0, Math.min(100, used));
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
    plan_type: data.chatgpt_plan_type || data.plan_type || null,
    raw_data: data,
  };
}

function quotaRetryDelaySeconds(acct, error) {
  const failures = Math.max(1, Number(acct.quota_refresh_failures || 0));
  if (/\b429\b|rate.?limit/i.test(String(error?.message || error || ""))) return 15 * 60;
  return Math.min(30 * 60, 60 * (2 ** Math.min(5, failures - 1)));
}

function persistPlanType(acct, q) {
  if (q.plan_type && acct.plan_type !== q.plan_type) {
    acct.plan_type = q.plan_type;
    const idx = loadIdx();
    const ai = idx.accounts.find((a) => a.id === acct.id);
    if (ai) ai.plan_type = q.plan_type;
    saveIdx(idx);
  }
}

function canProbeUsageWithoutRefresh(acct) {
  if (!acct?.tokens?.access_token || isTokenExpired(acct.tokens.access_token)) return false;
  if (isLeftoverAccessRejected(acct.probe)) return false;
  return true;
}

const LEFTOVER_PROBE_STALE_SECONDS = 600;

function needsBanProbe(acct, now = ts()) {
  if (!acct?.requires_reauth && !acct?.banned) return false;
  if (!canProbeUsageWithoutRefresh(acct)) return false;
  if (acct.quota_next_retry_at && Number(acct.quota_next_retry_at) > now) return false;
  const status = acct.probe?.status;
  if (status === "active" || status === "banned" || status === "usage_limited") {
    const checkedAt = Number(acct.probe?.checked_at || acct.usage_updated_at || 0);
    if (checkedAt && now - checkedAt <= LEFTOVER_PROBE_STALE_SECONDS) return false;
  }
  return true;
}

// 只用还没过期的访问令牌打 usage，绝不去刷刷新令牌。
// 用来把「需重新授权」和「已封号」分开。
async function probeUsageOnly(acct, options = {}) {
  const force = options.force !== false;
  const fetchTask = options.fetchQuota || module.exports.fetchQuota;
  const now = ts();
  if (!force && acct.quota_next_retry_at && Number(acct.quota_next_retry_at) > now) {
    const retryError = new Error(`Quota refresh is waiting for retry until ${acct.quota_next_retry_at}`);
    retryError.code = "quota_retry_pending";
    throw retryError;
  }
  if (!canProbeUsageWithoutRefresh(acct)) {
    if (acct.banned) {
      const error = new Error("The target account is banned and cannot refresh quotas");
      error.code = "account_banned";
      throw error;
    }
    const error = new Error("Account requires reauthorization before quotas can be refreshed.");
    error.code = "reauthorization_required";
    throw error;
  }

  try {
    const q = await fetchTask(acct);
    applyProbeToAccount(acct, {
      status: "active",
      error_code: null,
      http_status: 200,
      message: "账号可用",
      ok: true,
    });
    acct.quota = q;
    acct.usage_updated_at = now;
    acct.quota_last_attempt_at = now;
    acct.quota_refresh_failures = 0;
    acct.quota_next_retry_at = null;
    if (!acct.requires_reauth) acct.quota_error = null;
    persistPlanType(acct, q);
    saveAcct(acct);
    return q;
  } catch (err) {
    const probe = classifyThrownError(err, "usage");
    applyProbeToAccount(acct, probe);
    acct.quota_last_attempt_at = now;
    acct.quota_refresh_failures = Number(acct.quota_refresh_failures || 0) + 1;
    acct.quota_next_retry_at = now + quotaRetryDelaySeconds(acct, err);
    if (probe.status === STATUS_BANNED) {
      acct.quota_error = {
        code: probe.error_code || extractCodeFromError(err),
        message: probe.message || err?.message || String(err),
        timestamp: ts(),
      };
    }
    saveAcct(acct);
    logWarn(`Leftover usage probe finished without a live quota: ${err?.message || err}`);
    throw err;
  }
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
    const q = await module.exports.fetchQuotaWithTokenRepair(acct);
    applyProbeToAccount(acct, {
      status: "active",
      error_code: null,
      http_status: 200,
      message: "账号可用",
      ok: true,
    });
    acct.quota = q;
    acct.quota_error = null;
    acct.usage_updated_at = now;
    acct.quota_last_attempt_at = now;
    acct.quota_refresh_failures = 0;
    acct.quota_next_retry_at = null;
    persistPlanType(acct, q);
    saveAcct(acct);
    return q;
  } catch (err) {
    const probe = classifyThrownError(err, "usage");
    const wasBanned = !!acct.banned;
    applyProbeToAccount(acct, probe);
    acct.quota_last_attempt_at = now;
    acct.quota_refresh_failures = Number(acct.quota_refresh_failures || 0) + 1;
    acct.quota_next_retry_at = now + quotaRetryDelaySeconds(acct, err);
    // The missing_refresh_token code is the self-heal marker checked by
    // refreshOneTok; never let a generic quota failure overwrite it.
    const selfHealCode = acct.quota_error?.code === "missing_refresh_token" ? "missing_refresh_token" : null;
    const keepBannedCode = wasBanned && probe.status !== STATUS_BANNED && acct.quota_error?.code;
    acct.quota_error = {
      code: keepBannedCode || probe.error_code || extractCodeFromError(err) || selfHealCode,
      message: probe.status === STATUS_PROBE_FAILED
        ? (err?.message || probe.message)
        : (probe.message || err?.message || String(err)),
      timestamp: ts(),
    };
    saveAcct(acct);
    logWarn(`Quota refresh failed and was scheduled for retry: ${err?.message || err}`);
    throw err;
  }
}

// Re-derives window classification for quota records saved before windows
// were classified by duration (the weekly window used to land in the hourly
// slot once upstream moved it into primary_window).
function normalizeQuota(quota) {
  if (!quota || typeof quota !== "object") return quota;
  if (!quota.raw_data || !quota.raw_data.rate_limit) return quota;
  const reparsed = parseQuotaPayload(quota.raw_data);

  // parseQuotaPayload derives relative reset times from "now", which is wrong
  // for a cached payload. Carry over the reset times computed at fetch time,
  // matching windows across slots by their duration.
  const originalSlots = [
    { minutes: quota.hourly_window_minutes, reset: quota.hourly_reset_time, present: quota.hourly_window_present },
    { minutes: quota.weekly_window_minutes, reset: quota.weekly_reset_time, present: quota.weekly_window_present },
  ].filter((slot) => slot.present && slot.reset != null);
  const carriedReset = (minutes) => originalSlots.find((slot) => slot.minutes === minutes)?.reset;
  if (reparsed.hourly_window_present) {
    const carried = carriedReset(reparsed.hourly_window_minutes);
    if (carried != null) reparsed.hourly_reset_time = carried;
  }
  if (reparsed.weekly_window_present) {
    const carried = carriedReset(reparsed.weekly_window_minutes);
    if (carried != null) reparsed.weekly_reset_time = carried;
  }
  return reparsed;
}

// 自动切号指标提取
function extractQuotaMetrics(acct) {
  const q = normalizeQuota(acct.quota);
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

module.exports = {
  fetchQuota,
  fetchQuotaWithTokenRepair,
  isQuotaAuthError,
  refreshQuota,
  probeUsageOnly,
  canProbeUsageWithoutRefresh,
  needsBanProbe,
  extractQuotaMetrics,
  quotaRetryDelaySeconds,
  parseQuotaPayload,
  normalizeQuota,
};

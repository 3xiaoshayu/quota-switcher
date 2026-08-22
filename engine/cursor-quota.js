const { CURSOR_USAGE_URL } = require("./config");
const { ts, extractCursorWorkosUserId, isTokenExpired } = require("./crypto-utils");
const { extractErrorCode } = require("./http-client");
const { getCursorRuntime } = require("./cursor-runtime");
const { saveCursorAcct, upsertCursorIndex } = require("./cursor-storage");
const { refreshCursorToken, markCursorReauth } = require("./cursor-token");
const { clearQuotaRetry, scheduleQuotaRetry, throwIfQuotaRetryPending } = require("./quota-retry");
const { logWarn } = require("./logger");

function clampPercent(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function pickNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function remainingFromUsed(used) {
  const clamped = clampPercent(used);
  return clamped == null ? null : clampPercent(100 - clamped);
}

function usedFromLimit(used, limit) {
  if (used == null || limit == null || !Number.isFinite(Number(limit)) || Number(limit) <= 0) return null;
  return (Number(used) / Number(limit)) * 100;
}

function parseCursorUsage(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const individual = root.individualUsage || root.individual_usage || {};
  const plan = individual.plan || root.plan || {};
  const usedTotal = pickNumber(
    plan.totalPercentUsed,
    plan.total_percent_used,
    usedFromLimit(plan.used, plan.limit),
  );
  const usedAuto = pickNumber(plan.autoPercentUsed, plan.auto_percent_used);
  const usedApi = pickNumber(plan.apiPercentUsed, plan.api_percent_used);
  return {
    plan_used_percentage: clampPercent(usedTotal),
    auto_used_percentage: clampPercent(usedAuto),
    api_used_percentage: clampPercent(usedApi),
    plan_remaining_percentage: remainingFromUsed(usedTotal),
    auto_remaining_percentage: remainingFromUsed(usedAuto),
    api_remaining_percentage: remainingFromUsed(usedApi),
    membership_type: root.membershipType || root.membership_type || plan.membershipType || null,
    billing_cycle_end: root.billingCycleEnd || root.billing_cycle_end || null,
    is_unlimited: root.isUnlimited === true || root.is_unlimited === true,
  };
}

function resolveCursorWorkosUserId(account) {
  const fromJwt = extractCursorWorkosUserId(account?.tokens?.access_token);
  if (fromJwt) return fromJwt;
  const stored = String(account?.auth_id || account?.tokens?.auth_id || "").trim();
  return stored.startsWith("user_") ? stored : null;
}

function buildCursorUsageCookie(account) {
  const accessToken = account?.tokens?.access_token;
  if (!accessToken) return null;
  const workosId = resolveCursorWorkosUserId(account);
  if (!workosId) return null;
  return `WorkosCursorSessionToken=${encodeURIComponent(`${workosId}::${accessToken}`)}`;
}

function cursorQuotaHasWindows(quota) {
  if (!quota) return false;
  if (quota.is_unlimited === true) return true;
  return [
    quota.plan_remaining_percentage,
    quota.auto_remaining_percentage,
    quota.api_remaining_percentage,
  ].some((value) => value != null);
}

function usageLimited(quota) {
  if (!quota) return false;
  return quota.plan_remaining_percentage === 0;
}

async function fetchCursorUsage(account) {
  const cookie = buildCursorUsageCookie(account);
  if (!cookie) {
    const error = new Error("Cursor session cookie could not be built");
    error.code = "cursor_session_missing";
    throw error;
  }
  const runtime = getCursorRuntime();
  return runtime.httpJson(CURSOR_USAGE_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Cookie: cookie,
    },
  });
}

async function refreshCursorQuota(account, options = {}) {
  const force = options.force !== false;
  const now = ts();
  throwIfQuotaRetryPending(account, force, now);
  if (account.tokens?.refresh_token) {
    let refreshed;
    try {
      refreshed = await refreshCursorToken(account, { force: false });
    } catch (error) {
      account.quota_error = {
        code: error.code || "probe_failed",
        message: error.message || String(error),
        timestamp: ts(),
      };
      account.banned = false;
      scheduleQuotaRetry(account, error, now);
      saveCursorAcct(account);
      upsertCursorIndex(account);
      if (force) throw error;
      return account.quota;
    }
    if (refreshed.account) account = refreshed.account;
    const accessUsable = !!(account.tokens?.access_token && !isTokenExpired(account.tokens.access_token));
    if (!refreshed.ok && refreshed.reauthRequired && !accessUsable) {
      account.quota_error = { code: "reauthorization_required", message: refreshed.error, timestamp: ts() };
      saveCursorAcct(account);
      upsertCursorIndex(account);
      return account.quota;
    }
    if (!refreshed.ok && !accessUsable) {
      const tokenError = new Error(refreshed.error || "Token refresh failed");
      tokenError.code = "probe_failed";
      account.quota_error = { code: "probe_failed", message: tokenError.message, timestamp: ts() };
      account.banned = false;
      scheduleQuotaRetry(account, tokenError, now);
      saveCursorAcct(account);
      upsertCursorIndex(account);
      if (force) throw tokenError;
      return account.quota;
    }
  }

  if (!buildCursorUsageCookie(account)) {
    account.quota_error = {
      code: "cursor_session_missing",
      message: "这次没查清额度，请稍后重试。",
      timestamp: ts(),
    };
    account.probe = {
      status: "probe_failed",
      error_code: "cursor_session_missing",
      http_status: null,
      checked_at: ts(),
    };
    account.banned = false;
    const sessionError = new Error("这次没查清额度，请稍后重试。");
    sessionError.code = "cursor_session_missing";
    scheduleQuotaRetry(account, sessionError, now);
    saveCursorAcct(account);
    upsertCursorIndex(account);
    if (force) throw sessionError;
    return account.quota;
  }

  try {
    const response = await fetchCursorUsage(account);
    if (response.status === 401 || response.status === 403) {
      markCursorReauth(account, "Cursor 会话已过期或未认证，请重新授权");
      const authError = new Error("Cursor 会话已过期或未认证，请重新授权");
      authError.code = "reauthorization_required";
      authError.httpStatus = response.status;
      account.quota_error = { code: "reauthorization_required", message: authError.message, timestamp: ts() };
      scheduleQuotaRetry(account, authError, now);
      saveCursorAcct(account);
      upsertCursorIndex(account);
      return account.quota;
    }
    if (response.status < 200 || response.status >= 300) {
      const code = extractErrorCode(response.body) || `HTTP ${response.status}`;
      throw Object.assign(new Error(`Cursor usage request failed: ${code}`), {
        code,
        httpStatus: response.status,
        headers: response.headers || {},
        retryAfter: response.headers?.["retry-after"] || response.headers?.["Retry-After"],
      });
    }
    let payload = {};
    try {
      payload = JSON.parse(response.body || "{}");
    } catch {
      throw Object.assign(new Error("Cursor usage response was not JSON"), { code: "invalid_usage_json" });
    }
    const quota = parseCursorUsage(payload);
    if (!cursorQuotaHasWindows(quota)) {
      throw Object.assign(new Error("这次没查清额度，请稍后重试。"), { code: "probe_failed" });
    }
    account.quota = quota;
    account.quota_error = null;
    clearQuotaRetry(account);
    account.usage_updated_at = ts();
    account.banned = false;
    account.probe = {
      status: usageLimited(quota) ? "usage_limited" : "active",
      error_code: usageLimited(quota) ? "usage_limit_reached" : null,
      http_status: response.status,
      checked_at: ts(),
    };
    if (quota.membership_type) account.plan_type = quota.membership_type;
    saveCursorAcct(account);
    upsertCursorIndex(account);
    return quota;
  } catch (error) {
    account.quota_error = {
      code: error.code || "probe_failed",
      message: error.message || String(error),
      timestamp: ts(),
    };
    account.probe = {
      status: "probe_failed",
      error_code: error.code || "probe_failed",
      http_status: error.httpStatus || null,
      checked_at: ts(),
    };
    account.banned = false;
    scheduleQuotaRetry(account, error, now);
    saveCursorAcct(account);
    upsertCursorIndex(account);
    logWarn(`Cursor quota refresh failed for ${account.email}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`);
    if (force) throw error;
    return account.quota;
  }
}

module.exports = {
  parseCursorUsage,
  buildCursorUsageCookie,
  refreshCursorQuota,
};

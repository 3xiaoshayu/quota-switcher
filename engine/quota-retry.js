const { ts } = require("./crypto-utils");

const MIN_RETRY_AFTER_SECONDS = 15;
const MAX_RETRY_AFTER_SECONDS = 30 * 60;

function headerValue(headers, name) {
  if (!headers) return null;
  const wanted = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return null;
}

function parseDurationSeconds(raw) {
  const match = String(raw || "").trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return Math.ceil((Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0));
}

function parseRetryAfterSeconds(value, nowMs = Date.now()) {
  if (value == null || value === "") return null;
  const raw = Array.isArray(value) ? String(value[0] || "").trim() : String(value).trim();
  if (!raw) return null;
  const duration = parseDurationSeconds(raw);
  if (duration != null) return duration;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const number = Number(raw);
    if (number >= 1e12) return Math.max(0, Math.ceil((number - nowMs) / 1000));
    if (number >= 1e9) return Math.max(0, Math.ceil(number - (nowMs / 1000)));
    return Math.ceil(number);
  }
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, Math.ceil((when - nowMs) / 1000));
}

function retryAfterFromError(error) {
  if (Number.isFinite(error?.retryAfterSeconds)) return Number(error.retryAfterSeconds);
  const headers = error?.headers || error?.probe?.headers;
  return parseRetryAfterSeconds(
    error?.retryAfter
    || headerValue(headers, "retry-after")
    || headerValue(headers, "x-ratelimit-reset-after")
    || headerValue(headers, "ratelimit-reset")
    || headerValue(headers, "x-ratelimit-reset-requests")
    || headerValue(headers, "x-ratelimit-reset-tokens")
    || headerValue(headers, "x-ratelimit-reset"),
  );
}

function quotaRetryDelaySeconds(acct, error) {
  const fromHeader = retryAfterFromError(error);
  if (fromHeader != null) {
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, fromHeader));
  }
  const failures = Math.max(1, Number(acct.quota_refresh_failures || 0));
  if (/\b429\b|rate.?limit/i.test(String(error?.message || error || ""))) return 15 * 60;
  return Math.min(30 * 60, 60 * (2 ** Math.min(5, failures - 1)));
}

function throwIfQuotaRetryPending(acct, force, now = ts()) {
  if (!force && acct.quota_next_retry_at && Number(acct.quota_next_retry_at) > now) {
    const retryError = new Error(`Quota refresh is waiting for retry until ${acct.quota_next_retry_at}`);
    retryError.code = "quota_retry_pending";
    throw retryError;
  }
}

function clearQuotaRetry(acct) {
  acct.quota_refresh_failures = 0;
  acct.quota_next_retry_at = null;
}

function scheduleQuotaRetry(acct, error, now = ts()) {
  acct.quota_refresh_failures = Number(acct.quota_refresh_failures || 0) + 1;
  acct.quota_next_retry_at = now + quotaRetryDelaySeconds(acct, error);
}

function tokenRetryDelaySeconds(error) {
  const fromHeader = retryAfterFromError(error);
  if (fromHeader != null) {
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, fromHeader));
  }
  if (/\b429\b|rate.?limit/i.test(String(error?.message || error || ""))) return 15 * 60;
  return 60;
}

function clearTokenRetry(acct) {
  acct.token_next_retry_at = null;
  acct.token_retry_error = null;
}

function scheduleTokenRetry(acct, error, now = ts()) {
  acct.token_next_retry_at = now + tokenRetryDelaySeconds(error);
  acct.token_retry_error = String(error?.message || error || "HTTP 429").slice(0, 200);
}

function tokenRetryPending(acct, force, now = ts()) {
  return !force && Number(acct?.token_next_retry_at || 0) > now;
}

module.exports = {
  quotaRetryDelaySeconds,
  parseRetryAfterSeconds,
  retryAfterFromError,
  throwIfQuotaRetryPending,
  clearQuotaRetry,
  scheduleQuotaRetry,
  tokenRetryDelaySeconds,
  clearTokenRetry,
  scheduleTokenRetry,
  tokenRetryPending,
};

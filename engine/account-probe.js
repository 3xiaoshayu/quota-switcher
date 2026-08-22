const { extractErrorCode } = require("./http-client");
const { ts } = require("./crypto-utils");

const STATUS_ACTIVE = "active";
const STATUS_BANNED = "banned";
const STATUS_TOKEN_INVALID = "token_invalid";
const STATUS_USAGE_LIMITED = "usage_limited";
const STATUS_PROBE_FAILED = "probe_failed";

const BANNED_CODES = new Set([
  "account_deactivated",
  "account_disabled",
  "account_deleted",
  "workspace_deactivated",
  "deactivated_workspace",
  "deactivated_user",
]);

const TOKEN_INVALID_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "invalid_refresh_token",
  "token_revoked",
  "token_invalidated",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "missing_refresh_token",
  "missing_access_token",
]);

const USAGE_LIMITED_CODES = new Set([
  "usage_limit_reached",
  "insufficient_quota",
]);

const RATE_LIMIT_CODES = new Set([
  "rate_limit",
  "rate_limit_exceeded",
]);

const BANNED_PHRASES = [
  "your openai account has been deactivated",
  "account has been deleted or deactivated",
];

const USAGE_LIMIT_PHRASES = [
  "you've hit your usage limit",
  "you have hit your usage limit",
  "usage limit has been reached",
  "usage_limit_reached",
];

const ACCESS_REJECTED_CODES = new Set([
  "invalid_token",
  "token_invalidated",
  "token_revoked",
  "invalid_grant",
]);

const MESSAGE_BY_STATUS = {
  [STATUS_ACTIVE]: "账号可用",
  [STATUS_BANNED]: "账号已封号，无法继续使用。",
  [STATUS_TOKEN_INVALID]: "刷新令牌已失效，请重新授权",
  [STATUS_USAGE_LIMITED]: "额度已达上限或触发限流。",
  [STATUS_PROBE_FAILED]: "额度同步失败，请稍后重试。",
};

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const want = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== want) continue;
    if (Array.isArray(value)) return String(value[0] || "").trim();
    return String(value || "").trim();
  }
  return "";
}

function decodeHeaderErrorJson(headers) {
  const raw = headerValue(headers, "x-error-json");
  if (!raw) return "";
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function codeFromJsonText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fromBody = extractErrorCode(raw);
  if (fromBody) return String(fromBody).toLowerCase();
  try {
    const parsed = JSON.parse(raw);
    const nested = parsed?.error;
    if (nested && typeof nested === "object" && nested.type) {
      return String(nested.type).toLowerCase();
    }
  } catch {}
  return null;
}

function codeFromHaystack(text) {
  const lower = String(text || "").toLowerCase();
  for (const code of BANNED_CODES) {
    if (lower.includes(code)) return code;
  }
  for (const code of USAGE_LIMITED_CODES) {
    if (lower.includes(code)) return code;
  }
  for (const code of TOKEN_INVALID_CODES) {
    if (lower.includes(code)) return code;
  }
  return null;
}

function phraseHit(text, phrases) {
  const lower = String(text || "").toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

function collectErrorCode(input) {
  if (input.code) return String(input.code).toLowerCase();
  const headerCode = headerValue(input.headers, "x-openai-ide-error-code");
  if (headerCode) return headerCode.toLowerCase();
  const fromBody = codeFromJsonText(input.body);
  if (fromBody) return fromBody;
  const fromHeaderJson = codeFromJsonText(decodeHeaderErrorJson(input.headers));
  if (fromHeaderJson) return fromHeaderJson;
  return codeFromHaystack(input.body);
}

function result(status, errorCode, httpStatus, message) {
  return {
    status,
    error_code: errorCode || null,
    http_status: httpStatus || 0,
    message: message || MESSAGE_BY_STATUS[status],
    ok: status === STATUS_ACTIVE,
  };
}

// 按 HTTP 状态、body、响应头给账号检查分类。
// 输入：{ source: "refresh"|"usage", httpStatus, body, headers, code }
// 输出：{ status, error_code, http_status, message, ok }
// status 只能是 active / banned / token_invalid / usage_limited / probe_failed
function classifyProbe(input) {
  const source = input?.source === "refresh" ? "refresh" : "usage";
  const httpStatus = Number(input?.httpStatus || 0);
  const code = collectErrorCode(input || {});
  const haystack = [
    input?.body,
    decodeHeaderErrorJson(input?.headers),
    code,
  ].filter(Boolean).join(" ");

  if (source === "refresh") {
    if (httpStatus === 429 || USAGE_LIMITED_CODES.has(code) || phraseHit(haystack, USAGE_LIMIT_PHRASES)) {
      return result(STATUS_PROBE_FAILED, code || "http_429", httpStatus, MESSAGE_BY_STATUS[STATUS_PROBE_FAILED]);
    }
    if (TOKEN_INVALID_CODES.has(code) || httpStatus === 400 || httpStatus === 401) {
      return result(STATUS_TOKEN_INVALID, code, httpStatus, MESSAGE_BY_STATUS[STATUS_TOKEN_INVALID]);
    }
    if (httpStatus >= 200 && httpStatus < 300) {
      return result(STATUS_ACTIVE, null, httpStatus, MESSAGE_BY_STATUS[STATUS_ACTIVE]);
    }
    return result(STATUS_PROBE_FAILED, code, httpStatus, MESSAGE_BY_STATUS[STATUS_PROBE_FAILED]);
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    const bodyText = String(input?.body || "").trim();
    if (bodyText && bodyText[0] === "<") {
      return result(STATUS_PROBE_FAILED, "unexpected_non_json", httpStatus, MESSAGE_BY_STATUS[STATUS_PROBE_FAILED]);
    }
    if (bodyText) {
      try {
        JSON.parse(bodyText);
      } catch {
        return result(STATUS_PROBE_FAILED, "unexpected_non_json", httpStatus, MESSAGE_BY_STATUS[STATUS_PROBE_FAILED]);
      }
    }
    return result(STATUS_ACTIVE, null, httpStatus, MESSAGE_BY_STATUS[STATUS_ACTIVE]);
  }

  if (BANNED_CODES.has(code) || phraseHit(haystack, BANNED_PHRASES)) {
    return result(STATUS_BANNED, code || "account_deactivated", httpStatus, MESSAGE_BY_STATUS[STATUS_BANNED]);
  }
  if (USAGE_LIMITED_CODES.has(code) || phraseHit(haystack, USAGE_LIMIT_PHRASES)) {
    return result(STATUS_USAGE_LIMITED, code || "usage_limit_reached", httpStatus, MESSAGE_BY_STATUS[STATUS_USAGE_LIMITED]);
  }
  if (httpStatus === 429 || RATE_LIMIT_CODES.has(code)) {
    return result(STATUS_PROBE_FAILED, code || "http_429", httpStatus, MESSAGE_BY_STATUS[STATUS_PROBE_FAILED]);
  }
  if (code === "missing_access_token" || code === "missing_refresh_token") {
    return result(STATUS_PROBE_FAILED, code, httpStatus, "缺少访问令牌，无法刷新额度");
  }
  return result(STATUS_PROBE_FAILED, code, httpStatus, MESSAGE_BY_STATUS[STATUS_PROBE_FAILED]);
}

function classifyThrownError(error, source) {
  if (error?.probe && error.probe.status) return error.probe;
  const message = String(error?.message || error || "");
  const statusMatch = message.match(/HTTP\s+(\d+)/i);
  return classifyProbe({
    source: source || "usage",
    httpStatus: statusMatch ? Number(statusMatch[1]) : 0,
    body: message,
    headers: error?.headers || {},
    code: error?.code || null,
  });
}

function isLeftoverAccessRejected(probe) {
  if (!probe || probe.status === STATUS_BANNED) return false;
  const httpStatus = Number(probe.http_status || 0);
  if (httpStatus !== 401 && httpStatus !== 403) return false;
  return ACCESS_REJECTED_CODES.has(String(probe.error_code || "").toLowerCase());
}

function classifyMissingToken() {
  return result(STATUS_PROBE_FAILED, "missing_access_token", 0, "缺少访问令牌，无法刷新额度");
}

function probeError(probe) {
  const error = new Error(probe.message);
  error.code = probe.error_code || probe.status;
  error.probe = probe;
  return error;
}

function isAccountBanned(account) {
  return !!account?.banned;
}

// 把一次检查结果写回账号。banned 只由 usage 停用码置位，只由 usage 成功或重新授权清掉。
function applyProbeToAccount(account, probe) {
  if (!account || !probe) return account;
  const now = ts();
  const wasBanned = !!account.banned;
  const nextProbe = {
    status: probe.status,
    error_code: probe.error_code || null,
    http_status: probe.http_status || 0,
    checked_at: now,
  };

  if (probe.status === STATUS_ACTIVE) {
    account.banned = false;
    account.probe = nextProbe;
    return account;
  }

  if (probe.status === STATUS_BANNED) {
    account.banned = true;
    account.probe = nextProbe;
    return account;
  }

  if (wasBanned) {
    account.banned = true;
    if (account.probe?.status === STATUS_BANNED) {
      account.probe.checked_at = now;
      return account;
    }
    account.probe = {
      status: STATUS_BANNED,
      error_code: account.probe?.error_code || probe.error_code || "account_deactivated",
      http_status: account.probe?.http_status || probe.http_status || 0,
      checked_at: now,
    };
    return account;
  }

  account.probe = nextProbe;
  return account;
}

function publicProbe(probe) {
  if (!probe || typeof probe !== "object") return null;
  return {
    status: probe.status || null,
    error_code: probe.error_code || null,
    http_status: probe.http_status || null,
    checked_at: probe.checked_at || null,
  };
}

module.exports = {
  STATUS_ACTIVE,
  STATUS_BANNED,
  STATUS_TOKEN_INVALID,
  STATUS_USAGE_LIMITED,
  STATUS_PROBE_FAILED,
  BANNED_CODES,
  ACCESS_REJECTED_CODES,
  classifyProbe,
  classifyThrownError,
  classifyMissingToken,
  isLeftoverAccessRejected,
  probeError,
  isAccountBanned,
  applyProbeToAccount,
  publicProbe,
};

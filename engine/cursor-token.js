const { CURSOR_TOKEN_URL, CURSOR_CLIENT_ID, CURSOR_META_URL } = require("./config");
const { ts, jwtPayload, isTokenExpired, isExpiryStale } = require("./crypto-utils");
const { extractErrorCode, isTransientNetworkError, looksLikeHtmlResponse } = require("./http-client");
const { getCursorRuntime } = require("./cursor-runtime");
const { listCursorAccts, loadCursorAcct, saveCursorAcct, upsertCursorIndex } = require("./cursor-storage");
const { withAccountLock, mapLimit } = require("./operation-locks");
const { logInfo, logWarn } = require("./logger");
const { clearTokenRetry, scheduleTokenRetry, tokenRetryPending } = require("./quota-retry");

function markCursorReauth(account, reason) {
  account.requires_reauth = true;
  account.reauth_reason = reason;
  account.banned = false;
  account.probe = {
    status: "token_invalid",
    error_code: "should_logout",
    http_status: 401,
    checked_at: ts(),
  };
  saveCursorAcct(account);
  upsertCursorIndex(account);
  return account;
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

function responseLooksLikeNonJson(body) {
  const raw = String(body || "").trim();
  if (!raw || raw[0] === "<") return true;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

async function refreshCursorToken(account, options = {}) {
  if (!account?.tokens?.refresh_token) {
    return { ok: false, skipped: true, reauthRequired: true, error: "Account has no refresh token and must be reauthorized" };
  }
  if (account.requires_reauth) {
    return {
      ok: false,
      skipped: true,
      reauthRequired: true,
      error: account.reauth_reason || "该账号需要重新授权后才能刷新令牌",
    };
  }
  const force = options.force === true;
  const observedGeneration = options.observedGeneration;
  if (
    observedGeneration != null
    && Number(account.token_generation || 0) > Number(observedGeneration)
    && account.tokens.access_token
    && !isTokenExpired(account.tokens.access_token)
  ) {
    return { ok: true, skipped: true, account };
  }
  if (!force && account.tokens.access_token && !isTokenExpired(account.tokens.access_token)) {
    return { ok: true, skipped: true, account };
  }
  if (tokenRetryPending(account, force)) {
    return { ok: false, error: account.token_retry_error || "HTTP 429" };
  }

  const runtime = getCursorRuntime();
  let response;
  try {
    response = await runtime.httpJson(CURSOR_TOKEN_URL, {
      method: "POST",
      idempotent: false,
      body: {
        grant_type: "refresh_token",
        client_id: CURSOR_CLIENT_ID,
        refresh_token: account.tokens.refresh_token,
      },
    });
  } catch (error) {
    if (isTransientNetworkError(error)) {
      scheduleTokenRetry(account, error);
      saveCursorAcct(account);
      upsertCursorIndex(account);
      return { ok: false, error: error.message || String(error) };
    }
    throw error;
  }
  const payload = parseJsonBody(response.body);
  if (response.status >= 500) {
    scheduleTokenRetry(account, { message: `HTTP ${response.status}`, headers: response.headers });
    saveCursorAcct(account);
    upsertCursorIndex(account);
    return { ok: false, error: `Token refresh failed: HTTP ${response.status}` };
  }
  if (response.status === 429) {
    scheduleTokenRetry(account, {
      message: "HTTP 429",
      retryAfter: response.headers?.["retry-after"] || response.headers?.["Retry-After"],
      headers: response.headers,
    });
    saveCursorAcct(account);
    upsertCursorIndex(account);
    return { ok: false, error: "HTTP 429" };
  }
  if ((response.status === 401 || response.status === 403) && looksLikeHtmlResponse(response.body, response.headers)) {
    scheduleTokenRetry(account, { message: `HTTP ${response.status}`, headers: response.headers });
    saveCursorAcct(account);
    upsertCursorIndex(account);
    return { ok: false, error: `Token refresh failed: HTTP ${response.status}` };
  }
  if (response.status === 401 || response.status === 403 || payload.shouldLogout === true) {
    markCursorReauth(account, "Cursor refresh token 已失效，请重新授权");
    return {
      ok: false,
      skipped: true,
      reauthRequired: true,
      error: "Cursor refresh token 已失效，请重新授权",
    };
  }
  const accessToken = String(payload.accessToken || "").trim();
  if (response.status < 400 && !accessToken && responseLooksLikeNonJson(response.body)) {
    scheduleTokenRetry(account, { message: "响应不是 JSON" });
    saveCursorAcct(account);
    upsertCursorIndex(account);
    return { ok: false, error: "响应不是 JSON" };
  }
  if (response.status >= 200 && response.status < 300 && !accessToken) {
    scheduleTokenRetry(account, { message: "响应无 access_token" });
    saveCursorAcct(account);
    upsertCursorIndex(account);
    return { ok: false, error: "响应无 access_token" };
  }
  if (response.status < 200 || response.status >= 300 || !accessToken) {
    const code = extractErrorCode(response.body) || `HTTP ${response.status}`;
    logWarn(`Cursor token refresh failed: ${code}`);
    return { ok: false, error: `Token refresh failed: ${code}` };
  }

  account.tokens.access_token = accessToken;
  const nextRefresh = String(payload.refreshToken || "").trim();
  if (nextRefresh) account.tokens.refresh_token = nextRefresh;
  account.token_generation = (account.token_generation || 0) + 1;
  account.token_updated_at = ts();
  account.requires_reauth = false;
  account.reauth_reason = null;
  account.banned = false;
  account.quota_error = null;
  clearTokenRetry(account);
  saveCursorAcct(account);
  upsertCursorIndex(account);
  logInfo(`Refreshed Cursor token for ${account.email}`);
  return { ok: true, account };
}

async function fetchCursorUserMeta(account) {
  const runtime = getCursorRuntime();
  const response = await runtime.httpJson(CURSOR_META_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.tokens.access_token}`,
      Accept: "application/json",
    },
    body: {},
  });
  if (response.status < 200 || response.status >= 300) return null;
  const payload = parseJsonBody(response.body);
  const email = String(payload.email || "").trim();
  if (email && email.includes("@") && email !== account.email) {
    account.email = email;
  }
  const workosId = String(payload.workosId || "").trim();
  if (workosId.startsWith("user_")) {
    account.auth_id = workosId;
    if (account.tokens) account.tokens.auth_id = workosId;
  }
  return payload;
}

async function refreshAllCursorTokens(force = false) {
  const listedAccounts = listCursorAccts({ secrets: false });
  const results = await mapLimit(listedAccounts, 5, async (listed) => {
    return withAccountLock(listed.id, async () => {
      if (listed.requires_reauth) {
        return {
          email: listed.email,
          ok: false,
          skipped: true,
          reauthRequired: true,
        };
      }
      if (listed.has_refresh === false) {
        return {
          email: listed.email,
          ok: false,
          skipped: true,
          reauthRequired: true,
        };
      }
      if (!force && !isExpiryStale(listed.token_exp)) {
        return {
          email: listed.email,
          ok: true,
          skipped: true,
        };
      }
      const account = loadCursorAcct(listed.id) || listed;
      if (!account?.tokens?.refresh_token) {
        return {
          email: account.email,
          ok: false,
          skipped: true,
          reauthRequired: true,
        };
      }
      let result;
      try {
        result = await refreshCursorToken(account, {
          force: !!force,
          observedGeneration: listed.token_generation,
        });
      } catch (error) {
        return {
          email: account.email,
          ok: false,
          skipped: false,
          error: error.message || String(error),
          reauthRequired: false,
        };
      }
      return {
        email: account.email,
        ok: !!result.ok,
        skipped: !!result.skipped,
        error: result.error,
        reauthRequired: !!result.reauthRequired || (!result.ok && (!!result.skipped || /重新授权|refresh token/i.test(String(result.error || "")))),
      };
    });
  });
  return { results };
}

function emailFromCursorToken(accessToken) {
  const payload = jwtPayload(accessToken);
  const email = String(payload?.email || "").trim();
  return email.includes("@") ? email : "";
}

module.exports = {
  markCursorReauth,
  refreshCursorToken,
  refreshAllCursorTokens,
  fetchCursorUserMeta,
  emailFromCursorToken,
};

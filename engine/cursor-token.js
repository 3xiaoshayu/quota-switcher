const { CURSOR_TOKEN_URL, CURSOR_CLIENT_ID, CURSOR_META_URL } = require("./config");
const { ts, jwtPayload, isTokenExpired } = require("./crypto-utils");
const { extractErrorCode } = require("./http-client");
const { getCursorRuntime } = require("./cursor-runtime");
const { listCursorAccts, loadCursorAcct, saveCursorAcct, upsertCursorIndex } = require("./cursor-storage");
const { withAccountLock, mapLimit } = require("./operation-locks");
const { logInfo, logWarn } = require("./logger");

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

  const runtime = getCursorRuntime();
  const response = await runtime.httpJson(CURSOR_TOKEN_URL, {
    method: "POST",
    idempotent: false,
    body: {
      grant_type: "refresh_token",
      client_id: CURSOR_CLIENT_ID,
      refresh_token: account.tokens.refresh_token,
    },
  });
  const payload = parseJsonBody(response.body);
  if (response.status === 401 || response.status === 403 || payload.shouldLogout === true) {
    markCursorReauth(account, "Cursor refresh token 已失效，请重新授权");
    return {
      ok: false,
      skipped: true,
      reauthRequired: true,
      error: "Cursor refresh token 已失效，请重新授权",
    };
  }
  if (response.status < 200 || response.status >= 300 || !payload.accessToken) {
    const code = extractErrorCode(response.body) || `HTTP ${response.status}`;
    logWarn(`Cursor token refresh failed: ${code}`);
    return { ok: false, error: `Token refresh failed: ${code}` };
  }

  account.tokens.access_token = payload.accessToken;
  if (payload.refreshToken) account.tokens.refresh_token = payload.refreshToken;
  account.token_generation = (account.token_generation || 0) + 1;
  account.token_updated_at = ts();
  account.requires_reauth = false;
  account.reauth_reason = null;
  account.banned = false;
  account.quota_error = null;
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
  const listedAccounts = listCursorAccts();
  const results = await mapLimit(listedAccounts, 5, async (listed) => {
    return withAccountLock(listed.id, async () => {
      const account = loadCursorAcct(listed.id) || listed;
      if (account.requires_reauth) {
        return {
          email: account.email,
          ok: false,
          skipped: true,
          reauthRequired: true,
        };
      }
      if (!account?.tokens?.refresh_token) {
        return {
          email: account.email,
          ok: false,
          skipped: true,
          reauthRequired: true,
        };
      }
      const result = await refreshCursorToken(account, {
        force: !!force,
        observedGeneration: listed.token_generation,
      });
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

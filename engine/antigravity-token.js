const { ANTIGRAVITY_TOKEN_URL, TOKEN_SKEW_SEC } = require("./config");
const { ts, isExpiryStale } = require("./crypto-utils");
const { extractErrorCode, isTransientNetworkError, stripXssiPrefix, looksLikeHtmlResponse } = require("./http-client");
const { getAntigravityRuntime } = require("./antigravity-runtime");
const { listOfficialOauthClients } = require("./antigravity-oauth-client");
const { listAntigravityAccts, loadAntigravityAcct, saveAntigravityAcct, upsertAntigravityIndex } = require("./antigravity-storage");
const { withAccountLock, mapLimit } = require("./operation-locks");
const { logInfo, logWarn } = require("./logger");
const { clearTokenRetry, scheduleTokenRetry, tokenRetryPending } = require("./quota-retry");

function parseJsonBody(body) {
  try {
    return JSON.parse(stripXssiPrefix(body) || "{}");
  } catch {
    return {};
  }
}

function responseLooksLikeNonJson(body) {
  const raw = stripXssiPrefix(body).trim();
  if (!raw || raw[0] === "<") return true;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

function formBody(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function accessExpiry(account) {
  const stored = Number(account?.tokens?.expiry_timestamp || 0);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return 0;
}

function antigravityAccessExpired(account) {
  const expiry = accessExpiry(account);
  if (!expiry) return !account?.tokens?.access_token;
  return expiry < ts() + TOKEN_SKEW_SEC;
}

function markAntigravityReauth(account, reason) {
  account.requires_reauth = true;
  account.reauth_reason = reason;
  account.banned = false;
  account.probe = {
    status: "token_invalid",
    error_code: "should_logout",
    http_status: 401,
    checked_at: ts(),
  };
  saveAntigravityAcct(account);
  upsertAntigravityIndex(account);
  return account;
}

function isInvalidClientResponse(response, payload) {
  return /invalid_client/i.test(String(payload?.error || payload?.error_description || response?.body || ""));
}

function clientsForGoogleTokenExchange(runtime) {
  if (typeof runtime.oauthClient === "function") {
    const client = runtime.oauthClient();
    return client?.clientId ? [client] : [];
  }
  const exePath = typeof runtime.exePath === "function" ? runtime.exePath() : undefined;
  return listOfficialOauthClients(exePath);
}

async function postGoogleToken(runtime, client, fields) {
  const response = await runtime.httpJson(ANTIGRAVITY_TOKEN_URL, {
    method: "POST",
    idempotent: false,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formBody({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      ...fields,
    }),
  });
  return { response, payload: parseJsonBody(response.body), client };
}

async function exchangeGoogleToken(fields) {
  const runtime = getAntigravityRuntime();
  const clients = clientsForGoogleTokenExchange(runtime);
  if (!clients.length) {
    const error = new Error("Could not read the official Antigravity OAuth client");
    error.code = "antigravity_oauth_client_missing";
    throw error;
  }
  const queue = fields.grant_type === "refresh_token" ? clients : [clients[0]];
  let last = null;
  for (let index = 0; index < queue.length; index += 1) {
    last = await postGoogleToken(runtime, queue[index], fields);
    const ok = last.response.status >= 200 && last.response.status < 300 && last.payload.access_token;
    if (ok) return last;
    if (index + 1 < queue.length && isInvalidClientResponse(last.response, last.payload)) {
      logWarn("Antigravity token refresh got invalid_client; retrying with the published official client");
      continue;
    }
    return last;
  }
  return last;
}

async function refreshAntigravityToken(account, options = {}) {
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
    && !antigravityAccessExpired(account)
  ) {
    return { ok: true, skipped: true, account };
  }
  if (!force && account.tokens.access_token && !antigravityAccessExpired(account)) {
    return { ok: true, skipped: true, account };
  }
  if (tokenRetryPending(account, force)) {
    return { ok: false, error: account.token_retry_error || "HTTP 429" };
  }

  let response;
  let payload;
  try {
    ({ response, payload } = await exchangeGoogleToken({
      grant_type: "refresh_token",
      refresh_token: account.tokens.refresh_token,
    }));
  } catch (error) {
    if (isTransientNetworkError(error)) {
      scheduleTokenRetry(account, error);
      saveAntigravityAcct(account);
      upsertAntigravityIndex(account);
      return { ok: false, error: error.message || String(error) };
    }
    throw error;
  }
  if (response.status >= 500) {
    scheduleTokenRetry(account, { message: `HTTP ${response.status}`, headers: response.headers });
    saveAntigravityAcct(account);
    upsertAntigravityIndex(account);
    return { ok: false, error: `Token refresh failed: HTTP ${response.status}` };
  }
  if (response.status === 429) {
    scheduleTokenRetry(account, {
      message: "HTTP 429",
      retryAfter: response.headers?.["retry-after"] || response.headers?.["Retry-After"],
      headers: response.headers,
    });
    saveAntigravityAcct(account);
    upsertAntigravityIndex(account);
    return { ok: false, error: "HTTP 429" };
  }
  if ((response.status === 401 || response.status === 403) && looksLikeHtmlResponse(response.body, response.headers)) {
    scheduleTokenRetry(account, { message: `HTTP ${response.status}`, headers: response.headers });
    saveAntigravityAcct(account);
    upsertAntigravityIndex(account);
    return { ok: false, error: `Token refresh failed: HTTP ${response.status}` };
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    const invalid = /invalid_grant|invalid_client|unauthorized/i.test(String(payload.error || payload.error_description || response.body || ""));
    if (invalid || response.status === 401 || response.status === 403) {
      markAntigravityReauth(account, "Google 登录已失效，请重新授权");
      return {
        ok: false,
        skipped: true,
        reauthRequired: true,
        error: "Google 登录已失效，请重新授权",
      };
    }
  }
  const accessToken = String(payload.access_token || "").trim();
  if (response.status < 400 && !accessToken && responseLooksLikeNonJson(response.body)) {
    scheduleTokenRetry(account, { message: "响应不是 JSON" });
    saveAntigravityAcct(account);
    upsertAntigravityIndex(account);
    return { ok: false, error: "响应不是 JSON" };
  }
  if (response.status >= 200 && response.status < 300 && !accessToken) {
    const invalid = /invalid_grant|invalid_client|unauthorized/i.test(String(payload.error || payload.error_description || response.body || ""));
    if (invalid) {
      markAntigravityReauth(account, "Google 登录已失效，请重新授权");
      return {
        ok: false,
        skipped: true,
        reauthRequired: true,
        error: "Google 登录已失效，请重新授权",
      };
    }
    scheduleTokenRetry(account, { message: "响应无 access_token" });
    saveAntigravityAcct(account);
    upsertAntigravityIndex(account);
    return { ok: false, error: "响应无 access_token" };
  }
  if (response.status < 200 || response.status >= 300 || !accessToken) {
    const code = extractErrorCode(response.body) || payload.error || `HTTP ${response.status}`;
    logWarn(`Antigravity token refresh failed: ${code}`);
    return { ok: false, error: `Token refresh failed: ${code}` };
  }

  account.tokens.access_token = accessToken;
  const nextRefresh = String(payload.refresh_token || "").trim();
  if (nextRefresh) account.tokens.refresh_token = nextRefresh;
  const expiresIn = Number(payload.expires_in || 0);
  account.tokens.expiry_timestamp = expiresIn > 0 ? ts() + Math.floor(expiresIn) : account.tokens.expiry_timestamp || 0;
  account.tokens.token_type = payload.token_type || account.tokens.token_type || "Bearer";
  account.token_generation = (account.token_generation || 0) + 1;
  account.token_updated_at = ts();
  account.requires_reauth = false;
  account.reauth_reason = null;
  account.banned = false;
  account.quota_error = null;
  clearTokenRetry(account);
  saveAntigravityAcct(account);
  upsertAntigravityIndex(account);
  logInfo(`Refreshed Antigravity token for ${account.email}`);
  return { ok: true, account };
}

async function fetchGoogleUserInfo(accessToken) {
  const runtime = getAntigravityRuntime();
  const response = await runtime.httpJson("https://www.googleapis.com/oauth2/v2/userinfo", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (response.status < 200 || response.status >= 300) return null;
  return parseJsonBody(response.body);
}

async function refreshAllAntigravityTokens(force = false) {
  const listedAccounts = listAntigravityAccts({ secrets: false });
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
      const account = loadAntigravityAcct(listed.id) || listed;
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
        result = await refreshAntigravityToken(account, {
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
        reauthRequired: !!result.reauthRequired || (!result.ok && (!!result.skipped || /重新授权|refresh token|Google/i.test(String(result.error || "")))),
      };
    });
  });
  return { results };
}

module.exports = {
  markAntigravityReauth,
  refreshAntigravityToken,
  refreshAllAntigravityTokens,
  fetchGoogleUserInfo,
  exchangeGoogleToken,
  antigravityAccessExpired,
  formBody,
};

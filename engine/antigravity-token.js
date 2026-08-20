const { ANTIGRAVITY_TOKEN_URL, TOKEN_SKEW_SEC } = require("./config");
const { ts } = require("./crypto-utils");
const { extractErrorCode } = require("./http-client");
const { getAntigravityRuntime } = require("./antigravity-runtime");
const { readOfficialOauthClient } = require("./antigravity-oauth-client");
const { listAntigravityAccts, loadAntigravityAcct, saveAntigravityAcct, upsertAntigravityIndex } = require("./antigravity-storage");
const { withAccountLock, mapLimit } = require("./operation-locks");
const { logInfo, logWarn } = require("./logger");

function parseJsonBody(body) {
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
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

async function exchangeGoogleToken(fields) {
  const runtime = getAntigravityRuntime();
  const client = typeof runtime.oauthClient === "function"
    ? runtime.oauthClient()
    : readOfficialOauthClient(typeof runtime.exePath === "function" ? runtime.exePath() : undefined);
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
  const payload = parseJsonBody(response.body);
  return { response, payload, client };
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

  const { response, payload } = await exchangeGoogleToken({
    grant_type: "refresh_token",
    refresh_token: account.tokens.refresh_token,
  });
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
  if (response.status < 200 || response.status >= 300 || !payload.access_token) {
    const code = extractErrorCode(response.body) || payload.error || `HTTP ${response.status}`;
    logWarn(`Antigravity token refresh failed: ${code}`);
    return { ok: false, error: `Token refresh failed: ${code}` };
  }

  account.tokens.access_token = payload.access_token;
  if (payload.refresh_token) account.tokens.refresh_token = payload.refresh_token;
  const expiresIn = Number(payload.expires_in || 0);
  account.tokens.expiry_timestamp = expiresIn > 0 ? ts() + Math.floor(expiresIn) : account.tokens.expiry_timestamp || 0;
  account.tokens.token_type = payload.token_type || account.tokens.token_type || "Bearer";
  account.token_generation = (account.token_generation || 0) + 1;
  account.token_updated_at = ts();
  account.requires_reauth = false;
  account.reauth_reason = null;
  account.banned = false;
  account.quota_error = null;
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
      const account = loadAntigravityAcct(listed.id) || listed;
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
      const result = await refreshAntigravityToken(account, {
        force: !!force,
        observedGeneration: listed.token_generation,
      });
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

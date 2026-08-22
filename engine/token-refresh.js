const { TOKEN_URL, CLIENT_ID } = require("./config");
const { ts, isTokenExpired, isExpiryStale, jwtExp } = require("./crypto-utils");
const { httpJson, extractErrorCode, isTransientNetworkError } = require("./http-client");
const { saveAcct, loadAcct, listAccts, loadIdx } = require("./storage");
const { writeAuthJson, writeProjection } = require("./switch");
const { withAccountLock, mapLimit } = require("./operation-locks");
const { clearTokenRetry, scheduleTokenRetry, tokenRetryPending } = require("./quota-retry");

const REAUTH_ERROR_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "invalid_refresh_token",
  "token_revoked",
  "token_invalidated",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

// Some upstream failures carry only a human-readable message instead of a code.
const REAUTH_ERROR_TEXT = [
  "invalid refresh token",
  "invalid_refresh_token",
  "authentication token has been invalidated",
];

function isReauthErrorText(detail) {
  const lower = String(detail || "").toLowerCase();
  return REAUTH_ERROR_TEXT.some((text) => lower.includes(text));
}

function tokenRefreshError(status, code) {
  if (code === "unsupported_country_region_territory") {
    return "当前网络出口被 OpenAI 判定为不支持的地区，请确认应用已走可用代理后重试";
  }
  return "HTTP " + status + (code ? " " + code : "");
}

function tokenTimeLeft(acct) {
  const exp = acct.tokens?.access_token ? jwtExp(acct.tokens.access_token) : null;
  return exp ? exp - ts() : null;
}

function hasTokenRepairSignal(acct) {
  if (acct.requires_reauth) return true;
  const code = String(acct.quota_error?.code || "").toLowerCase();
  const message = String(acct.quota_error?.message || "").toLowerCase();
  return [
    "invalid_grant",
    "invalid_token",
    "invalid_refresh_token",
    "token_revoked",
    "token_invalidated",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ].some((item) => code === item || message.includes(item));
}

function isReauthErrorCode(code) {
  return REAUTH_ERROR_CODES.has(String(code || "").toLowerCase());
}

function reauthRequiredError(code) {
  if (code === "missing_refresh_token") return "Account has no refresh token and must be reauthorized.";
  return "Account requires reauthorization before tokens can be refreshed.";
}

function markRequiresReauth(acct, code, detail) {
  const errorCode = code || "token_refresh_failed";
  acct.quota_error = {
    code: errorCode,
    message: reauthRequiredError(errorCode),
    // Keep the upstream response snippet for diagnostics; it stays in the
    // local record and is not exposed over IPC.
    detail: detail ? String(detail).slice(0, 300) : null,
    timestamp: ts(),
  };
  acct.requires_reauth = true;
  acct.reauth_reason = "refresh_token needs re-authorization";
  saveAcct(acct);
}

function syncCurrentAuthIfNeeded(acct) {
  const idx = loadIdx();
  if (idx.current_account_id !== acct.id) return;
  const { inspectAuthState, canMirrorOfficialAuth, isInspectBusyError } = require("./auth-state");
  let authState;
  try {
    authState = inspectAuthState({ migrateProjection: false });
  } catch (error) {
    if (isInspectBusyError(error)) return;
    throw error;
  }
  if (!canMirrorOfficialAuth(authState) || authState.currentAccountId !== acct.id) return;
  const authValue = writeAuthJson(acct);
  writeProjection(acct, authValue);
}

async function refreshOneTok(acct, options = {}) {
  const optionBag = typeof options === "boolean" ? { force: options } : (options || {});
  const force = !!optionBag.force;
  const request = optionBag.httpJson || httpJson;
  if (acct.requires_reauth) {
    // Self-heal: an account flagged only for a missing refresh token becomes
    // usable again once a refresh token is available (e.g. synced from the
    // official auth.json).
    if (acct.quota_error?.code === "missing_refresh_token" && acct.tokens?.refresh_token) {
      acct.requires_reauth = false;
      acct.reauth_reason = null;
      acct.quota_error = null;
      saveAcct(acct);
    } else {
      const code = acct.quota_error?.code || "reauthorization_required";
      return { ok: false, skipped: true, revoked: true, reauthRequired: true, code, error: reauthRequiredError(code) };
    }
  }
  const observedGeneration = optionBag.observedGeneration;
  if (
    observedGeneration != null
    && Number(acct.token_generation || 0) > Number(observedGeneration)
    && acct.tokens?.access_token
    && !isTokenExpired(acct.tokens.access_token)
  ) {
    return { ok: true, skipped: true, gen: acct.token_generation || 0, timeLeft: tokenTimeLeft(acct) };
  }
  if (!force && !needsRefresh(acct) && !hasTokenRepairSignal(acct)) {
    return { ok: true, skipped: true, gen: acct.token_generation || 0, timeLeft: tokenTimeLeft(acct) };
  }
  if (!acct.tokens.refresh_token) {
    markRequiresReauth(acct, "missing_refresh_token", "This account has no refresh token.");
    return { ok: false, error: "缺少 refresh_token", revoked: true, reauthRequired: true, code: "missing_refresh_token" };
  }
  if (tokenRetryPending(acct, force)) {
    return { ok: false, error: acct.token_retry_error || "HTTP 429", revoked: false };
  }
  // OAuth 2.0 token endpoints expect form encoding (RFC 6749); this also
  // matches the current official Codex client behavior.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: acct.tokens.refresh_token,
    client_id: CLIENT_ID,
  }).toString();
  try {
    const resp = await request(TOKEN_URL, {
      method: "POST", body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      idempotent: false,
    });
    if (resp.status === 429) {
      const code = extractErrorCode(resp.body);
      scheduleTokenRetry(acct, {
        message: tokenRefreshError(429, code),
        retryAfter: resp.headers?.["retry-after"] || resp.headers?.["Retry-After"],
        headers: resp.headers,
      });
      saveAcct(acct);
      return {
        ok: false,
        error: tokenRefreshError(429, code),
        revoked: false,
        code: code || "http_429",
      };
    }
    if (resp.status >= 500) {
      const code = extractErrorCode(resp.body);
      scheduleTokenRetry(acct, { message: tokenRefreshError(resp.status, code), headers: resp.headers });
      saveAcct(acct);
      return {
        ok: false,
        error: tokenRefreshError(resp.status, code),
        revoked: false,
        code: code || `http_${resp.status}`,
      };
    }
    if (resp.status >= 400) {
      const code = extractErrorCode(resp.body);
      const revoked = isReauthErrorCode(code) || isReauthErrorText(resp.body);
      if (revoked) markRequiresReauth(acct, code, resp.body.slice(0, 300));
      return {
        ok: false,
        skipped: revoked,
        reauthRequired: revoked,
        error: tokenRefreshError(resp.status, code),
        revoked,
        code,
        detail: resp.body.slice(0, 300),
      };
    }
    let data;
    try {
      data = JSON.parse(resp.body);
    } catch {
      scheduleTokenRetry(acct, { message: "响应不是 JSON" });
      saveAcct(acct);
      return { ok: false, error: "响应不是 JSON", revoked: false };
    }
    const idTok = data.id_token || acct.tokens.id_token;
    const accTok = String(data.access_token || "").trim();
    const refTok = String(data.refresh_token || "").trim() || acct.tokens.refresh_token;
    if (!accTok) {
      const code = extractErrorCode(resp.body);
      const revoked = isReauthErrorCode(code) || isReauthErrorText(resp.body);
      if (revoked) {
        markRequiresReauth(acct, code, resp.body.slice(0, 300));
        return {
          ok: false,
          skipped: true,
          reauthRequired: true,
          error: tokenRefreshError(resp.status, code),
          revoked: true,
          code,
          detail: resp.body.slice(0, 300),
        };
      }
      scheduleTokenRetry(acct, { message: "响应无 access_token" });
      saveAcct(acct);
      return { ok: false, error: "响应无 access_token", revoked: false };
    }

    acct.tokens = {
      id_token: String(idTok),
      access_token: String(accTok),
      refresh_token: refTok ? String(refTok) : null,
      account_id: acct.account_id || acct.tokens.account_id || null,
    };
    acct.token_generation = Number(acct.token_generation || 0) + 1;
    acct.token_updated_at = ts();
    acct.quota_error = null;
    acct.requires_reauth = false;
    acct.reauth_reason = null;
    clearTokenRetry(acct);
    saveAcct(acct);
    syncCurrentAuthIfNeeded(acct);
    return { ok: true, skipped: false, gen: acct.token_generation };
  } catch (err) {
    if (isTransientNetworkError(err)) {
      scheduleTokenRetry(acct, err);
      saveAcct(acct);
    }
    return { ok: false, error: err.message, revoked: false };
  }
}

function needsRefresh(acct) {
  if (!acct.tokens.refresh_token) return false;
  return isTokenExpired(acct.tokens.access_token);
}

function listedNeedsTokenRefresh(listed) {
  if (!listed || listed.banned || listed.has_refresh === false) return false;
  return isExpiryStale(listed.token_exp);
}

async function refreshAll(force) {
  const accts = listAccts({ secrets: false });
  if (!accts.length) return { okCount: 0, revivedCount: 0, deadCount: 0, results: [] };

  const rows = await mapLimit(accts, 5, async (listed) => {
    return withAccountLock(listed.id, async () => {
      if (listed.banned) {
        return { result: { email: listed.email, ok: false, skipped: true, banned: true } };
      }
      if (listed.requires_reauth && listed.has_refresh === false) {
        return {
          result: {
            email: listed.email,
            ok: false,
            skipped: true,
            reauthRequired: true,
          },
        };
      }
      if (!force && !hasTokenRepairSignal(listed) && !listedNeedsTokenRefresh(listed)) {
        return { kind: "ok", result: { email: listed.email, ok: true, skipped: true } };
      }
      const a = loadAcct(listed.id);
      if (!a) return null;
      if (a.banned) {
        return { result: { email: a.email, ok: false, skipped: true, banned: true } };
      }
      if (a.requires_reauth && !hasTokenRepairSignal(a) && !a.tokens?.refresh_token) {
        return {
          result: {
            email: a.email,
            ok: false,
            skipped: true,
            reauthRequired: true,
          },
        };
      }
      if (!force && !needsRefresh(a) && !hasTokenRepairSignal(a)) {
        return { kind: "ok", result: { email: a.email, ok: true, skipped: true } };
      }
      const wasRepair = hasTokenRepairSignal(a);
      const r = await refreshOneTok(a, {
        force,
        observedGeneration: listed.token_generation,
      });
      const result = {
        email: a.email,
        ok: r.ok,
        skipped: !!r.skipped,
        gen: r.gen,
        error: r.error,
        reauthRequired: !!r.reauthRequired,
      };
      if (r.ok) return { kind: wasRepair ? "revived" : "ok", result };
      if (r.reauthRequired || r.revoked) {
        if (r.revoked && !r.reauthRequired) markRequiresReauth(a, r.code || "token_revoked", r.detail);
        return { kind: "dead", result };
      }
      return { result };
    });
  });

  let okN = 0, revived = 0, dead = 0;
  const results = [];
  for (const row of rows) {
    if (!row) continue;
    results.push(row.result);
    if (row.kind === "ok") okN += 1;
    else if (row.kind === "revived") revived += 1;
    else if (row.kind === "dead") dead += 1;
  }

  return { okCount: okN, revivedCount: revived, deadCount: dead, results };
}

module.exports = { refreshOneTok, needsRefresh, listedNeedsTokenRefresh, refreshAll };

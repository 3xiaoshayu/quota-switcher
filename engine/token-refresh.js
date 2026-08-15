const { TOKEN_URL, CLIENT_ID } = require("./config");
const { ts, isTokenExpired, jwtExp } = require("./crypto-utils");
const { httpJson, extractErrorCode } = require("./http-client");
const { saveAcct, loadAcct, listAccts, loadIdx } = require("./storage");
const { writeAuthJson, writeProjection } = require("./switch");
const { withAccountLock } = require("./operation-locks");

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
  const { inspectAuthState } = require("./auth-state");
  const authState = inspectAuthState({ migrateProjection: false });
  if (authState.status !== "aligned" || authState.currentAccountId !== acct.id) return;
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
  if (!force && !needsRefresh(acct) && !hasTokenRepairSignal(acct)) {
    return { ok: true, skipped: true, gen: acct.token_generation || 0, timeLeft: tokenTimeLeft(acct) };
  }
  if (!acct.tokens.refresh_token) {
    markRequiresReauth(acct, "missing_refresh_token", "This account has no refresh token.");
    return { ok: false, error: "缺少 refresh_token", revoked: true, reauthRequired: true, code: "missing_refresh_token" };
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
    if (resp.status >= 400) {
      const code = extractErrorCode(resp.body);
      const revoked = isReauthErrorCode(code) || isReauthErrorText(resp.body);
      if (revoked) markRequiresReauth(acct, code, resp.body.slice(0, 300));
      return { ok: false, error: tokenRefreshError(resp.status, code), revoked, code, detail: resp.body.slice(0, 300) };
    }
    const data = JSON.parse(resp.body);
    const idTok = data.id_token || acct.tokens.id_token;
    const accTok = data.access_token || "";
    const refTok = data.refresh_token || acct.tokens.refresh_token;
    if (!accTok) return { ok: false, error: "响应无 access_token", revoked: false };

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
    saveAcct(acct);
    syncCurrentAuthIfNeeded(acct);
    return { ok: true, skipped: false, gen: acct.token_generation };
  } catch (err) {
    return { ok: false, error: err.message, revoked: false };
  }
}

function needsRefresh(acct) {
  if (!acct.tokens.refresh_token) return false;
  return isTokenExpired(acct.tokens.access_token);
}

async function refreshAll(force) {
  const accts = listAccts();
  if (!accts.length) return { okCount: 0, revivedCount: 0, deadCount: 0, results: [] };

  let okN = 0, revived = 0, dead = 0;
  const results = [];

  for (const listed of accts) {
    await withAccountLock(listed.id, async () => {
      const a = loadAcct(listed.id);
      if (!a) return;
      if (a.banned) {
        results.push({ email: a.email, ok: false, skipped: true, banned: true });
        return;
      }
      if (!force && !needsRefresh(a) && !hasTokenRepairSignal(a)) {
        okN++;
        results.push({ email: a.email, ok: true, skipped: true });
        return;
      }
      const wasRepair = hasTokenRepairSignal(a);
      const r = await refreshOneTok(a, { force });
      results.push({
        email: a.email,
        ok: r.ok,
        skipped: !!r.skipped,
        gen: r.gen,
        error: r.error,
        reauthRequired: !!r.reauthRequired,
      });

      if (r.ok) {
        if (wasRepair) revived++;
        else okN++;
      } else if (r.reauthRequired) {
        dead++;
      } else if (r.revoked) {
        dead++;
        markRequiresReauth(a, r.code || "token_revoked", r.detail);
      }
    });
    // A short pause keeps the token endpoint friendly without making a
    // six-account batch check feel sluggish.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // 保持当前账号 auth.json 最新（锁内执行，避免与在途刷新交错）
  const idx = loadIdx();
  if (idx.current_account_id) {
    await withAccountLock(idx.current_account_id, async () => {
      const cur = loadAcct(idx.current_account_id);
      if (cur) syncCurrentAuthIfNeeded(cur);
    });
  }

  return { okCount: okN, revivedCount: revived, deadCount: dead, results };
}

module.exports = { refreshOneTok, needsRefresh, refreshAll };

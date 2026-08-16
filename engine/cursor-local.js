const { ts, jwtPayload, buildCursorId } = require("./crypto-utils");
const { getCursorRuntime } = require("./cursor-runtime");
const { readCursorAuth, hasPendingWal } = require("./cursor-db");
const {
  loadCursorAcct,
  saveCursorAcct,
  listCursorAccts,
  upsertCursorIndex,
  currentCursorAcct,
  setCurrentCursorAccountId,
} = require("./cursor-storage");
const { withAccountLock } = require("./operation-locks");
const { logInfo } = require("./logger");

function authFromLocalValues(values) {
  const accessToken = String(values?.["cursorAuth/accessToken"] || "").trim();
  const email = String(
    values?.["cursorAuth/cachedEmail"]
    || values?.["cursor.email"]
    || jwtPayload(accessToken)?.email
    || "",
  ).trim();
  if (!accessToken || !email) return null;
  const refreshToken = String(values?.["cursorAuth/refreshToken"] || "").trim() || null;
  const authId = String(values?.["cursorAuth/authId"] || "").trim()
    || String(jwtPayload(accessToken)?.sub || "").trim()
    || email;
  return {
    email,
    authId,
    accessToken,
    refreshToken,
    planType: String(values?.["cursorAuth/stripeMembershipType"] || "").trim() || null,
    subscriptionStatus: String(values?.["cursorAuth/stripeSubscriptionStatus"] || "").trim() || null,
  };
}

function sameCursorIdentity(left, right) {
  const leftAuth = String(left?.auth_id || left?.tokens?.auth_id || "").trim().toLowerCase();
  const rightAuth = String(right?.auth_id || right?.tokens?.auth_id || "").trim().toLowerCase();
  if (leftAuth && rightAuth) return leftAuth === rightAuth;
  const leftEmail = String(left?.email || "").trim().toLowerCase();
  const rightEmail = String(right?.email || "").trim().toLowerCase();
  return !!leftEmail && leftEmail === rightEmail;
}

function findSameCursorId(preview) {
  if (loadCursorAcct(preview.id)) return preview.id;
  const existing = listCursorAccts().find((account) => sameCursorIdentity(preview, account));
  return existing?.id || preview.id;
}

function accountFromCursorTokens(tokens, existing = null) {
  const now = ts();
  const email = String(tokens.email || existing?.email || "").trim() || "unknown";
  const authId = String(tokens.auth_id || tokens.authId || existing?.auth_id || email).trim();
  return {
    id: existing?.id || buildCursorId(email, authId),
    platform: "cursor",
    email,
    plan_type: tokens.plan_type || tokens.planType || existing?.plan_type || null,
    subscription_status: tokens.subscription_status || tokens.subscriptionStatus || existing?.subscription_status || null,
    auth_id: authId,
    auth_mode: "oauth",
    tokens: {
      access_token: tokens.access_token || tokens.accessToken,
      refresh_token: tokens.refresh_token || tokens.refreshToken || existing?.tokens?.refresh_token || null,
      auth_id: authId,
    },
    token_generation: (existing?.token_generation || 0) + 1,
    token_updated_at: now,
    token_source_mode: "managed",
    requires_reauth: false,
    reauth_reason: null,
    banned: false,
    probe: existing?.probe || null,
    quota: existing?.quota || null,
    quota_error: null,
    usage_updated_at: existing?.usage_updated_at || null,
    created_at: existing?.created_at || now,
    last_used: existing?.last_used || now,
  };
}

async function upsertCursorAccount(tokens, options = {}) {
  const preview = accountFromCursorTokens(tokens);
  const targetAccountId = options.targetAccountId || null;
  const targetAccount = targetAccountId ? loadCursorAcct(targetAccountId) : null;
  const mismatch = !!targetAccountId && (!targetAccount || !sameCursorIdentity(preview, targetAccount));
  const saveId = !mismatch && targetAccountId ? targetAccountId : findSameCursorId(preview);

  const account = await withAccountLock(saveId, async () => {
    const existing = loadCursorAcct(saveId);
    const merged = accountFromCursorTokens(tokens, existing);
    merged.id = saveId;
    saveCursorAcct(merged);
    upsertCursorIndex(merged);
    return merged;
  });

  return { account, mismatch, targetAccountId };
}

async function importLocalCursorAccount() {
  const dbPath = getCursorRuntime().vscdbPath();
  const stalePossible = hasPendingWal(dbPath);
  const values = await readCursorAuth(dbPath);
  const local = authFromLocalValues(values);
  if (!local) {
    return { found: false, account: null, stalePossible };
  }
  const result = await upsertCursorAccount({
    email: local.email,
    auth_id: local.authId,
    access_token: local.accessToken,
    refresh_token: local.refreshToken,
    plan_type: local.planType,
    subscription_status: local.subscriptionStatus,
  });
  setCurrentCursorAccountId(result.account.id);
  logInfo(`Imported local Cursor account ${result.account.email}`);
  return { found: true, stalePossible, ...result };
}

async function syncCurrentCursorFromOfficial() {
  return withAccountLock("__cursor_switch__", async () => {
    const existing = currentCursorAcct();
    const dbPath = getCursorRuntime().vscdbPath();
    const walPending = hasPendingWal(dbPath);
    if (walPending && existing) return existing;
    let values = null;
    try {
      values = await readCursorAuth(dbPath);
    } catch {
      return existing;
    }
    const local = authFromLocalValues(values);
    if (!local) return existing;
    const match = listCursorAccts().find((account) => sameCursorIdentity(account, {
      email: local.email,
      auth_id: local.authId,
    }));
    if (match && existing?.id !== match.id) {
      setCurrentCursorAccountId(match.id);
    }
    return currentCursorAcct();
  });
}

module.exports = {
  authFromLocalValues,
  sameCursorIdentity,
  accountFromCursorTokens,
  upsertCursorAccount,
  importLocalCursorAccount,
  syncCurrentCursorFromOfficial,
};

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
  deleteCursorAcct,
} = require("./cursor-storage");
const { extraIdentityIds, foldDuplicateAccounts, mergePreservedQuota, pickIdentityKeeper, usableAuthId, usableEmail } = require("./account-identity");
const { withAccountLock, withAccountLocks } = require("./operation-locks");
const { logInfo, logWarn } = require("./logger");

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
  const leftEmail = usableEmail(left?.email).toLowerCase();
  const rightEmail = usableEmail(right?.email).toLowerCase();
  if (leftEmail && rightEmail) return leftEmail === rightEmail;
  const leftAuth = usableAuthId(left?.auth_id || left?.tokens?.auth_id);
  const rightAuth = usableAuthId(right?.auth_id || right?.tokens?.auth_id);
  return !!leftAuth && leftAuth === rightAuth;
}

function findSameCursorId(preview) {
  const matches = listCursorAccts().filter((account) => sameCursorIdentity(preview, account));
  const self = loadCursorAcct(preview.id);
  if (self && !matches.some((account) => account.id === self.id)) matches.push(self);
  return pickIdentityKeeper(matches, currentCursorAcct()?.id)?.id || preview.id;
}

function collapseDuplicateCursorAccounts() {
  return foldDuplicateAccounts(
    listCursorAccts(),
    sameCursorIdentity,
    currentCursorAcct()?.id || null,
    (keeper, extras) => {
      const currentId = currentCursorAcct()?.id;
      if (currentId && extras.some((item) => item.id === currentId)) {
        setCurrentCursorAccountId(keeper.id);
      }
      saveCursorAcct(keeper);
      upsertCursorIndex(keeper);
      for (const extra of extras) {
        deleteCursorAcct(extra.id, { allowCurrent: true });
      }
    },
    (error) => logWarn(`Cursor account fold skipped: ${error.message}`),
  );
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
    ...mergePreservedQuota(existing, {
      quota: tokens.quota,
      quota_error: tokens.quota_error,
      probe: tokens.probe,
      usage_updated_at: tokens.usage_updated_at,
    }),
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
  const updated = !!loadCursorAcct(saveId);
  const lockIds = [saveId, ...extraIdentityIds(preview, saveId, listCursorAccts(), sameCursorIdentity)];

  const account = await withAccountLocks(lockIds, async () => {
    const existing = loadCursorAcct(saveId);
    const merged = accountFromCursorTokens(tokens, existing);
    merged.id = saveId;
    saveCursorAcct(merged);
    upsertCursorIndex(merged);
    collapseDuplicateCursorAccounts();
    return loadCursorAcct(saveId) || merged;
  });

  return { account, mismatch, targetAccountId, updated };
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

const OFFICIAL_SYNC_TTL_MS = 1500;
let lastOfficialSyncAt = 0;
let officialSyncInFlight = null;

async function syncCurrentCursorFromOfficialUncached() {
  const existing = currentCursorAcct();
  const dbPath = getCursorRuntime().vscdbPath();
  let values = null;
  try {
    values = await readCursorAuth(dbPath);
  } catch {
    return existing;
  }
  const local = authFromLocalValues(values);
  if (!local) return existing;
  return withAccountLock("__cursor_switch__", async () => {
    const current = currentCursorAcct();
    const match = listCursorAccts().find((account) => sameCursorIdentity(account, {
      email: local.email,
      auth_id: local.authId,
    }));
    if (match && current?.id !== match.id) {
      setCurrentCursorAccountId(match.id);
    }
    return currentCursorAcct();
  });
}

async function syncCurrentCursorFromOfficial(options = {}) {
  if (options.force !== true && officialSyncInFlight) return officialSyncInFlight;
  if (options.force !== true && lastOfficialSyncAt && (Date.now() - lastOfficialSyncAt) < OFFICIAL_SYNC_TTL_MS) {
    return currentCursorAcct();
  }
  officialSyncInFlight = (async () => {
    try {
      return await syncCurrentCursorFromOfficialUncached();
    } finally {
      lastOfficialSyncAt = Date.now();
      officialSyncInFlight = null;
    }
  })();
  return officialSyncInFlight;
}

function resetOfficialSyncCacheForTests() {
  lastOfficialSyncAt = 0;
  officialSyncInFlight = null;
}

module.exports = {
  authFromLocalValues,
  sameCursorIdentity,
  accountFromCursorTokens,
  upsertCursorAccount,
  importLocalCursorAccount,
  syncCurrentCursorFromOfficial,
  collapseDuplicateCursorAccounts,
  resetOfficialSyncCacheForTests,
  OFFICIAL_SYNC_TTL_MS,
};

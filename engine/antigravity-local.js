const { ts, sha256hex, buildAntigravityId } = require("./crypto-utils");
const { getAntigravityRuntime } = require("./antigravity-runtime");
const { readAntigravityAuth, hasPendingWal } = require("./antigravity-db");
const { readWindowsAntigravityCredential } = require("./antigravity-credential");
const { fetchGoogleUserInfo } = require("./antigravity-token");
const {
  loadAntigravityAcct,
  saveAntigravityAcct,
  listAntigravityAccts,
  upsertAntigravityIndex,
  currentAntigravityAcct,
  loadAntigravityIdx,
  setCurrentAntigravityAccountId,
  deleteAntigravityAcct,
} = require("./antigravity-storage");
const { extraIdentityIds, foldDuplicateAccounts, mergePreservedQuota, pickIdentityKeeper, usableAuthId, usableEmail } = require("./account-identity");
const { withAccountLock, withAccountLocks } = require("./operation-locks");
const { logInfo, logWarn } = require("./logger");

function refreshFingerprint(refreshToken) {
  return sha256hex(String(refreshToken || "")).slice(0, 16);
}

function sameAntigravityIdentity(left, right) {
  const leftEmail = usableEmail(left?.email).toLowerCase();
  const rightEmail = usableEmail(right?.email).toLowerCase();
  if (leftEmail && rightEmail) return leftEmail === rightEmail;
  const leftFp = usableAuthId(left?.auth_id || left?.tokens?.auth_id);
  const rightFp = usableAuthId(right?.auth_id || right?.tokens?.auth_id);
  return !!leftFp && leftFp === rightFp;
}

function findSameAntigravityId(preview, accounts = listAntigravityAccts({ secrets: false })) {
  const matches = accounts.filter((account) => sameAntigravityIdentity(preview, account));
  if (preview.id && !matches.some((account) => account.id === preview.id)) {
    const self = accounts.find((account) => account.id === preview.id) || loadAntigravityAcct(preview.id);
    if (self) matches.push(self);
  }
  return pickIdentityKeeper(matches, loadAntigravityIdx().current_antigravity_account_id)?.id || preview.id;
}

function collapseDuplicateAntigravityAccounts() {
  return foldDuplicateAccounts(
    listAntigravityAccts(),
    sameAntigravityIdentity,
    loadAntigravityIdx().current_antigravity_account_id || null,
    (keeper, extras) => {
      const currentId = loadAntigravityIdx().current_antigravity_account_id;
      if (currentId && extras.some((item) => item.id === currentId)) {
        setCurrentAntigravityAccountId(keeper.id);
      }
      saveAntigravityAcct(keeper);
      upsertAntigravityIndex(keeper);
      for (const extra of extras) {
        deleteAntigravityAcct(extra.id, { allowCurrent: true });
      }
    },
    (error) => logWarn(`Antigravity account fold skipped: ${error.message}`),
  );
}

function accountFromAntigravityTokens(tokens, existing = null) {
  const now = ts();
  const email = usableEmail(tokens.email) || usableEmail(existing?.email) || "unknown";
  const refresh = tokens.refresh_token || tokens.refreshToken || existing?.tokens?.refresh_token || "";
  const authId = String(tokens.auth_id || tokens.authId || existing?.auth_id || refreshFingerprint(refresh) || email).trim();
  return {
    id: existing?.id || buildAntigravityId(email, authId),
    platform: "antigravity",
    email,
    plan_type: tokens.plan_type || tokens.planType || existing?.plan_type || null,
    auth_id: authId,
    auth_mode: "oauth",
    tokens: {
      access_token: tokens.access_token || tokens.accessToken || existing?.tokens?.access_token || null,
      refresh_token: refresh || null,
      expiry_timestamp: Number(tokens.expiry_timestamp || tokens.expiryTimestamp || existing?.tokens?.expiry_timestamp || 0) || 0,
      token_type: tokens.token_type || tokens.tokenType || existing?.tokens?.token_type || "Bearer",
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

async function upsertAntigravityAccount(tokens, options = {}) {
  return withAccountLock("__antigravity_oauth_upsert__", async () => {
    const preview = accountFromAntigravityTokens(tokens);
    const listed = listAntigravityAccts({ secrets: false });
    const targetAccountId = options.targetAccountId || null;
    const targetAccount = targetAccountId ? loadAntigravityAcct(targetAccountId) : null;
    const mismatch = !!targetAccountId && (!targetAccount || !sameAntigravityIdentity(preview, targetAccount));
    const saveId = !mismatch && targetAccountId ? targetAccountId : findSameAntigravityId(preview, listed);
    const updated = listed.some((account) => account.id === saveId);
    const lockIds = [saveId, ...extraIdentityIds(preview, saveId, listed, sameAntigravityIdentity)];

    const account = await withAccountLocks(lockIds, async () => {
      const existing = loadAntigravityAcct(saveId);
      const merged = accountFromAntigravityTokens(tokens, existing);
      merged.id = saveId;
      saveAntigravityAcct(merged);
      upsertAntigravityIndex(merged);
      collapseDuplicateAntigravityAccounts();
      return loadAntigravityAcct(saveId) || merged;
    });

    if (!mismatch && !loadAntigravityIdx().current_antigravity_account_id) {
      setCurrentAntigravityAccountId(account.id);
    }

    return { account, mismatch, targetAccountId, updated };
  });
}

async function resolveEmail(accessToken, fallback) {
  const fromFallback = usableEmail(fallback);
  if (fromFallback) return fromFallback;
  if (!accessToken) return fromFallback;
  try {
    const info = await fetchGoogleUserInfo(accessToken);
    const email = String(info?.email || "").trim();
    return email.includes("@") ? email : fromFallback;
  } catch {
    return fromFallback;
  }
}

async function importLocalAntigravityAccount() {
  const runtime = getAntigravityRuntime();
  const dbPath = runtime.vscdbPath();
  let stalePossible = hasPendingWal(dbPath);
  let credential = null;
  try {
    credential = await readWindowsAntigravityCredential(runtime.execFile);
  } catch {
    credential = null;
  }
  let local = null;
  try {
    local = await readAntigravityAuth(dbPath);
  } catch {
    local = null;
  }
  const usedCredential = !!(credential?.refresh_token || credential?.access_token);
  const refresh = String((usedCredential ? credential.refresh_token : local?.refresh_token) || credential?.refresh_token || local?.refresh_token || "").trim();
  const access = String((usedCredential ? credential.access_token : local?.access_token) || credential?.access_token || local?.access_token || "").trim();
  if (!refresh && !access) {
    return { found: false, account: null, stalePossible };
  }
  if (usedCredential) stalePossible = false;
  const email = await resolveEmail(access, credential?.email);
  const result = await upsertAntigravityAccount({
    email: usableEmail(email),
    auth_id: refreshFingerprint(refresh || access),
    access_token: access || null,
    refresh_token: refresh || null,
    expiry_timestamp: (usedCredential ? credential.expiry_timestamp : local?.expiry_timestamp) || credential?.expiry_timestamp || local?.expiry_timestamp || 0,
    token_type: local?.token_type || "Bearer",
  });
  setCurrentAntigravityAccountId(result.account.id);
  logInfo(`Imported local Antigravity account ${result.account.email}`);
  return { found: true, stalePossible, ...result };
}

const OFFICIAL_SYNC_TTL_MS = 1500;
let lastOfficialSyncAt = 0;
let officialSyncInFlight = null;

async function syncCurrentAntigravityFromOfficialUncached() {
  const existing = currentAntigravityAcct();
  const runtime = getAntigravityRuntime();
  let credential = null;
  try {
    credential = typeof runtime.readSystemCredential === "function"
      ? await runtime.readSystemCredential(runtime.execFile)
      : await readWindowsAntigravityCredential(runtime.execFile);
  } catch {
    credential = null;
  }
  const dbPath = runtime.vscdbPath();
  let local = null;
  try {
    local = await readAntigravityAuth(dbPath);
  } catch {
    local = null;
  }
  const usedCredential = !!(credential?.refresh_token || credential?.access_token);
  const refresh = String((usedCredential ? credential.refresh_token : local?.refresh_token) || "").trim();
  const access = String((usedCredential ? credential.access_token : local?.access_token) || "").trim();
  if (!refresh && !access) return existing;
  const authId = refreshFingerprint(refresh || access);
  if (!authId) return existing;
  let email = usableEmail(credential?.email);
  if (!email) email = await resolveEmail(access, "");
  return withAccountLock("__antigravity_switch__", async () => {
    const current = currentAntigravityAcct();
    const match = listAntigravityAccts({ secrets: false }).find((account) => sameAntigravityIdentity(account, {
      email,
      auth_id: authId,
    }));
    if (match && current?.id !== match.id) {
      setCurrentAntigravityAccountId(match.id);
    }
    return currentAntigravityAcct();
  });
}

async function syncCurrentAntigravityFromOfficial(options = {}) {
  if (options.force !== true && officialSyncInFlight) return officialSyncInFlight;
  if (options.force !== true && lastOfficialSyncAt && (Date.now() - lastOfficialSyncAt) < OFFICIAL_SYNC_TTL_MS) {
    return currentAntigravityAcct();
  }
  officialSyncInFlight = (async () => {
    try {
      return await syncCurrentAntigravityFromOfficialUncached();
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
  refreshFingerprint,
  usableEmail,
  sameAntigravityIdentity,
  accountFromAntigravityTokens,
  upsertAntigravityAccount,
  importLocalAntigravityAccount,
  syncCurrentAntigravityFromOfficial,
  collapseDuplicateAntigravityAccounts,
  resetOfficialSyncCacheForTests,
  OFFICIAL_SYNC_TTL_MS,
};

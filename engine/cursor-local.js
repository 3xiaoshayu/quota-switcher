const { ts, jwtPayload, buildCursorId } = require("./crypto-utils");
const { getCursorRuntime } = require("./cursor-runtime");
const { readCursorAuth, readCursorSessionState, hasPendingWal, finiteTeamId } = require("./cursor-db");
const {
  loadCursorAcct,
  saveCursorAcct,
  listCursorAccts,
  upsertCursorIndex,
  currentCursorAcct,
  loadCursorIdx,
  setCurrentCursorAccountId,
  deleteCursorAcct,
} = require("./cursor-storage");
const { extraIdentityIds, foldDuplicateAccounts, mergePreservedQuota, pickIdentityKeeper, usableAuthId, usableEmail } = require("./account-identity");
const { withAccountLock, withAccountLocks } = require("./operation-locks");
const { logInfo, logWarn } = require("./logger");

const CURSOR_UI_KEYS = [
  "cursorAuth/cachedSignUpType",
  "cursorAuth/cachedTeam",
  "cursorAuth/cachedScopedProfile",
  "cursor.customize.userDisplayNameCache",
];

function pickCursorUi(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ui = {};
  for (const key of CURSOR_UI_KEYS) {
    const value = String(raw[key] || "").trim();
    if (value) ui[key] = value;
  }
  return Object.keys(ui).length ? ui : null;
}

function cursorUiFromValues(values) {
  return pickCursorUi(values);
}

function mergeCursorUi(existing, incoming) {
  const left = pickCursorUi(existing);
  const right = pickCursorUi(incoming);
  if (!left && !right) return null;
  return { ...(left || {}), ...(right || {}) };
}

function stubScopedProfile(account) {
  const email = String(account?.email || "").trim();
  const displayName = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
  if (!displayName) return "";
  return JSON.stringify({ displayName });
}

function applyCursorUiToValues(account, values) {
  const ui = pickCursorUi(account?.cursor_ui) || {};
  for (const key of CURSOR_UI_KEYS) {
    if (ui[key]) values[key] = ui[key];
  }
  if (!String(values["cursorAuth/cachedScopedProfile"] || "").trim()) {
    const stub = stubScopedProfile(account);
    if (stub) values["cursorAuth/cachedScopedProfile"] = stub;
  }
  return values;
}

function parseJsonValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function teamFromCursorUi(ui) {
  const parsed = parseJsonValue(ui?.["cursorAuth/cachedTeam"] || "");
  const teamId = finiteTeamId(parsed?.teamId);
  if (teamId == null) return null;
  return { teamId, name: String(parsed?.name || "").trim() };
}

function mergeCursorSession(existing, incoming) {
  if (!incoming || typeof incoming !== "object") return existing || null;
  if (!existing || typeof existing !== "object") return { ...incoming };
  if (incoming.teamId == null && existing.teamId != null) {
    return { ...incoming, ...existing, membershipType: incoming.membershipType || existing.membershipType };
  }
  return { ...existing, ...incoming };
}

function sessionFromAccount(account) {
  const captured = account?.cursor_session && typeof account.cursor_session === "object"
    ? account.cursor_session
    : {};
  const team = teamFromCursorUi(account?.cursor_ui);
  const teamId = finiteTeamId(captured.teamId ?? team?.teamId);
  const teamIds = Array.isArray(captured.teamIds)
    ? captured.teamIds.map(finiteTeamId).filter((id) => id != null)
    : (teamId != null ? [teamId] : []);
  return {
    teamId,
    teamIds,
    membershipType: captured.membershipType || account?.plan_type || null,
    isEnterprise: captured.isEnterprise === true,
    adminTeamId: captured.adminTeamId || (teamId != null ? String(teamId) : null),
    adminAuthId: captured.adminAuthId || null,
    adminCached: captured.adminCached || null,
  };
}

function persistOfficialCursorState(values, session) {
  let account = persistCursorUiFromValues(values);
  if (!account) {
    const local = authFromLocalValues(values);
    if (!local) return null;
    const match = listCursorAccts({ secrets: false }).find((item) => sameCursorIdentity(item, {
      email: local.email,
      auth_id: local.authId,
    }));
    account = match ? loadCursorAcct(match.id) : null;
  }
  if (!account) return null;
  if (session && typeof session === "object") {
    account.cursor_session = mergeCursorSession(account.cursor_session, session);
    saveCursorAcct(account);
    upsertCursorIndex(account);
  }
  return account;
}

function persistCursorUiFromValues(values) {
  const ui = cursorUiFromValues(values);
  if (!ui) return null;
  const local = authFromLocalValues(values);
  if (!local) return null;
  const match = listCursorAccts({ secrets: false }).find((account) => sameCursorIdentity(account, {
    email: local.email,
    auth_id: local.authId,
  }));
  if (!match) return null;
  const account = loadCursorAcct(match.id);
  if (!account) return null;
  account.cursor_ui = mergeCursorUi(account.cursor_ui, ui);
  saveCursorAcct(account);
  upsertCursorIndex(account);
  return account;
}

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

function findSameCursorId(preview, accounts = listCursorAccts({ secrets: false })) {
  const matches = accounts.filter((account) => sameCursorIdentity(preview, account));
  if (preview.id && !matches.some((account) => account.id === preview.id)) {
    const self = accounts.find((account) => account.id === preview.id) || loadCursorAcct(preview.id);
    if (self) matches.push(self);
  }
  return pickIdentityKeeper(matches, loadCursorIdx().current_cursor_account_id)?.id || preview.id;
}

function collapseDuplicateCursorAccounts() {
  return foldDuplicateAccounts(
    listCursorAccts(),
    sameCursorIdentity,
    loadCursorIdx().current_cursor_account_id || null,
    (keeper, extras) => {
      const currentId = loadCursorIdx().current_cursor_account_id;
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
    cursor_ui: mergeCursorUi(existing?.cursor_ui, tokens.cursor_ui),
    cursor_session: mergeCursorSession(existing?.cursor_session, tokens.cursor_session),
  };
}

async function upsertCursorAccount(tokens, options = {}) {
  return withAccountLock("__cursor_oauth_upsert__", async () => {
    const preview = accountFromCursorTokens(tokens);
    const listed = listCursorAccts({ secrets: false });
    const targetAccountId = options.targetAccountId || null;
    const targetAccount = targetAccountId ? loadCursorAcct(targetAccountId) : null;
    const mismatch = !!targetAccountId && (!targetAccount || !sameCursorIdentity(preview, targetAccount));
    const saveId = !mismatch && targetAccountId ? targetAccountId : findSameCursorId(preview, listed);
    const updated = listed.some((account) => account.id === saveId);
    const lockIds = [saveId, ...extraIdentityIds(preview, saveId, listed, sameCursorIdentity)];

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
  });
}

async function importLocalCursorAccount() {
  const dbPath = getCursorRuntime().vscdbPath();
  const stalePossible = hasPendingWal(dbPath);
  const values = await readCursorAuth(dbPath);
  const local = authFromLocalValues(values);
  if (!local) {
    return { found: false, account: null, stalePossible };
  }
  const imported = {
    email: local.email,
    auth_id: local.authId,
    access_token: local.accessToken,
    refresh_token: local.refreshToken,
    plan_type: local.planType,
    subscription_status: local.subscriptionStatus,
  };
  const ui = cursorUiFromValues(values);
  if (ui) imported.cursor_ui = ui;
  try {
    const session = await readCursorSessionState(dbPath);
    if (session) imported.cursor_session = session;
  } catch {}
  const result = await upsertCursorAccount(imported);
  setCurrentCursorAccountId(result.account.id);
  logInfo(`Imported local Cursor account ${result.account.email}`);
  return { found: true, stalePossible, ...result };
}

const OFFICIAL_SYNC_TTL_MS = 1500;
let lastOfficialSyncAt = 0;
let officialSyncInFlight = null;
let officialCursorGeneration = 0;
let officialSyncInFlightGeneration = -1;

function invalidateCursorOfficialSync() {
  officialCursorGeneration += 1;
  lastOfficialSyncAt = Date.now();
}

async function syncCurrentCursorFromOfficialUncached() {
  const generation = officialCursorGeneration;
  const existing = currentCursorAcct();
  const dbPath = getCursorRuntime().vscdbPath();
  let values = null;
  let session = null;
  try {
    values = await readCursorAuth(dbPath);
    session = await readCursorSessionState(dbPath);
  } catch {
    return currentCursorAcct() || existing;
  }
  if (generation !== officialCursorGeneration) return currentCursorAcct() || existing;
  const local = authFromLocalValues(values);
  if (!local) return currentCursorAcct() || existing;
  return withAccountLock("__cursor_switch__", async () => {
    if (generation !== officialCursorGeneration) return currentCursorAcct();
    const current = currentCursorAcct();
    const match = listCursorAccts({ secrets: false }).find((account) => sameCursorIdentity(account, {
      email: local.email,
      auth_id: local.authId,
    }));
    if (match) {
      persistOfficialCursorState(values, session);
      if (current?.id !== match.id) {
        setCurrentCursorAccountId(match.id);
      }
    }
    return currentCursorAcct();
  });
}

async function syncCurrentCursorFromOfficial(options = {}) {
  if (
    options.force !== true
    && officialSyncInFlight
    && officialSyncInFlightGeneration === officialCursorGeneration
  ) {
    return officialSyncInFlight;
  }
  if (options.force !== true && lastOfficialSyncAt && (Date.now() - lastOfficialSyncAt) < OFFICIAL_SYNC_TTL_MS) {
    return currentCursorAcct();
  }
  const generation = officialCursorGeneration;
  const pending = (async () => {
    try {
      return await syncCurrentCursorFromOfficialUncached();
    } finally {
      if (officialSyncInFlight === pending) {
        lastOfficialSyncAt = Date.now();
        officialSyncInFlight = null;
      }
    }
  })();
  officialSyncInFlightGeneration = generation;
  officialSyncInFlight = pending;
  return pending;
}

function resetOfficialSyncCacheForTests() {
  lastOfficialSyncAt = 0;
  officialSyncInFlight = null;
  officialCursorGeneration = 0;
  officialSyncInFlightGeneration = -1;
}

module.exports = {
  CURSOR_UI_KEYS,
  authFromLocalValues,
  sameCursorIdentity,
  cursorUiFromValues,
  mergeCursorUi,
  applyCursorUiToValues,
  persistCursorUiFromValues,
  persistOfficialCursorState,
  invalidateCursorOfficialSync,
  sessionFromAccount,
  mergeCursorSession,
  accountFromCursorTokens,
  upsertCursorAccount,
  importLocalCursorAccount,
  syncCurrentCursorFromOfficial,
  collapseDuplicateCursorAccounts,
  resetOfficialSyncCacheForTests,
  OFFICIAL_SYNC_TTL_MS,
};

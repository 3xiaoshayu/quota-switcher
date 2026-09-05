const { codedError } = require("./errors");
const path = require("node:path");
const { CODEX_DIR } = require("./config");
const { sha256hex, jwtPayload, extractChatgptAccountId } = require("./crypto-utils");
const { writeJsonAtomic, readJsonWithBackup } = require("./atomic-file");
const { loadIdx, saveIdx, loadAcct, saveAcct, listAccts } = require("./storage");
const { logInfo, logWarn } = require("./logger");

const AUTH_PATH = path.join(CODEX_DIR, "auth.json");
const PROJECTION_PATH = path.join(CODEX_DIR, "codex_auth_projection.json");
let lastConflictWarning = null;

function isInspectBusyError(error) {
  const message = error?.message || String(error || "");
  return !!(error?.transientIoError
    || /Authentication state is busy|timed out|EPERM|EACCES|EBUSY|EAGAIN|SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy|operation not permitted|resource busy|already has an operation in progress/i.test(message));
}

function busyAuthState(currentAccountId = null) {
  return {
    status: "unknown",
    requiresResolution: false,
    currentAccountId: currentAccountId || null,
    matchedAccountId: null,
    officialIdentity: null,
    message: "Authentication state is busy",
  };
}

function returnNonConflict(state) {
  lastConflictWarning = null;
  return {
    safeToMirrorOfficial: false,
    ...state,
  };
}

function returnConflict(state, officialFingerprint) {
  const signature = `${state.currentAccountId || "none"}:${officialFingerprint || "none"}`;
  if (signature !== lastConflictWarning) {
    logWarn("Official Codex authentication differs from the managed current account");
    lastConflictWarning = signature;
  }
  return state;
}

function canonicalAuthTokens(value) {
  const tokens = value?.tokens || {};
  return {
    id_token: String(tokens.id_token || ""),
    access_token: String(tokens.access_token || ""),
    refresh_token: String(tokens.refresh_token || ""),
    account_id: String(tokens.account_id || value?.account_id || ""),
  };
}

function accountAuthValue(account) {
  return {
    tokens: {
      id_token: account?.tokens?.id_token || "",
      access_token: account?.tokens?.access_token || "",
      refresh_token: account?.tokens?.refresh_token || "",
      account_id: account?.account_id || account?.tokens?.account_id || "",
    },
  };
}

function authFingerprint(value) {
  return sha256hex(JSON.stringify(canonicalAuthTokens(value)));
}

function readJson(filePath) {
  try {
    return readJsonWithBackup(filePath);
  } catch (error) {
    // A leftover lock is not "missing official auth". Let callers retry or
    // fail instead of pausing the daemon on a fake login conflict.
    if (error?.transientIoError) throw error;
    if (error?.code === "ENOENT") return null;
    if (error?.code && !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function readAgentIdentity(value) {
  const raw = value?.agent_identity || value?.agentIdentity;
  if (!raw || typeof raw !== "object") return null;
  return {
    email: raw.email ? String(raw.email) : null,
    accountId: raw.account_id || raw.accountId ? String(raw.account_id || raw.accountId) : null,
  };
}

function readOfficialAuth() {
  const value = readJson(AUTH_PATH);
  if (!value) return null;
  const tokens = canonicalAuthTokens(value);
  const agentIdentity = readAgentIdentity(value);
  if (!tokens.access_token && !tokens.id_token) {
    return {
      value,
      tokens,
      supported: false,
      agentIdentity,
      fingerprint: authFingerprint(value),
      identity: agentIdentity,
    };
  }
  const payload = jwtPayload(tokens.id_token) || jwtPayload(tokens.access_token) || {};
  const auth = payload["https://api.openai.com/auth"] || {};
  const identity = {
    email: payload.email ? String(payload.email) : null,
    accountId: tokens.account_id
      || (auth.chatgpt_account_id ? String(auth.chatgpt_account_id) : null)
      || (auth.account_id ? String(auth.account_id) : extractChatgptAccountId(tokens.access_token)),
  };
  return { value, tokens, supported: true, agentIdentity, fingerprint: authFingerprint(value), identity };
}

function readManagedProjection() {
  return readJson(PROJECTION_PATH);
}

function writeManagedProjection(account, authValue = accountAuthValue(account)) {
  const projection = {
    version: 2,
    writer: "codex-account-manager",
    account_id: account.id,
    email: account.email,
    token_generation: account.token_generation || 0,
    auth_fingerprint: authFingerprint(authValue),
    written_at: Math.floor(Date.now() / 1000),
  };
  writeJsonAtomic(PROJECTION_PATH, projection);
  return projection;
}

function publicOfficialIdentity(official) {
  return official?.identity ? {
    email: official.identity.email,
    accountId: official.identity.accountId,
  } : null;
}

function findMatchingAccount(official, accounts) {
  if (!official?.supported) return null;
  return accounts.find((account) => authFingerprint(accountAuthValue(account)) === official.fingerprint)
    || accounts.find((account) => {
      const accountId = account.account_id || account.tokens?.account_id || extractChatgptAccountId(account.tokens?.access_token || "");
      return official.identity?.accountId && accountId === official.identity.accountId;
    })
    || accounts.find((account) => identityMatchesAccount(official.identity, account));
}

function accountHasPlainIdentity(account) {
  return !!(account?.email || account?.account_id || account?.tokens?.account_id);
}

function findMatchingManagedAccount(official) {
  const listed = listAccts({ secrets: false });
  const fromMeta = findMatchingAccount(official, listed);
  if (fromMeta) return fromMeta;

  const unidentified = [];
  const identified = [];
  for (const item of listed) {
    if (accountHasPlainIdentity(item)) identified.push(item);
    else unidentified.push(item);
  }

  for (const item of unidentified) {
    const loaded = loadAcct(item.id);
    if (loaded && findMatchingAccount(official, [loaded])) return loaded;
  }
  for (const item of identified) {
    const loaded = loadAcct(item.id);
    if (loaded && findMatchingAccount(official, [loaded])) return loaded;
  }
  return null;
}

function identityMatchesAccount(identity, account) {
  if (!identity || !account) return false;
  const officialAccountId = String(identity.accountId || "");
  const managedAccountId = String(account.account_id || account.tokens?.account_id || "");
  if (officialAccountId && managedAccountId) return officialAccountId === managedAccountId;

  const officialEmail = String(identity.email || "").trim().toLowerCase();
  const managedEmail = String(account.email || "").trim().toLowerCase();
  return !!officialEmail && officialEmail === managedEmail;
}

function tokenAgeHint(accessToken) {
  const payload = jwtPayload(accessToken);
  const exp = Number(payload?.exp);
  const iat = Number(payload?.iat);
  return {
    exp: Number.isFinite(exp) ? exp : null,
    iat: Number.isFinite(iat) ? iat : null,
  };
}

function officialAuthLooksOlder(official, current) {
  const officialAge = tokenAgeHint(official?.tokens?.access_token);
  const vaultAge = tokenAgeHint(current?.tokens?.access_token);
  if (officialAge.exp != null && vaultAge.exp != null && officialAge.exp < vaultAge.exp) {
    return true;
  }
  if (
    (officialAge.exp == null || vaultAge.exp == null || officialAge.exp === vaultAge.exp)
    && officialAge.iat != null
    && vaultAge.iat != null
    && officialAge.iat < vaultAge.iat
  ) {
    return true;
  }
  return false;
}

function syncCurrentAccountFromOfficial(current, official) {
  current.tokens = {
    id_token: official.tokens.id_token || current.tokens?.id_token || "",
    access_token: official.tokens.access_token || current.tokens?.access_token || "",
    refresh_token: official.tokens.refresh_token || current.tokens?.refresh_token || null,
    account_id: official.tokens.account_id || current.account_id || current.tokens?.account_id || null,
  };
  current.account_id = official.tokens.account_id || current.account_id || null;
  if (official.identity?.email) current.email = official.identity.email;
  current.token_generation = Number(current.token_generation || 0) + 1;
  current.token_updated_at = Math.floor(Date.now() / 1000);
  current.requires_reauth = false;
  current.reauth_reason = null;
  current.quota_next_retry_at = null;
  saveAcct(current);

  const index = loadIdx();
  const summary = index.accounts.find((item) => item.id === current.id);
  if (summary) {
    summary.email = current.email;
    saveIdx(index);
  }
  writeManagedProjection(current, official.value);
  logInfo("Synchronized a rotated official Codex token for the managed current account");
  return current;
}

function inspectAuthState(options = {}) {
  const migrateProjection = options.migrateProjection !== false;
  const index = loadIdx();
  const current = index.current_account_id ? loadAcct(index.current_account_id) : null;
  const official = readOfficialAuth();
  const projection = readManagedProjection();

  if (!official) {
    return returnNonConflict({
      status: current ? "missing_official_auth" : "empty",
      requiresResolution: !!current,
      currentAccountId: current?.id || null,
      matchedAccountId: null,
      officialIdentity: null,
      message: current ? "Official Codex authentication is missing." : null,
    });
  }

  if (!official.supported) {
    return returnNonConflict({
      status: "unsupported_official_auth",
      requiresResolution: !!current,
      currentAccountId: current?.id || null,
      matchedAccountId: null,
      officialIdentity: official.agentIdentity ? publicOfficialIdentity(official) : null,
      message: official.agentIdentity
        ? "Official Codex is signed in with an agent identity, which this manager cannot manage."
        : "The official Codex authentication format is not an OAuth account.",
    });
  }

  const projectionAligned = !!current
    && projection?.account_id === current.id
    && projection?.auth_fingerprint === official.fingerprint;
  const accountAligned = !!current
    && authFingerprint(accountAuthValue(current)) === official.fingerprint;
  const sameIdentity = !!current && identityMatchesAccount(official.identity, current);

  if (projectionAligned || accountAligned) {
    if (migrateProjection && !projectionAligned) {
      writeManagedProjection(current, official.value);
      logInfo("Migrated the managed Codex authentication projection");
    }
    return returnNonConflict({
      status: "aligned",
      requiresResolution: false,
      currentAccountId: current.id,
      matchedAccountId: current.id,
      officialIdentity: publicOfficialIdentity(official),
      message: null,
      // Official still matches the last write, or the vault already matches.
      // Identity-only alignment must not push stale vault tokens over a
      // Codex-app rotation.
      safeToMirrorOfficial: true,
      // When the vault already holds the official tokens there is nothing to
      // mirror; callers can skip rewriting auth.json on every tick.
      vaultMatchesOfficial: accountAligned,
      projectionMatchesOfficial: projectionAligned,
    });
  }

  if (sameIdentity) {
    if (migrateProjection && !officialAuthLooksOlder(official, current)) {
      syncCurrentAccountFromOfficial(current, official);
    }
    return returnNonConflict({
      status: "aligned",
      requiresResolution: false,
      currentAccountId: current.id,
      matchedAccountId: current.id,
      officialIdentity: publicOfficialIdentity(official),
      message: null,
    });
  }

  const matching = findMatchingManagedAccount(official);

  if (!current) {
    return returnNonConflict({
      status: "unmanaged_official_auth",
      requiresResolution: true,
      currentAccountId: null,
      matchedAccountId: matching?.id || null,
      officialIdentity: publicOfficialIdentity(official),
      message: "An official Codex login is present but is not managed yet.",
    });
  }

  return returnConflict({
    status: "conflict",
    requiresResolution: true,
    currentAccountId: current.id,
    matchedAccountId: matching?.id || null,
    officialIdentity: publicOfficialIdentity(official),
    message: "Official Codex was signed into a different account outside this manager.",
  }, official.fingerprint);
}

function canMirrorOfficialAuth(authState) {
  return !!authState
    && authState.status === "aligned"
    && authState.safeToMirrorOfficial === true
    && !!authState.currentAccountId;
}

async function adoptOfficialAuth() {
  const official = readOfficialAuth();
  if (!official?.supported) throw codedError("official_login_unsupported", "No supported official Codex OAuth login was found");
  const { upsert } = require("./oauth");
  const { withAccountLock } = require("./operation-locks");
  return withAccountLock("__switch__", async () => {
    const result = await upsert(official.tokens);
    const account = result.account || result;
    const index = loadIdx();
    index.current_account_id = account.id;
    saveIdx(index);
    writeManagedProjection(account, official.value);
    logInfo("Adopted the official Codex login as the managed current account");
    return { account, updated: !!result.updated };
  });
}

async function reapplyManagedAuth(accountId = null) {
  const index = loadIdx();
  const targetId = accountId || index.current_account_id;
  if (!targetId) throw codedError("current_account_missing", "The managed current account is not available");
  // Reapply runs the same switch transaction as a manual switch, so it must
  // hold the same locks; otherwise two transactions can interleave and one
  // rollback undoes the other's committed state.
  const { withAccountLocks } = require("./operation-locks");
  const { doSwitch } = require("./switch");
  const lockIds = ["__switch__", targetId];
  if (index.current_account_id && index.current_account_id !== targetId) {
    lockIds.push(index.current_account_id);
  }
  return withAccountLocks(lockIds, async () => {
    const account = loadAcct(targetId);
    if (!account) throw codedError("current_account_missing", "The managed current account is not available");
    return doSwitch(account, { force: true });
  });
}

module.exports = {
  AUTH_PATH,
  PROJECTION_PATH,
  canonicalAuthTokens,
  accountAuthValue,
  authFingerprint,
  readOfficialAuth,
  readManagedProjection,
  writeManagedProjection,
  identityMatchesAccount,
  inspectAuthState,
  isInspectBusyError,
  busyAuthState,
  canMirrorOfficialAuth,
  adoptOfficialAuth,
  reapplyManagedAuth,
};

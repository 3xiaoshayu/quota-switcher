const path = require("node:path");
const { writeJsonAtomic, quarantineFile, restoreBackup, captureFile, statSyncWithRetry, restoreCapturedFile, copyFileWithRetry, unlinkWithRetry, readJsonWithRetry, readdirSyncWithRetry, mkdirSyncWithRetry } = require("./atomic-file");
const { jwtPayload } = require("./crypto-utils");
const { withPathLock } = require("./operation-locks");
const { logInfo, logWarn, logError } = require("./logger");

let secretCodec = null;
const diagnostics = [];
const pendingRewrites = new Map();
let rewriteTimer = null;
let rewriteFlush = Promise.resolve();

class AccountCredentialError extends Error {
  constructor(message, cause, kind = "unknown") {
    super(message, { cause });
    this.name = "AccountCredentialError";
    this.code = "credential_decrypt_failed";
    this.kind = kind;
  }
}

function recordDiagnostic(type, filePath, message, recovered = false) {
  const item = {
    type,
    filePath,
    message: String(message || ""),
    recovered,
    timestamp: Date.now(),
  };
  diagnostics.unshift(item);
  diagnostics.splice(100);
  const summary = `${type}: ${path.basename(filePath || "")} ${item.message}`;
  if (recovered) logWarn(`Recovered ${summary}`);
  else logError(summary);
  return item;
}

function getStorageDiagnostics() {
  return diagnostics.map((item) => ({ ...item }));
}

function setSecretCodec(codec) {
  if (!codec || typeof codec.encrypt !== "function" || typeof codec.decrypt !== "function") {
    throw new TypeError("Invalid account secret codec");
  }
  secretCodec = codec;
}

function requireSecretCodec() {
  if (!secretCodec) throw new Error("Account encryption is not initialized");
  return secretCodec;
}

function protectData(plainText) {
  return requireSecretCodec().encrypt(String(plainText));
}

function unprotectData(encoded) {
  try {
    return requireSecretCodec().decrypt(String(encoded));
  } catch (error) {
    throw new AccountCredentialError("Windows could not decrypt the protected data", error, "decrypt");
  }
}

function ensureDir(directory) {
  mkdirSyncWithRetry(directory);
}

function readJson(filePath) {
  return readJsonWithRetry(filePath);
}

function tryReadJsonWithBackup(filePath, kind) {
  try {
    return { value: readJson(filePath), recovered: false };
  } catch (primaryError) {
    if (primaryError.code === "ENOENT" || primaryError.transientIoError) throw primaryError;
    const backupPath = `${filePath}.bak`;
    try {
      const value = readJson(backupPath);
      try { quarantineFile(filePath, "invalid-json"); } catch {}
      restoreBackup(filePath);
      recordDiagnostic(kind, filePath, primaryError.message, true);
      return { value, recovered: true };
    } catch (backupError) {
      if (backupError?.code !== "ENOENT") {
        recordDiagnostic(kind, backupPath, backupError.message, false);
      }
    }
    throw primaryError;
  }
}

function accountSummary(account) {
  return {
    id: account.id,
    email: account.email,
    plan_type: account.plan_type || null,
    subscription_active_until: account.subscription_active_until || null,
    created_at: account.created_at || null,
    last_used: account.last_used || null,
  };
}

function tokenMetadataFromTokens(tokens, existing = null) {
  const access = tokens?.access_token || "";
  const payload = access ? jwtPayload(access) : null;
  const jwtExpiry = payload?.exp ? Number(payload.exp) : null;
  const storedExpiry = Number(tokens?.expiry_timestamp || existing?.token_exp || 0);
  const tokenExp = Number.isFinite(storedExpiry) && storedExpiry > 0
    ? storedExpiry
    : jwtExpiry;
  return {
    token_exp: tokenExp || null,
    token_iat: typeof payload?.iat === "number" ? Number(payload.iat) : (existing?.token_iat || null),
    has_refresh: !!tokens?.refresh_token,
    has_access: !!access,
  };
}

function hasPlaintextTokenMeta(raw) {
  return raw
    && (raw.token_exp != null || raw.has_refresh === true || raw.has_refresh === false || raw.has_access === true || raw.has_access === false);
}

function omitSecrets(account) {
  if (!account) return account;
  const copy = { ...account, tokens: null };
  delete copy.tokens_encrypted;
  Object.defineProperty(copy, "__secretsOmitted", { value: true, enumerable: false });
  if (account.__legacyPlaintext) {
    Object.defineProperty(copy, "__legacyPlaintext", { value: true, enumerable: false });
  }
  return copy;
}

function normalizeAccountId(id) {
  const value = String(id || "");
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.length > 128 ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new Error("Invalid account id");
  }
  return value;
}

function decodeAccount(raw, filePath, options = {}) {
  if (!raw || typeof raw !== "object") throw new Error(`Invalid account file: ${filePath}`);
  normalizeAccountId(raw.id);
  const secrets = options.secrets !== false;

  if (!secrets && raw.tokens_encrypted && hasPlaintextTokenMeta(raw)) {
    return omitSecrets({ ...raw, tokens: null });
  }

  if (raw.tokens_encrypted) {
    let tokens;
    try {
      tokens = JSON.parse(unprotectData(raw.tokens_encrypted));
    } catch (error) {
      if (error instanceof AccountCredentialError) throw error;
      throw new AccountCredentialError("The protected account token payload is invalid", error, "payload");
    }
    const decoded = { ...raw, tokens, ...tokenMetadataFromTokens(tokens, raw) };
    return secrets ? decoded : omitSecrets(decoded);
  }

  if (raw.tokens) {
    const legacy = { ...raw, ...tokenMetadataFromTokens(raw.tokens, raw) };
    Object.defineProperty(legacy, "__legacyPlaintext", { value: true, enumerable: false });
    return secrets ? legacy : omitSecrets(legacy);
  }

  throw new Error(`Account file has no token payload: ${filePath}`);
}

function rewriteFingerprint(filePath) {
  try {
    const stat = statSyncWithRetry(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function deferLegacyRewrite(filePath) {
  const resolved = path.resolve(filePath);
  const fingerprint = rewriteFingerprint(resolved);
  if (!fingerprint) return;
  pendingRewrites.set(resolved, fingerprint);
  if (rewriteTimer) return;
  rewriteTimer = setImmediate(() => {
    rewriteTimer = null;
    rewriteFlush = rewriteFlush.then(() => flushPendingAccountRewrites(), () => flushPendingAccountRewrites());
  });
}

async function flushPendingAccountRewrites() {
  if (rewriteTimer) {
    clearImmediate(rewriteTimer);
    rewriteTimer = null;
  }
  const entries = [...pendingRewrites.entries()];
  pendingRewrites.clear();
  for (const [filePath, expected] of entries) {
    try {
      await withPathLock(filePath, async () => {
        if (rewriteFingerprint(filePath) !== expected) return;
        loadAccountPath(filePath, {
          secrets: true,
          allowRestore: false,
          immediateMigrate: true,
        });
      });
    } catch (error) {
      logWarn(`Deferred account rewrite skipped: ${error.message}`);
    }
  }
}

function resetPendingAccountRewritesForTests() {
  if (rewriteTimer) {
    clearImmediate(rewriteTimer);
    rewriteTimer = null;
  }
  pendingRewrites.clear();
  rewriteFlush = Promise.resolve();
}

function migrateLegacyAccount(account, filePath) {
  if (!account || account.__legacyPlaintext !== true) return account;
  if (account.__secretsOmitted || !account.tokens) {
    deferLegacyRewrite(filePath);
    return account;
  }
  try {
    writeJsonAtomic(filePath, encodeAccount(account), { backup: false });
    copyFileWithRetry(filePath, `${filePath}.bak`);
    logInfo(`Migrated a legacy plaintext account record: ${path.basename(filePath)}`);
  } catch (error) {
    logWarn(`Legacy account migration failed (record stays readable): ${error.message}`);
  }
  return account;
}

function encodeAccount(account) {
  if (account?.__secretsOmitted && !account.tokens) {
    throw new Error("Cannot encode an account loaded without secrets");
  }
  const copy = { ...account };
  const tokens = copy.tokens || {};
  delete copy.tokens;
  delete copy.tokens_encrypted;
  delete copy.updated;
  const meta = tokenMetadataFromTokens(tokens, copy);
  return {
    ...copy,
    ...meta,
    storage_version: 3,
    token_protection: requireSecretCodec().name || "os-protected",
    tokens_encrypted: protectData(JSON.stringify(tokens)),
  };
}

function loadAccountPath(filePath, options = {}) {
  const secrets = options.secrets !== false;
  const allowRestore = options.allowRestore !== false;
  let raw;
  try {
    raw = readJson(filePath);
  } catch (parseError) {
    if (parseError.transientIoError) {
      recordDiagnostic("account_read", filePath, parseError.message, false);
      if (typeof options.onTransient === "function") options.onTransient(filePath, parseError);
      return null;
    }
    if (parseError?.code === "ENOENT") return null;
    if (allowRestore) {
      try {
        const backupRaw = readJson(`${filePath}.bak`);
        const account = decodeAccount(backupRaw, `${filePath}.bak`, { secrets: true });
        try { quarantineFile(filePath, "invalid-json"); } catch {}
        restoreBackup(filePath);
        migrateLegacyAccount(account, filePath);
        recordDiagnostic("account_json", filePath, parseError.message, true);
        return secrets ? account : omitSecrets(account);
      } catch (backupError) {
        if (backupError?.code !== "ENOENT") {
          recordDiagnostic("account_backup", `${filePath}.bak`, backupError.message, false);
        }
      }
    }
    try {
      const quarantined = quarantineFile(filePath, "invalid-json");
      if (quarantined) {
        recordDiagnostic("account_json", filePath, `Malformed JSON isolated at ${quarantined}`, false);
      } else {
        recordDiagnostic("account_json", filePath, parseError.message, false);
      }
    } catch {
      recordDiagnostic("account_json", filePath, parseError.message, false);
    }
    if (typeof options.onUnreadable === "function") options.onUnreadable(filePath, parseError);
    return null;
  }

  try {
    const decoded = decodeAccount(raw, filePath, { secrets });
    if (decoded?.__legacyPlaintext) {
      if (options.immediateMigrate) return migrateLegacyAccount(decoded, filePath);
      deferLegacyRewrite(filePath);
    }
    return decoded;
  } catch (error) {
    if (error instanceof AccountCredentialError && error.kind === "decrypt") {
      recordDiagnostic("account_credentials", filePath, error.message, false);
      if (typeof options.onCredentialFailure === "function") options.onCredentialFailure(filePath, error);
      return null;
    }
    if (allowRestore) {
      try {
        const account = decodeAccount(readJson(`${filePath}.bak`), `${filePath}.bak`, { secrets: true });
        restoreBackup(filePath);
        migrateLegacyAccount(account, filePath);
        recordDiagnostic("account_credentials", filePath, error.message, true);
        return secrets ? account : omitSecrets(account);
      } catch (backupError) {
        if (backupError?.code !== "ENOENT") {
          recordDiagnostic("account_backup", `${filePath}.bak`, backupError.message, false);
        }
      }
    }
    const type = error instanceof AccountCredentialError ? "account_credentials" : "account_data";
    recordDiagnostic(type, filePath, error.message, false);
    if (typeof options.onUnreadable === "function") options.onUnreadable(filePath, error);
    return null;
  }
}

function restoreFile(filePath, content) {
  restoreCapturedFile(filePath, content);
}

function createAccountFileStore(spec) {
  const prefix = String(spec.prefix || "");
  const accountsDir = spec.accountsDir;
  const indexPath = spec.indexPath;
  const dataDir = spec.dataDir;
  const currentField = spec.currentField;
  const indexVersion = spec.indexVersion || "1.0";
  const preserveIndexExtras = spec.preserveIndexExtras === true;
  const useIndexBackup = spec.useIndexBackup === true;
  const quarantineUnreadableIndex = spec.quarantineUnreadableIndex === true;
  const recordIndexDiagnostics = spec.recordIndexDiagnostics === true;
  const logIndexRebuild = spec.logIndexRebuild === true;
  const logIndexSync = spec.logIndexSync === true;
  const pathRequiresPrefix = spec.pathRequiresPrefix === true;
  const saveForeignPrefixError = spec.saveForeignPrefixError || "Invalid account id";
  const allowDeleteIndexOption = spec.allowDeleteIndexOption === true;
  const deleteRollbackLabel = spec.deleteRollbackLabel || "Rollback failed";
  const indexInvalidMessage = spec.indexInvalidMessage || "Account index has an invalid structure";
  const invalidIdError = spec.invalidIdError || "Invalid account id";
  const rebuildLogLabel = spec.rebuildLogLabel || "Account index";
  const eagerIndexLoad = spec.eagerIndexLoad === true;
  const normalizeOnLoad = spec.normalizeOnLoad === true;
  const decorateAccount = typeof spec.decorateAccount === "function" ? spec.decorateAccount : null;

  function emptyIndex() {
    return { version: indexVersion, accounts: [], [currentField]: null };
  }

  function normalizeIndex(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.accounts)) {
      throw new Error(indexInvalidMessage);
    }
    const normalized = preserveIndexExtras ? { ...value } : {};
    normalized.version = value.version || indexVersion;
    normalized.accounts = value.accounts;
    normalized[currentField] = value[currentField] || null;
    return normalized;
  }

  function accountFilePath(id) {
    const safeId = normalizeAccountId(id);
    if (pathRequiresPrefix && !safeId.startsWith(prefix)) {
      throw new Error(invalidIdError);
    }
    const root = path.resolve(accountsDir);
    const target = path.resolve(root, `${safeId}.json`);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error(invalidIdError);
    return target;
  }

  function withIndexLock(task) {
    return withPathLock(indexPath, task);
  }

  function applyDecorate(account) {
    if (!account || !decorateAccount) return account;
    return decorateAccount(account);
  }

  function scanAccounts(options = {}) {
    ensureDir(accountsDir);
    const stats = options.stats || null;
    if (stats) {
      stats.fileCount = 0;
      stats.credentialFailures = 0;
      stats.unreadable = 0;
      stats.transientReads = 0;
    }
    const accounts = [];
    for (const name of readdirSyncWithRetry(accountsDir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      if (stats) stats.fileCount += 1;
      const account = loadAccountPath(path.join(accountsDir, name), {
        allowRestore: options.allowRestore,
        secrets: options.secrets,
        onCredentialFailure: () => {
          if (stats) stats.credentialFailures += 1;
        },
        onUnreadable: () => {
          if (stats) stats.unreadable += 1;
        },
        onTransient: () => {
          if (stats) stats.transientReads += 1;
        },
      });
      if (account) accounts.push(applyDecorate(account));
    }
    accounts.sort((left, right) => (right.last_used || 0) - (left.last_used || 0));
    return accounts;
  }

  function saveIdx(index) {
    ensureDir(dataDir);
    writeJsonAtomic(indexPath, normalizeIndex(index));
  }

  function rebuildIndex(reason, preferredCurrentId = null, options = {}) {
    const stats = {};
    const accounts = scanAccounts({ stats });
    if (stats.credentialFailures > 0 && options.preserveOnCredentialFailure !== false) {
      if (recordIndexDiagnostics) {
        recordDiagnostic(
          "account_index",
          indexPath,
          `Index rebuild skipped: ${stats.credentialFailures} account file(s) could not be decrypted`,
          false,
        );
      }
      return options.fallbackIndex ? normalizeIndex(options.fallbackIndex) : emptyIndex();
    }
    if (stats.transientReads > 0) {
      if (recordIndexDiagnostics) {
        recordDiagnostic(
          "account_index",
          indexPath,
          `Index rebuild skipped: ${stats.transientReads} account file(s) were temporarily locked`,
          false,
        );
      }
      return options.fallbackIndex ? normalizeIndex(options.fallbackIndex) : emptyIndex();
    }
    const ids = new Set(accounts.map((account) => account.id));
    const index = {
      version: indexVersion,
      accounts: accounts.map(accountSummary),
      [currentField]: preferredCurrentId && ids.has(preferredCurrentId) ? preferredCurrentId : null,
    };
    saveIdx(index);
    if (recordIndexDiagnostics) {
      recordDiagnostic("account_index", indexPath, `Index rebuilt: ${reason}`, true);
    } else if (logIndexRebuild) {
      logInfo(`${rebuildLogLabel} rebuilt: ${reason}`);
    }
    return index;
  }

  function loadIdx() {
    ensureDir(dataDir);
    try {
      const raw = useIndexBackup
        ? tryReadJsonWithBackup(indexPath, "account_index").value
        : readJson(indexPath);
      const index = normalizeIndex(raw);
      if (index.accounts.length === 0) {
        let hasAccountFiles = false;
        try {
          hasAccountFiles = readdirSyncWithRetry(accountsDir).some((name) => name.startsWith(prefix) && name.endsWith(".json"));
        } catch (dirError) {
          if (dirError?.code !== "ENOENT") throw dirError;
        }
        if (hasAccountFiles) return rebuildIndex("index contained no accounts", index[currentField], { fallbackIndex: index });
      }
      return index;
    } catch (error) {
      if (error?.code === "ENOENT") {
        let hasAccountFiles = false;
        try {
          hasAccountFiles = readdirSyncWithRetry(accountsDir).some((name) => name.startsWith(prefix) && name.endsWith(".json"));
        } catch (dirError) {
          if (dirError?.code !== "ENOENT") throw dirError;
        }
        return hasAccountFiles
          ? rebuildIndex("index missing", null, { fallbackIndex: emptyIndex() })
          : emptyIndex();
      }
      if (useIndexBackup && error.transientIoError) {
        recordDiagnostic("account_index", indexPath, error.message, false);
        throw error;
      }
      if (quarantineUnreadableIndex) {
        try { quarantineFile(indexPath, "invalid-json"); } catch {}
      }
      if (recordIndexDiagnostics) {
        recordDiagnostic("account_index", indexPath, error.message, false);
      } else {
        logWarn(`Account index unreadable: ${error.message}`);
      }
      return rebuildIndex("index unreadable", null, { fallbackIndex: emptyIndex() });
    }
  }

  function loadAcct(id) {
    if (!id) return null;
    if (normalizeOnLoad) {
      const safeId = normalizeAccountId(id);
      if (!safeId.startsWith(prefix)) return null;
      return applyDecorate(loadAccountPath(accountFilePath(safeId)));
    }
    const rawId = String(id);
    if (!rawId.startsWith(prefix)) return null;
    return applyDecorate(loadAccountPath(accountFilePath(rawId)));
  }

  function saveAcct(account) {
    if (!account?.id) throw new Error("Account id is required");
    if (account.__secretsOmitted) {
      throw new Error("Refusing to persist an account loaded without secrets");
    }
    const safeId = normalizeAccountId(account.id);
    if (!safeId.startsWith(prefix)) {
      throw new Error(saveForeignPrefixError);
    }
    if (decorateAccount) decorateAccount(account);
    ensureDir(accountsDir);
    writeJsonAtomic(accountFilePath(safeId), encodeAccount(account));
  }

  function deleteAcct(id, options = {}) {
    const accountId = normalizeAccountId(id);
    if (pathRequiresPrefix && !accountId.startsWith(prefix)) {
      throw new Error(invalidIdError);
    }
    const filePath = accountFilePath(accountId);
    const targets = [filePath, `${filePath}.bak`, indexPath];
    const snapshot = new Map(targets.map((target) => [target, captureFile(target)]));

    try {
      const index = loadIdx();
      if (index[currentField] === accountId && options.allowCurrent !== true) {
        throw new Error("Switch to another account before deleting the current account.");
      }

      for (const target of [filePath, `${filePath}.bak`]) {
        try {
          unlinkWithRetry(target);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }

      if (!allowDeleteIndexOption || options.updateIndex !== false) {
        index.accounts = index.accounts.filter((item) => item.id !== accountId);
        if (index[currentField] === accountId) index[currentField] = null;
        saveIdx(index);
      }
      return true;
    } catch (error) {
      for (const [target, content] of snapshot) {
        try { restoreFile(target, content); } catch (restoreError) {
          logError(`${deleteRollbackLabel} for ${target}: ${restoreError.message}`);
        }
      }
      throw error;
    }
  }

  function listAccts(options = {}) {
    const secrets = options.secrets !== false;
    const stats = {};
    const accounts = scanAccounts({
      stats,
      secrets,
      allowRestore: secrets,
    });
    if (!secrets && options.syncIndex !== true) return accounts;
    const index = loadIdx();
    if (stats.credentialFailures > 0) {
      if (logIndexSync) {
        logWarn(`Account index synchronization skipped: ${stats.credentialFailures} account file(s) could not be decrypted`);
      }
      return accounts;
    }
    if (stats.transientReads > 0) {
      if (logIndexSync) {
        logWarn(`Account index synchronization skipped: ${stats.transientReads} account file(s) were temporarily locked`);
      }
      return accounts;
    }
    const summaries = accounts.map(accountSummary);
    const indexedIds = index.accounts.map((account) => account.id).sort().join("|");
    const scannedIds = summaries.map((account) => account.id).sort().join("|");
    if (indexedIds !== scannedIds) {
      index.accounts = summaries;
      if (index[currentField] && !accounts.some((account) => account.id === index[currentField])) {
        index[currentField] = null;
      }
      saveIdx(index);
      if (logIndexSync) logInfo("Account index synchronized with readable account files");
    }
    return accounts;
  }

  function currentAcct() {
    const index = loadIdx();
    return index[currentField] ? loadAcct(index[currentField]) : null;
  }

  function setCurrentAccountId(accountId) {
    const index = loadIdx();
    index[currentField] = accountId || null;
    saveIdx(index);
  }

  function upsertIndex(account) {
    const index = loadIdx();
    const summary = accountSummary(account);
    const position = index.accounts.findIndex((item) => item.id === account.id);
    if (position >= 0) index.accounts[position] = summary;
    else index.accounts.push(summary);
    saveIdx(index);
  }

  function snapshotMeta(accountId) {
    const accountPath = accountFilePath(accountId);
    return {
      accountPath,
      indexPath,
      account: captureFile(accountPath),
      index: captureFile(indexPath),
    };
  }

  function restoreMeta(snapshot) {
    if (!snapshot) return;
    restoreFile(snapshot.accountPath, snapshot.account);
    restoreFile(snapshot.indexPath, snapshot.index);
  }

  return {
    accountFilePath,
    withIndexLock,
    emptyIndex,
    normalizeIndex,
    scanAccounts,
    saveIdx,
    rebuildIndex,
    loadIdx,
    loadAcct,
    saveAcct,
    deleteAcct,
    listAccts,
    currentAcct,
    setCurrentAccountId,
    upsertIndex,
    snapshotMeta,
    restoreMeta,
  };
}

module.exports = {
  AccountCredentialError,
  setSecretCodec,
  protectData,
  unprotectData,
  ensureDir,
  normalizeAccountId,
  getStorageDiagnostics,
  encodeAccount,
  decodeAccount,
  loadAccountPath,
  accountSummary,
  flushPendingAccountRewrites,
  resetPendingAccountRewritesForTests,
  createAccountFileStore,
  captureFile,
  restoreFile,
};

const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR, ACCTS_DIR, IDX_PATH } = require("./config");
const { writeJsonAtomic, quarantineFile, restoreBackup, renameWithRetry, sleepSync } = require("./atomic-file");
const { logInfo, logWarn, logError } = require("./logger");

let secretCodec = null;
const diagnostics = [];

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
  fs.mkdirSync(directory, { recursive: true });
}

function emptyIndex() {
  return { version: "2.0", accounts: [], current_account_id: null };
}

function normalizeIndex(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.accounts)) {
    throw new Error("Account index has an invalid structure");
  }
  return {
    ...value,
    version: value.version || "2.0",
    current_account_id: value.current_account_id || null,
  };
}

// Antivirus scanners and indexers briefly lock files for reading just like
// they do for renames. A transient IO failure must never be treated as JSON
// corruption, or healthy files end up quarantined and dropped from the index.
const TRANSIENT_READ_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EAGAIN", "EMFILE", "ENFILE"]);

function readJson(filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if (!TRANSIENT_READ_CODES.has(error.code)) throw error;
      lastError = error;
      if (attempt < 2) sleepSync(30 * (attempt + 1));
    }
  }
  lastError.transientIoError = true;
  throw lastError;
}

function tryReadJsonWithBackup(filePath, kind) {
  try {
    return { value: readJson(filePath), recovered: false };
  } catch (primaryError) {
    if (primaryError.transientIoError) throw primaryError;
    const backupPath = `${filePath}.bak`;
    if (fs.existsSync(backupPath)) {
      try {
        const value = readJson(backupPath);
        if (fs.existsSync(filePath)) {
          try { quarantineFile(filePath, "invalid-json"); } catch {}
        }
        restoreBackup(filePath);
        recordDiagnostic(kind, filePath, primaryError.message, true);
        return { value, recovered: true };
      } catch (backupError) {
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

function accountFilePath(id) {
  const safeId = normalizeAccountId(id);
  const root = path.resolve(ACCTS_DIR);
  const target = path.resolve(root, `${safeId}.json`);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Invalid account id");
  return target;
}

// decodeAccount must stay a pure read: the backup recovery chain decodes
// `.bak` files while the primary is still corrupt on disk, and any write
// side effect at that point copies the corrupt primary over the good backup.
function decodeAccount(raw, filePath) {
  if (!raw || typeof raw !== "object") throw new Error(`Invalid account file: ${filePath}`);
  normalizeAccountId(raw.id);
  if (raw.tokens_encrypted) {
    let tokens;
    try {
      tokens = JSON.parse(unprotectData(raw.tokens_encrypted));
    } catch (error) {
      if (error instanceof AccountCredentialError) throw error;
      throw new AccountCredentialError("The protected account token payload is invalid", error, "payload");
    }
    return { ...raw, tokens };
  }

  if (raw.tokens) {
    const legacy = { ...raw };
    Object.defineProperty(legacy, "__legacyPlaintext", { value: true, enumerable: false });
    return legacy;
  }

  throw new Error(`Account file has no token payload: ${filePath}`);
}

// Rewrites a legacy plaintext record as an encrypted one. Runs only after
// any recovery has completed. Skips the plaintext backup copy and refreshes
// `.bak` with the encrypted bytes so no plaintext tokens linger on disk.
function migrateLegacyAccount(account, filePath) {
  if (!account || account.__legacyPlaintext !== true) return account;
  try {
    writeJsonAtomic(filePath, encodeAccount(account), { backup: false });
    fs.copyFileSync(filePath, `${filePath}.bak`);
    logInfo(`Migrated a legacy plaintext account record: ${path.basename(filePath)}`);
  } catch (error) {
    logWarn(`Legacy account migration failed (record stays readable): ${error.message}`);
  }
  return account;
}

function encodeAccount(account) {
  const copy = { ...account };
  const tokens = copy.tokens || {};
  delete copy.tokens;
  delete copy.tokens_encrypted;
  return {
    ...copy,
    storage_version: 3,
    token_protection: requireSecretCodec().name || "os-protected",
    tokens_encrypted: protectData(JSON.stringify(tokens)),
  };
}

function loadAccountPath(filePath, options = {}) {
  const allowRestore = options.allowRestore !== false;
  let raw;
  try {
    raw = readJson(filePath);
  } catch (parseError) {
    if (parseError.transientIoError) {
      // The file is briefly locked (antivirus/indexer). It is not corrupt:
      // never quarantine it, and tell the caller to skip index syncing.
      recordDiagnostic("account_read", filePath, parseError.message, false);
      if (typeof options.onTransient === "function") options.onTransient(filePath, parseError);
      return null;
    }
    if (allowRestore && fs.existsSync(`${filePath}.bak`)) {
      try {
        const backupRaw = readJson(`${filePath}.bak`);
        const account = decodeAccount(backupRaw, `${filePath}.bak`);
        if (fs.existsSync(filePath)) {
          try { quarantineFile(filePath, "invalid-json"); } catch {}
        }
        restoreBackup(filePath);
        migrateLegacyAccount(account, filePath);
        recordDiagnostic("account_json", filePath, parseError.message, true);
        return account;
      } catch (backupError) {
        recordDiagnostic("account_backup", `${filePath}.bak`, backupError.message, false);
      }
    }
    if (fs.existsSync(filePath)) {
      try {
        const quarantined = quarantineFile(filePath, "invalid-json");
        recordDiagnostic("account_json", filePath, `Malformed JSON isolated at ${quarantined}`, false);
      } catch {
        recordDiagnostic("account_json", filePath, parseError.message, false);
      }
    }
    if (typeof options.onUnreadable === "function") options.onUnreadable(filePath, parseError);
    return null;
  }

  try {
    return migrateLegacyAccount(decodeAccount(raw, filePath), filePath);
  } catch (error) {
    if (error instanceof AccountCredentialError && error.kind === "decrypt") {
      recordDiagnostic("account_credentials", filePath, error.message, false);
      if (typeof options.onCredentialFailure === "function") options.onCredentialFailure(filePath, error);
      return null;
    }
    if (allowRestore && fs.existsSync(`${filePath}.bak`)) {
      try {
        const account = decodeAccount(readJson(`${filePath}.bak`), `${filePath}.bak`);
        restoreBackup(filePath);
        migrateLegacyAccount(account, filePath);
        recordDiagnostic("account_credentials", filePath, error.message, true);
        return account;
      } catch {}
    }
    const type = error instanceof AccountCredentialError ? "account_credentials" : "account_data";
    recordDiagnostic(type, filePath, error.message, false);
    if (typeof options.onUnreadable === "function") options.onUnreadable(filePath, error);
    return null;
  }
}

function scanAccounts(options = {}) {
  ensureDir(ACCTS_DIR);
  const stats = options.stats || null;
  if (stats) {
    stats.fileCount = 0;
    stats.credentialFailures = 0;
    stats.unreadable = 0;
    stats.transientReads = 0;
  }
  const accounts = [];
  for (const name of fs.readdirSync(ACCTS_DIR)) {
    if (!name.startsWith("codex_") || !name.endsWith(".json")) continue;
    if (stats) stats.fileCount += 1;
    const account = loadAccountPath(path.join(ACCTS_DIR, name), {
      allowRestore: options.allowRestore,
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
    if (account) accounts.push(account);
  }
  accounts.sort((left, right) => (right.last_used || 0) - (left.last_used || 0));
  return accounts;
}

function rebuildIndex(reason, preferredCurrentId = null, options = {}) {
  const stats = {};
  const accounts = scanAccounts({ stats });
  if (stats.credentialFailures > 0 && options.preserveOnCredentialFailure !== false) {
    recordDiagnostic(
      "account_index",
      IDX_PATH,
      `Index rebuild skipped: ${stats.credentialFailures} account file(s) could not be decrypted`,
      false,
    );
    return options.fallbackIndex ? normalizeIndex(options.fallbackIndex) : emptyIndex();
  }
  if (stats.transientReads > 0) {
    recordDiagnostic(
      "account_index",
      IDX_PATH,
      `Index rebuild skipped: ${stats.transientReads} account file(s) were temporarily locked`,
      false,
    );
    return options.fallbackIndex ? normalizeIndex(options.fallbackIndex) : emptyIndex();
  }
  const ids = new Set(accounts.map((account) => account.id));
  const index = {
    version: "2.0",
    accounts: accounts.map(accountSummary),
    current_account_id: preferredCurrentId && ids.has(preferredCurrentId) ? preferredCurrentId : null,
  };
  saveIdx(index);
  recordDiagnostic("account_index", IDX_PATH, `Index rebuilt: ${reason}`, true);
  return index;
}

function loadIdx() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(IDX_PATH)) {
    return fs.existsSync(ACCTS_DIR)
      ? rebuildIndex("index missing", null, { fallbackIndex: emptyIndex() })
      : emptyIndex();
  }

  try {
    const result = tryReadJsonWithBackup(IDX_PATH, "account_index");
    const index = normalizeIndex(result.value);
    if (index.accounts.length === 0 && fs.existsSync(ACCTS_DIR)) {
      const accountFiles = fs.readdirSync(ACCTS_DIR).some((name) => name.startsWith("codex_") && name.endsWith(".json"));
      if (accountFiles) return rebuildIndex("index contained no accounts", index.current_account_id, { fallbackIndex: index });
    }
    return index;
  } catch (error) {
    if (error.transientIoError) {
      // A briefly locked index is not corruption: fail this one operation
      // instead of quarantining the file and losing current_account_id.
      recordDiagnostic("account_index", IDX_PATH, error.message, false);
      throw error;
    }
    if (fs.existsSync(IDX_PATH)) {
      try { quarantineFile(IDX_PATH, "invalid-json"); } catch {}
    }
    recordDiagnostic("account_index", IDX_PATH, error.message, false);
    return rebuildIndex("index unreadable", null, { fallbackIndex: emptyIndex() });
  }
}

function saveIdx(index) {
  ensureDir(DATA_DIR);
  writeJsonAtomic(IDX_PATH, normalizeIndex(index));
}

function loadAcct(id) {
  if (!id) return null;
  const filePath = accountFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  return loadAccountPath(filePath);
}

function saveAcct(account) {
  if (!account?.id) throw new Error("Account id is required");
  ensureDir(ACCTS_DIR);
  const filePath = accountFilePath(account.id);
  writeJsonAtomic(filePath, encodeAccount(account));
}

function captureFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function restoreFile(filePath, content) {
  if (content === null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.rollback.tmp`;
  fs.writeFileSync(tempPath, content);
  renameWithRetry(tempPath, filePath);
}

function deleteAcct(id, options = {}) {
  const accountId = normalizeAccountId(id);
  const filePath = accountFilePath(accountId);
  const targets = [filePath, `${filePath}.bak`, IDX_PATH];
  const snapshot = new Map(targets.map((target) => [target, captureFile(target)]));

  try {
    const index = loadIdx();
    if (index.current_account_id === accountId && options.allowCurrent !== true) {
      throw new Error("Switch to another account before deleting the current account.");
    }

    for (const target of [filePath, `${filePath}.bak`]) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }

    if (options.updateIndex !== false) {
      index.accounts = index.accounts.filter((item) => item.id !== accountId);
      if (index.current_account_id === accountId) index.current_account_id = null;
      saveIdx(index);
    }
    return true;
  } catch (error) {
    for (const [target, content] of snapshot) {
      try { restoreFile(target, content); } catch (restoreError) {
        logError(`Rollback failed for ${target}: ${restoreError.message}`);
      }
    }
    throw error;
  }
}

function listAccts() {
  const stats = {};
  const accounts = scanAccounts({ stats });
  const index = loadIdx();
  if (stats.credentialFailures > 0) {
    logWarn(`Account index synchronization skipped: ${stats.credentialFailures} account file(s) could not be decrypted`);
    return accounts;
  }
  if (stats.transientReads > 0) {
    logWarn(`Account index synchronization skipped: ${stats.transientReads} account file(s) were temporarily locked`);
    return accounts;
  }
  const summaries = accounts.map(accountSummary);
  const indexedIds = index.accounts.map((account) => account.id).sort().join("|");
  const scannedIds = summaries.map((account) => account.id).sort().join("|");
  if (indexedIds !== scannedIds) {
    index.accounts = summaries;
    if (index.current_account_id && !accounts.some((account) => account.id === index.current_account_id)) {
      index.current_account_id = null;
    }
    saveIdx(index);
    logInfo("Account index synchronized with readable account files");
  }
  return accounts;
}

function currentAcct() {
  const index = loadIdx();
  return index.current_account_id ? loadAcct(index.current_account_id) : null;
}

module.exports = {
  AccountCredentialError,
  setSecretCodec,
  protectData,
  unprotectData,
  ensureDir,
  normalizeAccountId,
  accountFilePath,
  loadIdx,
  saveIdx,
  loadAcct,
  saveAcct,
  deleteAcct,
  listAccts,
  currentAcct,
  getStorageDiagnostics,
  rebuildIndex,
};

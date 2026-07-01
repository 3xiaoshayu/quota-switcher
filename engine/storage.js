const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR, ACCTS_DIR, IDX_PATH } = require("./config");
const { writeJsonAtomic, quarantineFile, restoreBackup } = require("./atomic-file");
const { logInfo, logWarn, logError } = require("./logger");

let secretCodec = null;
const diagnostics = [];

class AccountCredentialError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "AccountCredentialError";
    this.code = "credential_decrypt_failed";
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
    throw new AccountCredentialError("Windows could not decrypt the protected data", error);
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function tryReadJsonWithBackup(filePath, kind) {
  try {
    return { value: readJson(filePath), recovered: false };
  } catch (primaryError) {
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

function decodeAccount(raw, filePath) {
  if (!raw || typeof raw !== "object") throw new Error(`Invalid account file: ${filePath}`);
  if (raw.tokens_encrypted) {
    let tokens;
    try {
      tokens = JSON.parse(unprotectData(raw.tokens_encrypted));
    } catch (error) {
      if (error instanceof AccountCredentialError) throw error;
      throw new AccountCredentialError("The protected account token payload is invalid", error);
    }
    return { ...raw, tokens };
  }

  if (raw.tokens) {
    const migrated = { ...raw };
    saveAcct(migrated);
    return migrated;
  }

  throw new Error(`Account file has no token payload: ${filePath}`);
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
    if (allowRestore && fs.existsSync(`${filePath}.bak`)) {
      try {
        const backupRaw = readJson(`${filePath}.bak`);
        const account = decodeAccount(backupRaw, `${filePath}.bak`);
        if (fs.existsSync(filePath)) {
          try { quarantineFile(filePath, "invalid-json"); } catch {}
        }
        restoreBackup(filePath);
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
    return null;
  }

  try {
    return decodeAccount(raw, filePath);
  } catch (error) {
    if (allowRestore && fs.existsSync(`${filePath}.bak`)) {
      try {
        const account = decodeAccount(readJson(`${filePath}.bak`), `${filePath}.bak`);
        restoreBackup(filePath);
        recordDiagnostic("account_credentials", filePath, error.message, true);
        return account;
      } catch {}
    }
    const type = error instanceof AccountCredentialError ? "account_credentials" : "account_data";
    recordDiagnostic(type, filePath, error.message, false);
    return null;
  }
}

function scanAccounts() {
  ensureDir(ACCTS_DIR);
  const accounts = [];
  for (const name of fs.readdirSync(ACCTS_DIR)) {
    if (!name.startsWith("codex_") || !name.endsWith(".json")) continue;
    const account = loadAccountPath(path.join(ACCTS_DIR, name));
    if (account) accounts.push(account);
  }
  accounts.sort((left, right) => (right.last_used || 0) - (left.last_used || 0));
  return accounts;
}

function rebuildIndex(reason, preferredCurrentId = null) {
  const accounts = scanAccounts();
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
    return fs.existsSync(ACCTS_DIR) ? rebuildIndex("index missing") : emptyIndex();
  }

  try {
    const result = tryReadJsonWithBackup(IDX_PATH, "account_index");
    const index = normalizeIndex(result.value);
    if (index.accounts.length === 0 && fs.existsSync(ACCTS_DIR)) {
      const accountFiles = fs.readdirSync(ACCTS_DIR).some((name) => name.startsWith("codex_") && name.endsWith(".json"));
      if (accountFiles) return rebuildIndex("index contained no accounts", index.current_account_id);
    }
    return index;
  } catch (error) {
    if (fs.existsSync(IDX_PATH)) {
      try { quarantineFile(IDX_PATH, "invalid-json"); } catch {}
    }
    recordDiagnostic("account_index", IDX_PATH, error.message, false);
    return rebuildIndex("index unreadable");
  }
}

function saveIdx(index) {
  ensureDir(DATA_DIR);
  writeJsonAtomic(IDX_PATH, normalizeIndex(index));
}

function loadAcct(id) {
  if (!id) return null;
  const filePath = path.join(ACCTS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return loadAccountPath(filePath);
}

function saveAcct(account) {
  if (!account?.id) throw new Error("Account id is required");
  ensureDir(ACCTS_DIR);
  const filePath = path.join(ACCTS_DIR, `${account.id}.json`);
  writeJsonAtomic(filePath, encodeAccount(account));
}

function deleteAcct(id) {
  const filePath = path.join(ACCTS_DIR, `${id}.json`);
  for (const target of [filePath, `${filePath}.bak`]) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
}

function listAccts() {
  const accounts = scanAccounts();
  const index = loadIdx();
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

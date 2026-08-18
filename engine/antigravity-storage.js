const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR, ANTIGRAVITY_ACCTS_DIR, ANTIGRAVITY_IDX_PATH } = require("./config");
const { writeJsonAtomic, renameWithRetry } = require("./atomic-file");
const {
  encodeAccount,
  loadAccountPath,
  accountSummary,
  normalizeAccountId,
  ensureDir,
} = require("./storage");
const { logInfo, logWarn, logError } = require("./logger");

function emptyAntigravityIndex() {
  return { version: "1.0", accounts: [], current_antigravity_account_id: null };
}

function normalizeAntigravityIndex(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.accounts)) {
    throw new Error("Antigravity account index has an invalid structure");
  }
  return {
    version: value.version || "1.0",
    accounts: value.accounts,
    current_antigravity_account_id: value.current_antigravity_account_id || null,
  };
}

function antigravityAccountFilePath(id) {
  const safeId = normalizeAccountId(id);
  if (!safeId.startsWith("antigravity_")) throw new Error("Invalid antigravity account id");
  const root = path.resolve(ANTIGRAVITY_ACCTS_DIR);
  const target = path.resolve(root, `${safeId}.json`);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Invalid antigravity account id");
  return target;
}

function scanAntigravityAccounts(options = {}) {
  ensureDir(ANTIGRAVITY_ACCTS_DIR);
  const stats = options.stats || null;
  if (stats) {
    stats.fileCount = 0;
    stats.credentialFailures = 0;
    stats.unreadable = 0;
    stats.transientReads = 0;
  }
  const accounts = [];
  for (const name of fs.readdirSync(ANTIGRAVITY_ACCTS_DIR)) {
    if (!name.startsWith("antigravity_") || !name.endsWith(".json")) continue;
    if (stats) stats.fileCount += 1;
    const account = loadAccountPath(path.join(ANTIGRAVITY_ACCTS_DIR, name), {
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
    if (account) {
      account.platform = "antigravity";
      account.banned = false;
      accounts.push(account);
    }
  }
  accounts.sort((left, right) => (right.last_used || 0) - (left.last_used || 0));
  return accounts;
}

function saveAntigravityIdx(index) {
  ensureDir(DATA_DIR);
  writeJsonAtomic(ANTIGRAVITY_IDX_PATH, normalizeAntigravityIndex(index));
}

function rebuildAntigravityIndex(reason, preferredCurrentId = null, options = {}) {
  const stats = {};
  const accounts = scanAntigravityAccounts({ stats });
  if (stats.credentialFailures > 0 && options.preserveOnCredentialFailure !== false) {
    return options.fallbackIndex ? normalizeAntigravityIndex(options.fallbackIndex) : emptyAntigravityIndex();
  }
  if (stats.transientReads > 0) {
    return options.fallbackIndex ? normalizeAntigravityIndex(options.fallbackIndex) : emptyAntigravityIndex();
  }
  const ids = new Set(accounts.map((account) => account.id));
  const index = {
    version: "1.0",
    accounts: accounts.map(accountSummary),
    current_antigravity_account_id: preferredCurrentId && ids.has(preferredCurrentId) ? preferredCurrentId : null,
  };
  saveAntigravityIdx(index);
  logInfo(`Antigravity account index rebuilt: ${reason}`);
  return index;
}

function loadAntigravityIdx() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(ANTIGRAVITY_IDX_PATH)) {
    return fs.existsSync(ANTIGRAVITY_ACCTS_DIR)
      ? rebuildAntigravityIndex("index missing", null, { fallbackIndex: emptyAntigravityIndex() })
      : emptyAntigravityIndex();
  }
  try {
    const index = normalizeAntigravityIndex(JSON.parse(fs.readFileSync(ANTIGRAVITY_IDX_PATH, "utf8")));
    if (index.accounts.length === 0 && fs.existsSync(ANTIGRAVITY_ACCTS_DIR)) {
      const accountFiles = fs.readdirSync(ANTIGRAVITY_ACCTS_DIR).some((name) => name.startsWith("antigravity_") && name.endsWith(".json"));
      if (accountFiles) {
        return rebuildAntigravityIndex("index contained no accounts", index.current_antigravity_account_id, { fallbackIndex: index });
      }
    }
    return index;
  } catch (error) {
    logWarn(`Antigravity account index unreadable: ${error.message}`);
    return rebuildAntigravityIndex("index unreadable", null, { fallbackIndex: emptyAntigravityIndex() });
  }
}

function loadAntigravityAcct(id) {
  if (!id || !String(id).startsWith("antigravity_")) return null;
  const filePath = antigravityAccountFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  const account = loadAccountPath(filePath);
  if (!account) return null;
  account.platform = "antigravity";
  account.banned = false;
  return account;
}

function saveAntigravityAcct(account) {
  if (!account?.id) throw new Error("Account id is required");
  if (!String(account.id).startsWith("antigravity_")) throw new Error("Invalid antigravity account id");
  account.platform = "antigravity";
  account.banned = false;
  ensureDir(ANTIGRAVITY_ACCTS_DIR);
  writeJsonAtomic(antigravityAccountFilePath(account.id), encodeAccount(account));
}

function listAntigravityAccts() {
  const stats = {};
  const accounts = scanAntigravityAccounts({ stats });
  if (stats.credentialFailures > 0 || stats.transientReads > 0) return accounts;
  const index = loadAntigravityIdx();
  const summaries = accounts.map(accountSummary);
  const indexedIds = index.accounts.map((account) => account.id).sort().join("|");
  const scannedIds = summaries.map((account) => account.id).sort().join("|");
  if (indexedIds !== scannedIds) {
    index.accounts = summaries;
    if (index.current_antigravity_account_id && !accounts.some((account) => account.id === index.current_antigravity_account_id)) {
      index.current_antigravity_account_id = null;
    }
    saveAntigravityIdx(index);
  }
  return accounts;
}

function currentAntigravityAcct() {
  const index = loadAntigravityIdx();
  return index.current_antigravity_account_id ? loadAntigravityAcct(index.current_antigravity_account_id) : null;
}

function setCurrentAntigravityAccountId(accountId) {
  const index = loadAntigravityIdx();
  index.current_antigravity_account_id = accountId || null;
  saveAntigravityIdx(index);
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

function deleteAntigravityAcct(id, options = {}) {
  const accountId = normalizeAccountId(id);
  if (!accountId.startsWith("antigravity_")) throw new Error("Invalid antigravity account id");
  const filePath = antigravityAccountFilePath(accountId);
  const targets = [filePath, `${filePath}.bak`, ANTIGRAVITY_IDX_PATH];
  const snapshot = new Map(targets.map((target) => [target, captureFile(target)]));

  try {
    const index = loadAntigravityIdx();
    if (index.current_antigravity_account_id === accountId && options.allowCurrent !== true) {
      throw new Error("Switch to another account before deleting the current account.");
    }
    for (const target of [filePath, `${filePath}.bak`]) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    index.accounts = index.accounts.filter((item) => item.id !== accountId);
    if (index.current_antigravity_account_id === accountId) index.current_antigravity_account_id = null;
    saveAntigravityIdx(index);
    return true;
  } catch (error) {
    for (const [target, content] of snapshot) {
      try { restoreFile(target, content); } catch (restoreError) {
        logError(`Antigravity account rollback failed for ${target}: ${restoreError.message}`);
      }
    }
    throw error;
  }
}

function upsertAntigravityIndex(account) {
  const index = loadAntigravityIdx();
  const summary = accountSummary(account);
  const position = index.accounts.findIndex((item) => item.id === account.id);
  if (position >= 0) index.accounts[position] = summary;
  else index.accounts.push(summary);
  saveAntigravityIdx(index);
}

function snapshotAntigravityMeta(accountId) {
  const accountPath = antigravityAccountFilePath(accountId);
  return {
    accountPath,
    indexPath: ANTIGRAVITY_IDX_PATH,
    account: captureFile(accountPath),
    index: captureFile(ANTIGRAVITY_IDX_PATH),
  };
}

function restoreAntigravityMeta(snapshot) {
  if (!snapshot) return;
  restoreFile(snapshot.accountPath, snapshot.account);
  restoreFile(snapshot.indexPath, snapshot.index);
}

module.exports = {
  antigravityAccountFilePath,
  loadAntigravityIdx,
  saveAntigravityIdx,
  loadAntigravityAcct,
  saveAntigravityAcct,
  listAntigravityAccts,
  currentAntigravityAcct,
  setCurrentAntigravityAccountId,
  deleteAntigravityAcct,
  upsertAntigravityIndex,
  snapshotAntigravityMeta,
  restoreAntigravityMeta,
  scanAntigravityAccounts,
};

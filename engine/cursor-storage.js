const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR, CURSOR_ACCTS_DIR, CURSOR_IDX_PATH } = require("./config");
const { writeJsonAtomic, renameWithRetry } = require("./atomic-file");
const {
  encodeAccount,
  loadAccountPath,
  accountSummary,
  normalizeAccountId,
  ensureDir,
} = require("./storage");
const { logInfo, logWarn, logError } = require("./logger");

function emptyCursorIndex() {
  return { version: "1.0", accounts: [], current_cursor_account_id: null };
}

function normalizeCursorIndex(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.accounts)) {
    throw new Error("Cursor account index has an invalid structure");
  }
  return {
    version: value.version || "1.0",
    accounts: value.accounts,
    current_cursor_account_id: value.current_cursor_account_id || null,
  };
}

function cursorAccountFilePath(id) {
  const safeId = normalizeAccountId(id);
  if (!safeId.startsWith("cursor_")) throw new Error("Invalid cursor account id");
  const root = path.resolve(CURSOR_ACCTS_DIR);
  const target = path.resolve(root, `${safeId}.json`);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Invalid cursor account id");
  return target;
}

function scanCursorAccounts(options = {}) {
  ensureDir(CURSOR_ACCTS_DIR);
  const stats = options.stats || null;
  if (stats) {
    stats.fileCount = 0;
    stats.credentialFailures = 0;
    stats.unreadable = 0;
    stats.transientReads = 0;
  }
  const accounts = [];
  for (const name of fs.readdirSync(CURSOR_ACCTS_DIR)) {
    if (!name.startsWith("cursor_") || !name.endsWith(".json")) continue;
    if (stats) stats.fileCount += 1;
    const account = loadAccountPath(path.join(CURSOR_ACCTS_DIR, name), {
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
      account.platform = "cursor";
      account.banned = false;
      accounts.push(account);
    }
  }
  accounts.sort((left, right) => (right.last_used || 0) - (left.last_used || 0));
  return accounts;
}

function saveCursorIdx(index) {
  ensureDir(DATA_DIR);
  writeJsonAtomic(CURSOR_IDX_PATH, normalizeCursorIndex(index));
}

function rebuildCursorIndex(reason, preferredCurrentId = null, options = {}) {
  const stats = {};
  const accounts = scanCursorAccounts({ stats });
  if (stats.credentialFailures > 0 && options.preserveOnCredentialFailure !== false) {
    return options.fallbackIndex ? normalizeCursorIndex(options.fallbackIndex) : emptyCursorIndex();
  }
  if (stats.transientReads > 0) {
    return options.fallbackIndex ? normalizeCursorIndex(options.fallbackIndex) : emptyCursorIndex();
  }
  const ids = new Set(accounts.map((account) => account.id));
  const index = {
    version: "1.0",
    accounts: accounts.map(accountSummary),
    current_cursor_account_id: preferredCurrentId && ids.has(preferredCurrentId) ? preferredCurrentId : null,
  };
  saveCursorIdx(index);
  logInfo(`Cursor account index rebuilt: ${reason}`);
  return index;
}

function loadCursorIdx() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(CURSOR_IDX_PATH)) {
    return fs.existsSync(CURSOR_ACCTS_DIR)
      ? rebuildCursorIndex("index missing", null, { fallbackIndex: emptyCursorIndex() })
      : emptyCursorIndex();
  }
  try {
    const index = normalizeCursorIndex(JSON.parse(fs.readFileSync(CURSOR_IDX_PATH, "utf8")));
    if (index.accounts.length === 0 && fs.existsSync(CURSOR_ACCTS_DIR)) {
      const accountFiles = fs.readdirSync(CURSOR_ACCTS_DIR).some((name) => name.startsWith("cursor_") && name.endsWith(".json"));
      if (accountFiles) {
        return rebuildCursorIndex("index contained no accounts", index.current_cursor_account_id, { fallbackIndex: index });
      }
    }
    return index;
  } catch (error) {
    logWarn(`Cursor account index unreadable: ${error.message}`);
    return rebuildCursorIndex("index unreadable", null, { fallbackIndex: emptyCursorIndex() });
  }
}

function loadCursorAcct(id) {
  if (!id || !String(id).startsWith("cursor_")) return null;
  const filePath = cursorAccountFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  const account = loadAccountPath(filePath);
  if (!account) return null;
  account.platform = "cursor";
  account.banned = false;
  return account;
}

function saveCursorAcct(account) {
  if (!account?.id) throw new Error("Account id is required");
  if (!String(account.id).startsWith("cursor_")) throw new Error("Invalid cursor account id");
  account.platform = "cursor";
  account.banned = false;
  ensureDir(CURSOR_ACCTS_DIR);
  writeJsonAtomic(cursorAccountFilePath(account.id), encodeAccount(account));
}

function listCursorAccts() {
  const stats = {};
  const accounts = scanCursorAccounts({ stats });
  if (stats.credentialFailures > 0 || stats.transientReads > 0) return accounts;
  const index = loadCursorIdx();
  const summaries = accounts.map(accountSummary);
  const indexedIds = index.accounts.map((account) => account.id).sort().join("|");
  const scannedIds = summaries.map((account) => account.id).sort().join("|");
  if (indexedIds !== scannedIds) {
    index.accounts = summaries;
    if (index.current_cursor_account_id && !accounts.some((account) => account.id === index.current_cursor_account_id)) {
      index.current_cursor_account_id = null;
    }
    saveCursorIdx(index);
  }
  return accounts;
}

function currentCursorAcct() {
  const index = loadCursorIdx();
  return index.current_cursor_account_id ? loadCursorAcct(index.current_cursor_account_id) : null;
}

function setCurrentCursorAccountId(accountId) {
  const index = loadCursorIdx();
  index.current_cursor_account_id = accountId || null;
  saveCursorIdx(index);
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

function deleteCursorAcct(id, options = {}) {
  const accountId = normalizeAccountId(id);
  if (!accountId.startsWith("cursor_")) throw new Error("Invalid cursor account id");
  const filePath = cursorAccountFilePath(accountId);
  const targets = [filePath, `${filePath}.bak`, CURSOR_IDX_PATH];
  const snapshot = new Map(targets.map((target) => [target, captureFile(target)]));

  try {
    const index = loadCursorIdx();
    if (index.current_cursor_account_id === accountId && options.allowCurrent !== true) {
      throw new Error("Switch to another account before deleting the current account.");
    }
    for (const target of [filePath, `${filePath}.bak`]) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    index.accounts = index.accounts.filter((item) => item.id !== accountId);
    if (index.current_cursor_account_id === accountId) index.current_cursor_account_id = null;
    saveCursorIdx(index);
    return true;
  } catch (error) {
    for (const [target, content] of snapshot) {
      try { restoreFile(target, content); } catch (restoreError) {
        logError(`Cursor account rollback failed for ${target}: ${restoreError.message}`);
      }
    }
    throw error;
  }
}

function upsertCursorIndex(account) {
  const index = loadCursorIdx();
  const summary = accountSummary(account);
  const position = index.accounts.findIndex((item) => item.id === account.id);
  if (position >= 0) index.accounts[position] = summary;
  else index.accounts.push(summary);
  saveCursorIdx(index);
}

function snapshotCursorMeta(accountId) {
  const accountPath = cursorAccountFilePath(accountId);
  return {
    accountPath,
    indexPath: CURSOR_IDX_PATH,
    account: captureFile(accountPath),
    index: captureFile(CURSOR_IDX_PATH),
  };
}

function restoreCursorMeta(snapshot) {
  if (!snapshot) return;
  restoreFile(snapshot.accountPath, snapshot.account);
  restoreFile(snapshot.indexPath, snapshot.index);
}

module.exports = {
  cursorAccountFilePath,
  loadCursorIdx,
  saveCursorIdx,
  loadCursorAcct,
  saveCursorAcct,
  listCursorAccts,
  currentCursorAcct,
  setCurrentCursorAccountId,
  deleteCursorAcct,
  upsertCursorIndex,
  snapshotCursorMeta,
  restoreCursorMeta,
  scanCursorAccounts,
};

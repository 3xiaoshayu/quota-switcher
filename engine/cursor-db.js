const fs = require("node:fs");
const {
  asText,
  withVscdb,
  snapshotItems,
  restoreItems,
  waitForVscdbWritable,
  getSqliteNativeTiming,
  deleteItem,
  setItem,
  getItem,
  ensureItemTable,
} = require("./sqlite-native");

const AUTH_KEYS = [
  "cursorAuth/accessToken",
  "cursorAuth/refreshToken",
  "cursorAuth/cachedEmail",
  "cursorAuth/authId",
  "cursorAuth/stripeMembershipType",
  "cursorAuth/stripeSubscriptionStatus",
  "cursorAuth/cachedSignUpType",
  "cursor.accessToken",
  "cursor.email",
];

const SQLITE_LABELS = {
  busyMessage: "官方 Cursor 还在占用登录库，请关掉后再切",
  busyCode: "cursor_vscdb_busy",
  openMessage: "官方 Cursor 登录库无法打开",
  openCode: "cursor_vscdb_open_failed",
};

function hasPendingWal(dbPath) {
  if (!dbPath) return false;
  try {
    return fs.statSync(`${dbPath}-wal`).size > 32;
  } catch {
    return false;
  }
}

async function waitForWalToClear(dbPath, timeoutMs, sleep) {
  const wait = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const maxTries = Math.max(1, Math.ceil((Number(timeoutMs) || 0) / 200));
  for (let attempt = 0; attempt < maxTries && hasPendingWal(dbPath); attempt += 1) {
    await wait(200);
  }
  return !hasPendingWal(dbPath);
}

async function waitForCursorVscdbWritable(dbPath, options = {}) {
  return waitForVscdbWritable(dbPath, { ...options, labels: SQLITE_LABELS });
}

async function readCursorAuth(dbPath, options = {}) {
  void options.copyFirst;
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  return withVscdb(dbPath, { readOnly: true, labels: SQLITE_LABELS }, (db) => {
    const values = {};
    for (const key of AUTH_KEYS) {
      const value = getItem(db, key);
      if (value != null) values[key] = asText(value).trim();
    }
    return values;
  });
}

async function writeCursorAuth(dbPath, values, options = {}) {
  if (!dbPath) throw new Error("Cursor state.vscdb path is required");
  const incoming = values || {};
  await withVscdb(dbPath, {
    labels: SQLITE_LABELS,
    timeout: options.timeout ?? getSqliteNativeTiming().switchTimeoutMs,
  }, (db) => {
    ensureItemTable(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const key of AUTH_KEYS) {
        const value = incoming[key];
        if (value == null || value === "") deleteItem(db, key);
        else setItem(db, key, String(value));
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  });
}

async function snapshotVscdb(dbPath) {
  return snapshotItems(dbPath, AUTH_KEYS, SQLITE_LABELS, { timeout: getSqliteNativeTiming().switchTimeoutMs });
}

function restoreVscdbSnapshot(snapshot) {
  restoreItems(snapshot, SQLITE_LABELS);
}

module.exports = {
  AUTH_KEYS,
  SQLITE_LABELS,
  hasPendingWal,
  waitForWalToClear,
  waitForCursorVscdbWritable,
  readCursorAuth,
  writeCursorAuth,
  snapshotVscdb,
  restoreVscdbSnapshot,
};

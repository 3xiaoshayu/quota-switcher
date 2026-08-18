const fs = require("node:fs");
const {
  asBuffer,
  withVscdb,
  snapshotItems,
  restoreItems,
  waitForVscdbWritable,
  getSqliteNativeTiming,
  getItem,
  setItem,
  ensureItemTable,
} = require("./sqlite-native");
const {
  decodeItemTableValue,
  decodeOauthTokenTopic,
  encodeItemTableValue,
  encodeOauthTokenTopic,
} = require("./antigravity-proto");

const OAUTH_ITEM_KEY = "antigravityUnifiedStateSync.oauthToken";

const SQLITE_LABELS = {
  busyMessage: "官方 Antigravity IDE 还在占用登录库，请关掉后再切",
  busyCode: "antigravity_vscdb_busy",
  openMessage: "官方 Antigravity IDE 登录库无法打开",
  openCode: "antigravity_vscdb_open_failed",
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

async function waitForAntigravityVscdbWritable(dbPath, options = {}) {
  return waitForVscdbWritable(dbPath, { ...options, labels: SQLITE_LABELS });
}

function tokenFromRaw(raw) {
  if (!raw) return null;
  const topic = decodeItemTableValue(asBuffer(raw));
  const token = decodeOauthTokenTopic(topic);
  if (!token) return null;
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    expiry_timestamp: token.expiry_timestamp,
    is_gcp_tos: token.is_gcp_tos,
  };
}

async function readAntigravityAuth(dbPath, options = {}) {
  void options.copyFirst;
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  return withVscdb(dbPath, { readOnly: true, labels: SQLITE_LABELS }, (db) => {
    return tokenFromRaw(getItem(db, OAUTH_ITEM_KEY));
  });
}

async function writeAntigravityAuth(dbPath, token, options = {}) {
  if (!dbPath) throw new Error("Antigravity state.vscdb path is required");
  await withVscdb(dbPath, {
    labels: SQLITE_LABELS,
    timeout: options.timeout ?? getSqliteNativeTiming().switchTimeoutMs,
  }, (db) => {
    ensureItemTable(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      const existingRaw = getItem(db, OAUTH_ITEM_KEY);
      const existingTopic = existingRaw ? decodeItemTableValue(asBuffer(existingRaw)) : null;
      const topic = encodeOauthTokenTopic(token, existingTopic);
      setItem(db, OAUTH_ITEM_KEY, encodeItemTableValue(topic));
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  });
}

async function snapshotVscdb(dbPath) {
  return snapshotItems(dbPath, [OAUTH_ITEM_KEY], SQLITE_LABELS, { timeout: getSqliteNativeTiming().switchTimeoutMs });
}

function restoreVscdbSnapshot(snapshot) {
  restoreItems(snapshot, SQLITE_LABELS);
}

module.exports = {
  OAUTH_ITEM_KEY,
  SQLITE_LABELS,
  hasPendingWal,
  waitForWalToClear,
  waitForAntigravityVscdbWritable,
  readAntigravityAuth,
  writeAntigravityAuth,
  snapshotVscdb,
  restoreVscdbSnapshot,
};

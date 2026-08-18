const fs = require("node:fs");
const path = require("node:path");
const { renameWithRetry } = require("./atomic-file");
const { cleanupSqliteCopy, copySqliteForRead, readSqliteBytes } = require("./sqlite-copy");
const {
  decodeItemTableValue,
  decodeOauthTokenTopic,
  encodeItemTableValue,
  encodeOauthTokenTopic,
} = require("./antigravity-proto");

const OAUTH_ITEM_KEY = "antigravityUnifiedStateSync.oauthToken";

let sqlModulePromise = null;

function sqlJsDir() {
  return path.dirname(require.resolve("sql.js"));
}

async function loadSql() {
  if (!sqlModulePromise) {
    const initSqlJs = require("sql.js");
    sqlModulePromise = initSqlJs({
      locateFile: (file) => path.join(sqlJsDir(), file),
    });
  }
  return sqlModulePromise;
}

function asBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), "utf8");
}

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

async function copySqliteForReadLocal(dbPath) {
  return copySqliteForRead(dbPath, "antigravity-vscdb");
}

function cleanupCopy(copyPath) {
  cleanupSqliteCopy(copyPath);
}

async function openDatabase(filePath) {
  const SQL = await loadSql();
  const bytes = await readSqliteBytes(filePath);
  return new SQL.Database(bytes);
}

function readItemValue(db, key) {
  const statement = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
  statement.bind([key]);
  let value = null;
  if (statement.step()) {
    const row = statement.getAsObject();
    value = asBuffer(row.value);
  }
  statement.free();
  return value;
}

async function readAntigravityAuth(dbPath, options = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const copyFirst = options.copyFirst !== false;
  const target = copyFirst ? await copySqliteForReadLocal(dbPath) : dbPath;
  let db = null;
  try {
    db = await openDatabase(target);
    const raw = readItemValue(db, OAUTH_ITEM_KEY);
    if (!raw) return null;
    const topic = decodeItemTableValue(raw);
    const token = decodeOauthTokenTopic(topic);
    if (!token) return null;
    return {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type,
      expiry_timestamp: token.expiry_timestamp,
      is_gcp_tos: token.is_gcp_tos,
    };
  } finally {
    try { db?.close(); } catch {}
    if (copyFirst) cleanupCopy(target);
  }
}

async function writeAntigravityAuth(dbPath, token) {
  if (!dbPath) throw new Error("Antigravity state.vscdb path is required");
  if (hasPendingWal(dbPath)) {
    const error = new Error("官方 Antigravity IDE 还没把登录库写完，请再试一次");
    error.code = "antigravity_vscdb_wal_pending";
    throw error;
  }
  const existed = fs.existsSync(dbPath);
  let db = null;
  try {
    if (existed) db = await openDatabase(dbPath);
    else {
      const SQL = await loadSql();
      db = new SQL.Database();
    }
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    const existingRaw = existed ? readItemValue(db, OAUTH_ITEM_KEY) : null;
    const existingTopic = existingRaw ? decodeItemTableValue(existingRaw) : null;
    const topic = encodeOauthTokenTopic(token, existingTopic);
    const encoded = encodeItemTableValue(topic);
    const insert = db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)");
    insert.run([OAUTH_ITEM_KEY, encoded]);
    insert.free();
    const exported = Buffer.from(db.export());
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const tempPath = `${dbPath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tempPath, exported);
      renameWithRetry(tempPath, dbPath);
      for (const suffix of ["-wal", "-shm"]) {
        const extra = `${dbPath}${suffix}`;
        if (fs.existsSync(extra)) fs.unlinkSync(extra);
      }
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
  } finally {
    try { db?.close(); } catch {}
  }
}

function snapshotVscdb(dbPath) {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const snapshot = {};
  for (const filePath of files) {
    snapshot[filePath] = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  }
  return snapshot;
}

function restoreVscdbSnapshot(snapshot) {
  for (const [filePath, content] of Object.entries(snapshot || {})) {
    if (content == null) {
      try { fs.unlinkSync(filePath); } catch {}
      continue;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

module.exports = {
  OAUTH_ITEM_KEY,
  hasPendingWal,
  waitForWalToClear,
  readAntigravityAuth,
  writeAntigravityAuth,
  snapshotVscdb,
  restoreVscdbSnapshot,
  copySqliteForRead: copySqliteForReadLocal,
};

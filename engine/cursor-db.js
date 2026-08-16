const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { renameWithRetry } = require("./atomic-file");

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

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
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

function copySqliteForRead(dbPath) {
  const dest = path.join(os.tmpdir(), `cursor-vscdb-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  fs.copyFileSync(dbPath, dest);
  for (const suffix of ["-wal", "-shm"]) {
    const extra = `${dbPath}${suffix}`;
    if (fs.existsSync(extra)) fs.copyFileSync(extra, `${dest}${suffix}`);
  }
  return dest;
}

function cleanupCopy(copyPath) {
  for (const target of [copyPath, `${copyPath}-wal`, `${copyPath}-shm`]) {
    try { fs.unlinkSync(target); } catch {}
  }
}

async function openDatabase(filePath) {
  const SQL = await loadSql();
  const bytes = fs.readFileSync(filePath);
  return new SQL.Database(bytes);
}

async function readCursorAuth(dbPath, options = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const copyFirst = options.copyFirst !== false;
  const target = copyFirst ? copySqliteForRead(dbPath) : dbPath;
  let db = null;
  try {
    db = await openDatabase(target);
    const placeholders = AUTH_KEYS.map(() => "?").join(", ");
    const statement = db.prepare(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`);
    statement.bind(AUTH_KEYS);
    const values = {};
    while (statement.step()) {
      const row = statement.getAsObject();
      values[String(row.key)] = asText(row.value).trim();
    }
    statement.free();
    return values;
  } finally {
    try { db?.close(); } catch {}
    if (copyFirst) cleanupCopy(target);
  }
}

async function writeCursorAuth(dbPath, values) {
  if (!dbPath) throw new Error("Cursor state.vscdb path is required");
  if (hasPendingWal(dbPath)) {
    const error = new Error("官方 Cursor 还没把登录库写完，请再试一次");
    error.code = "cursor_vscdb_wal_pending";
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
    const incoming = values || {};
    const insert = db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)");
    const remove = db.prepare("DELETE FROM ItemTable WHERE key = ?");
    for (const key of AUTH_KEYS) {
      const value = incoming[key];
      if (value == null || value === "") remove.run([key]);
      else insert.run([key, String(value)]);
    }
    insert.free();
    remove.free();
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
  AUTH_KEYS,
  hasPendingWal,
  waitForWalToClear,
  readCursorAuth,
  writeCursorAuth,
  snapshotVscdb,
  restoreVscdbSnapshot,
  copySqliteForRead,
};

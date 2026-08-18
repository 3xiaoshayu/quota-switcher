const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const READ_TIMEOUT_MS = 400;
const WRITE_TIMEOUT_MS = 1500;
const SWITCH_TIMEOUT_MS = 8000;
const WAIT_WRITABLE_TIMEOUT_MS = 12000;
const WAIT_WRITABLE_POLL_MS = 200;
const WAIT_WRITABLE_OPEN_TIMEOUT_MS = 50;
const BUSY_RETRIES = 1;
const BUSY_RETRY_WAIT_MS = 200;

const DEFAULT_TIMING = {
  readTimeoutMs: READ_TIMEOUT_MS,
  writeTimeoutMs: WRITE_TIMEOUT_MS,
  switchTimeoutMs: SWITCH_TIMEOUT_MS,
  waitWritableTimeoutMs: WAIT_WRITABLE_TIMEOUT_MS,
  waitWritablePollMs: WAIT_WRITABLE_POLL_MS,
  waitWritableOpenTimeoutMs: WAIT_WRITABLE_OPEN_TIMEOUT_MS,
  busyRetries: BUSY_RETRIES,
  busyRetryWaitMs: BUSY_RETRY_WAIT_MS,
};

let timing = { ...DEFAULT_TIMING };

function getSqliteNativeTiming() {
  return { ...timing };
}

function setSqliteNativeTimingForTests(next = null) {
  timing = next ? { ...DEFAULT_TIMING, ...next } : { ...DEFAULT_TIMING };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyError(error) {
  if (!error) return false;
  const errcode = error.errcode ?? error.errCode ?? error.errno;
  if (errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED) return true;
  const text = `${error.code || ""} ${error.message || ""} ${error.errstr || ""}`;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy|\bEBUSY\b|\bEPERM\b|\bEACCES\b/i.test(text);
}

function isSqliteError(error) {
  if (!error) return false;
  if (isBusyError(error)) return true;
  if (error.code === "ERR_SQLITE_ERROR") return true;
  if (typeof error.errcode === "number") return true;
  return /SQLITE_|not a database|unable to open/i.test(String(error.message || ""));
}

function mapSqliteError(error, labels = {}) {
  const busy = isBusyError(error);
  const mapped = new Error(busy
    ? (labels.busyMessage || "登录库正被占用，请关掉后再试")
    : (labels.openMessage || error.message || "登录库无法打开"));
  mapped.code = busy
    ? (labels.busyCode || "vscdb_busy")
    : (labels.openCode || "vscdb_open_failed");
  mapped.cause = error;
  return mapped;
}

function describeCaughtError(error) {
  if (!error) return "unknown error";
  const parts = [error.stack || error.message || String(error)];
  if (error.code) parts.push(`code=${error.code}`);
  if (error.cause) {
    const cause = error.cause;
    parts.push(`cause=${cause.code || ""} ${cause.message || cause}`);
  }
  return parts.join(" ");
}

function asBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), "utf8");
}

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return asBuffer(value).toString("utf8");
}

function openVscdb(dbPath, options = {}) {
  const readOnly = options.readOnly === true;
  if (readOnly && !fs.existsSync(dbPath)) return null;
  if (!readOnly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const fallbackTimeout = readOnly ? timing.readTimeoutMs : timing.writeTimeoutMs;
  return new DatabaseSync(dbPath, {
    readOnly,
    timeout: options.timeout ?? fallbackTimeout,
  });
}

function ensureItemTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)");
}

function hasItemTable(db) {
  if (!db) return false;
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'").get();
  return !!row;
}

function getItem(db, key) {
  if (!db || !hasItemTable(db)) return null;
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setItem(db, key, value) {
  ensureItemTable(db);
  db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, value);
}

function deleteItem(db, key) {
  if (!hasItemTable(db)) return;
  db.prepare("DELETE FROM ItemTable WHERE key = ?").run(key);
}

function listKeys(db) {
  if (!hasItemTable(db)) return [];
  return db.prepare("SELECT key FROM ItemTable ORDER BY key").all().map((row) => String(row.key));
}

function withVscdbSync(dbPath, options, fn) {
  const db = openVscdb(dbPath, options);
  if (!db) return fn(null);
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch {}
  }
}

async function withVscdb(dbPath, options, fn) {
  const labels = options.labels || {};
  const retries = options.retries ?? timing.busyRetries;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return withVscdbSync(dbPath, options, fn);
    } catch (error) {
      lastError = error;
      if (isBusyError(error) && attempt < retries) {
        await sleep(options.retryWaitMs ?? timing.busyRetryWaitMs);
        continue;
      }
      if (isSqliteError(error)) throw mapSqliteError(error, labels);
      throw error;
    }
  }
  throw mapSqliteError(lastError, labels);
}

function captureItems(db, dbPath, keys) {
  const rows = {};
  for (const key of keys || []) {
    const value = getItem(db, key);
    rows[key] = value == null ? null : asBuffer(value);
  }
  return { dbPath, missing: false, rows };
}

function missingSnapshot(dbPath, keys) {
  return { dbPath, missing: true, rows: Object.fromEntries((keys || []).map((key) => [key, null])) };
}

async function snapshotItems(dbPath, keys, labels, options = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return missingSnapshot(dbPath, keys);
  }
  return withVscdb(dbPath, {
    timeout: options.timeout ?? timing.switchTimeoutMs,
    retries: options.retries ?? timing.busyRetries,
    labels,
  }, (db) => captureItems(db, dbPath, keys));
}

function restoreItems(snapshot, labels) {
  if (!snapshot?.dbPath) return;
  if (snapshot.missing) {
    try { fs.unlinkSync(snapshot.dbPath); } catch {}
    return;
  }
  try {
    withVscdbSync(snapshot.dbPath, {
      timeout: timing.switchTimeoutMs,
      labels,
    }, (db) => {
      ensureItemTable(db);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [key, value] of Object.entries(snapshot.rows || {})) {
          if (value == null) deleteItem(db, key);
          else setItem(db, key, value);
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    });
  } catch (error) {
    throw mapSqliteError(error, labels);
  }
}

function probeWriteLock(dbPath) {
  withVscdbSync(dbPath, { timeout: timing.waitWritableOpenTimeoutMs }, (db) => {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  });
}

async function waitForVscdbWritable(dbPath, options = {}) {
  const labels = options.labels || {};
  const timeoutMs = options.timeoutMs ?? timing.waitWritableTimeoutMs;
  const pollMs = options.pollMs ?? timing.waitWritablePollMs;
  const wait = typeof options.sleep === "function" ? options.sleep : sleep;
  if (!dbPath) return true;
  if (!fs.existsSync(dbPath)) return true;

  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let lastError;
  while (true) {
    try {
      probeWriteLock(dbPath);
      return true;
    } catch (error) {
      lastError = error;
      if (!isBusyError(error)) {
        if (isSqliteError(error)) throw mapSqliteError(error, labels);
        throw error;
      }
      if (Date.now() >= deadline) break;
      await wait(pollMs);
    }
  }
  throw mapSqliteError(lastError || new Error("database is locked"), labels);
}

module.exports = {
  READ_TIMEOUT_MS,
  WRITE_TIMEOUT_MS,
  SWITCH_TIMEOUT_MS,
  WAIT_WRITABLE_TIMEOUT_MS,
  isBusyError,
  isSqliteError,
  mapSqliteError,
  describeCaughtError,
  asBuffer,
  asText,
  openVscdb,
  ensureItemTable,
  hasItemTable,
  getItem,
  setItem,
  deleteItem,
  listKeys,
  withVscdbSync,
  withVscdb,
  snapshotItems,
  restoreItems,
  waitForVscdbWritable,
  getSqliteNativeTiming,
  setSqliteNativeTimingForTests,
};

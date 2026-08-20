const fs = require("node:fs");
const path = require("node:path");

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function uniqueSuffix() {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const TRANSIENT_READ_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EAGAIN", "EMFILE", "ENFILE"]);

function readFileWithRetry(filePath, encoding) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return encoding === undefined ? fs.readFileSync(filePath) : fs.readFileSync(filePath, encoding);
    } catch (error) {
      if (!TRANSIENT_READ_CODES.has(error.code)) throw error;
      lastError = error;
      if (attempt < 2) sleepSync(30 * (attempt + 1));
    }
  }
  lastError.transientIoError = true;
  throw lastError;
}

function statSyncWithRetry(filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return fs.statSync(filePath);
    } catch (error) {
      if (!TRANSIENT_READ_CODES.has(error.code)) throw error;
      lastError = error;
      if (attempt < 2) sleepSync(30 * (attempt + 1));
    }
  }
  lastError.transientIoError = true;
  throw lastError;
}

function hasPendingWalFile(walPath) {
  try {
    return statSyncWithRetry(walPath).size > 32;
  } catch (error) {
    if (error?.transientIoError) return true;
    return false;
  }
}

function readJsonWithRetry(filePath) {
  return JSON.parse(readFileWithRetry(filePath, "utf8"));
}

function captureFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return readFileWithRetry(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Antivirus scanners and the Windows search indexer can briefly hold a handle
// on the target file; retry the swap instead of failing the whole write.
function renameWithRetry(fromPath, toPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(fromPath, toPath);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_CODES.has(error.code)) throw error;
      sleepSync(20 * (attempt + 1));
    }
  }
  throw lastError;
}

function writeTextAtomic(filePath, content, options = {}) {
  const backup = options.backup !== false;
  ensureParent(filePath);
  const tempPath = `${filePath}.tmp.${uniqueSuffix()}`;
  const backupPath = `${filePath}.bak`;
  let descriptor = null;

  try {
    if (backup && fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, backupPath);
    }
    descriptor = fs.openSync(tempPath, "w");
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    renameWithRetry(tempPath, filePath);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function writeJsonAtomic(filePath, value, options = {}) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function quarantineFile(filePath, reason = "invalid") {
  if (!fs.existsSync(filePath)) return null;
  const safeReason = String(reason).replace(/[^a-z0-9_-]+/gi, "-");
  const target = `${filePath}.${safeReason}.${Date.now()}`;
  renameWithRetry(filePath, target);
  return target;
}

function restoreBackup(filePath) {
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(backupPath)) return false;
  const content = readFileWithRetry(backupPath, "utf8");
  writeTextAtomic(filePath, content, { backup: false });
  return true;
}

module.exports = {
  writeTextAtomic,
  writeJsonAtomic,
  readFileWithRetry,
  readJsonWithRetry,
  captureFile,
  hasPendingWalFile,
  quarantineFile,
  restoreBackup,
  renameWithRetry,
  sleepSync,
  statSyncWithRetry,
};

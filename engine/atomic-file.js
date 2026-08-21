const fs = require("node:fs");
const path = require("node:path");

function mkdirSyncWithRetry(dirPath, options = { recursive: true }) {
  return withTransientIoRetry(() => fs.mkdirSync(dirPath, options));
}

function ensureParent(filePath) {
  mkdirSyncWithRetry(path.dirname(filePath));
}

function uniqueSuffix() {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const TRANSIENT_READ_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EAGAIN", "EMFILE", "ENFILE"]);

function withTransientIoRetry(operation, codes = TRANSIENT_READ_CODES) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!codes.has(error.code)) throw error;
      lastError = error;
      if (attempt < 2) sleepSync(30 * (attempt + 1));
    }
  }
  lastError.transientIoError = true;
  throw lastError;
}

function readFileWithRetry(filePath, encoding) {
  return withTransientIoRetry(() => (
    encoding === undefined ? fs.readFileSync(filePath) : fs.readFileSync(filePath, encoding)
  ));
}

function writeFileWithRetry(filePath, content, encoding) {
  return withTransientIoRetry(() => {
    if (encoding === undefined) fs.writeFileSync(filePath, content);
    else fs.writeFileSync(filePath, content, encoding);
  });
}

function appendFileWithRetry(filePath, content, encoding) {
  return withTransientIoRetry(() => {
    if (encoding === undefined) fs.appendFileSync(filePath, content);
    else fs.appendFileSync(filePath, content, encoding);
  });
}

function copyFileWithRetry(fromPath, toPath) {
  return withTransientIoRetry(() => fs.copyFileSync(fromPath, toPath));
}

function unlinkWithRetry(filePath) {
  return withTransientIoRetry(() => fs.unlinkSync(filePath));
}

function unlinkIfPresent(filePath) {
  try {
    unlinkWithRetry(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function statSyncWithRetry(filePath) {
  return withTransientIoRetry(() => fs.statSync(filePath));
}

function readdirSyncWithRetry(dirPath, options) {
  return withTransientIoRetry(() => (
    options === undefined ? fs.readdirSync(dirPath) : fs.readdirSync(dirPath, options)
  ));
}

// Node's existsSync swallows EPERM/EACCES and returns false, so a locked-but-present
// file looks missing. Treat leftover lock errors as "present" so callers retry the real IO.
function pathExists(filePath) {
  try {
    statSyncWithRetry(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.transientIoError) return true;
    throw error;
  }
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
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      // A writer can leave a partial file that parses as SyntaxError for one
      // or two reads. Retry like EPERM, but do not mark a persistently invalid
      // JSON payload as a leftover lock — callers still restore backups.
      const retryable = TRANSIENT_READ_CODES.has(error.code) || error instanceof SyntaxError;
      if (!retryable) throw error;
      lastError = error;
      if (attempt < 2) sleepSync(30 * (attempt + 1));
    }
  }
  if (TRANSIENT_READ_CODES.has(lastError.code)) lastError.transientIoError = true;
  throw lastError;
}

function captureFile(filePath) {
  try {
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
    if (backup) {
      try {
        copyFileWithRetry(filePath, backupPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    descriptor = withTransientIoRetry(() => fs.openSync(tempPath, "w"));
    withTransientIoRetry(() => fs.writeFileSync(descriptor, content, "utf8"));
    withTransientIoRetry(() => fs.fsyncSync(descriptor));
    withTransientIoRetry(() => fs.closeSync(descriptor));
    descriptor = null;
    renameWithRetry(tempPath, filePath);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { unlinkIfPresent(tempPath); } catch {}
    throw error;
  }
}

function restoreCapturedFile(filePath, content) {
  if (content === null) {
    try {
      unlinkWithRetry(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return;
  }
  ensureParent(filePath);
  const tempPath = `${filePath}.rollback.tmp.${uniqueSuffix()}`;
  let descriptor = null;
  try {
    descriptor = withTransientIoRetry(() => fs.openSync(tempPath, "w"));
    withTransientIoRetry(() => fs.writeFileSync(descriptor, content));
    withTransientIoRetry(() => fs.fsyncSync(descriptor));
    withTransientIoRetry(() => fs.closeSync(descriptor));
    descriptor = null;
    renameWithRetry(tempPath, filePath);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { unlinkIfPresent(tempPath); } catch {}
    throw error;
  }
}

function writeJsonAtomic(filePath, value, options = {}) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function quarantineFile(filePath, reason = "invalid") {
  const safeReason = String(reason).replace(/[^a-z0-9_-]+/gi, "-");
  const target = `${filePath}.${safeReason}.${Date.now()}`;
  try {
    renameWithRetry(filePath, target);
    return target;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function restoreBackup(filePath) {
  const backupPath = `${filePath}.bak`;
  try {
    const content = readFileWithRetry(backupPath, "utf8");
    writeTextAtomic(filePath, content, { backup: false });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readJsonWithBackup(filePath) {
  try {
    return readJsonWithRetry(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.transientIoError) throw error;
    if (!(error instanceof SyntaxError)) throw error;
    try {
      const value = readJsonWithRetry(`${filePath}.bak`);
      try { restoreBackup(filePath); } catch {}
      return value;
    } catch {
      throw error;
    }
  }
}

module.exports = {
  writeTextAtomic,
  writeJsonAtomic,
  readFileWithRetry,
  readJsonWithRetry,
  writeFileWithRetry,
  appendFileWithRetry,
  mkdirSyncWithRetry,
  copyFileWithRetry,
  unlinkWithRetry,
  unlinkIfPresent,
  restoreCapturedFile,
  captureFile,
  hasPendingWalFile,
  quarantineFile,
  restoreBackup,
  readJsonWithBackup,
  renameWithRetry,
  sleepSync,
  statSyncWithRetry,
  readdirSyncWithRetry,
  pathExists,
};

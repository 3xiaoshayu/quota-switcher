const path = require("node:path");
const { DATA_DIR } = require("./config");
const { statSyncWithRetry, pathExists, unlinkIfPresent, readdirSyncWithRetry, mkdirSyncWithRetry, appendFileWithRetry } = require("./atomic-file");

const LOG_DIR = path.join(DATA_DIR, "logs");
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
let initialized = false;
let lastCleanupDate = null;

function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain.replace(/^(.).*(\.[^.]+)$/, "$1***$2")}`;
}

function sanitizeMessage(value) {
  let text = value instanceof Error ? value.stack || value.message : String(value ?? "");
  text = text.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  text = text.replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, "[JWT REDACTED]");
  text = text.replace(/(["']?(?:access_token|refresh_token|id_token|code|state)["']?\s*[:=]\s*["']?)[^"',&\s]+/gi, "$1[REDACTED]");
  text = text.replace(/([?&](?:code|state)=)[^&\s]+/gi, "$1[REDACTED]");
  text = text.replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, maskEmail);
  return text;
}

function logDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function currentLogPath(now = new Date()) {
  return path.join(LOG_DIR, `app-${logDate(now)}.log`);
}

function cleanupLogs(now = Date.now()) {
  lastCleanupDate = logDate(new Date(now));
  if (!pathExists(LOG_DIR)) return;
  const cutoff = now - RETENTION_MS;
  for (const name of readdirSyncWithRetry(LOG_DIR)) {
    if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const filePath = path.join(LOG_DIR, name);
    try {
      if (statSyncWithRetry(filePath).mtimeMs < cutoff) unlinkIfPresent(filePath);
    } catch {}
  }
}

function initLogger() {
  if (initialized) return;
  mkdirSyncWithRetry(LOG_DIR);
  cleanupLogs();
  initialized = true;
}

// The app lives in the tray for days. Prune again when the log file rolls to
// a new date instead of only at startup, so retention actually holds.
function pruneOnDateRollover(now) {
  if (lastCleanupDate === logDate(now)) return;
  try { cleanupLogs(now.getTime()); } catch {}
}

function write(level, message) {
  try {
    initLogger();
    const now = new Date();
    pruneOnDateRollover(now);
    const line = `${now.toISOString()} ${level.toUpperCase()} ${sanitizeMessage(message)}\n`;
    appendFileWithRetry(currentLogPath(now), line, "utf8");
  } catch {}
}

function logInfo(message) { write("info", message); }
function logWarn(message) { write("warn", message); }
function logError(message) { write("error", message); }
function getLogDir() { initLogger(); return LOG_DIR; }

module.exports = {
  initLogger,
  cleanupLogs,
  pruneOnDateRollover,
  RETENTION_MS,
  sanitizeMessage,
  logInfo,
  logWarn,
  logError,
  getLogDir,
};

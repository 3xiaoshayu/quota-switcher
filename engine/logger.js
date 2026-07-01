const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("./config");

const LOG_DIR = path.join(DATA_DIR, "logs");
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
let initialized = false;

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

function currentLogPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `app-${date}.log`);
}

function cleanupLogs() {
  if (!fs.existsSync(LOG_DIR)) return;
  const cutoff = Date.now() - RETENTION_MS;
  for (const name of fs.readdirSync(LOG_DIR)) {
    if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const filePath = path.join(LOG_DIR, name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch {}
  }
}

function initLogger() {
  if (initialized) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  cleanupLogs();
  initialized = true;
}

function write(level, message) {
  try {
    initLogger();
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${sanitizeMessage(message)}\n`;
    fs.appendFileSync(currentLogPath(), line, "utf8");
  } catch {}
}

function logInfo(message) { write("info", message); }
function logWarn(message) { write("warn", message); }
function logError(message) { write("error", message); }
function getLogDir() { initLogger(); return LOG_DIR; }

module.exports = {
  initLogger,
  sanitizeMessage,
  logInfo,
  logWarn,
  logError,
  getLogDir,
};

const { CFG_FILE, DATA_DIR, REFRESH_MINUTES } = require("./config");
const { ensureDir } = require("./storage");
const { writeJsonAtomic, quarantineFile, readJsonWithRetry } = require("./atomic-file");
const { logWarn } = require("./logger");

// The background daemon only refreshes Codex logins and quotas now. The file
// keeps its historical name (auto-switch.json) so an upgrade keeps the user's
// interval; the old auto-switch fields are dropped on the next save.
const DEFAULT_DAEMON_CFG = {
  enabled: false,
  sync_interval_minutes: REFRESH_MINUTES,
};

function normalizeSyncIntervalMinutes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return REFRESH_MINUTES;
  return Math.min(60, Math.max(1, Math.round(number)));
}

function normalizeDaemonCfg(cfg) {
  const raw = cfg && typeof cfg === "object" ? cfg : {};
  return {
    enabled: !!raw.enabled,
    sync_interval_minutes: normalizeSyncIntervalMinutes(raw.sync_interval_minutes),
  };
}

function loadDaemonCfg() {
  let primaryError = null;
  try {
    return normalizeDaemonCfg(readJsonWithRetry(CFG_FILE));
  } catch (error) {
    primaryError = error;
  }
  // A missing file is a fresh start (or an intentional reset), not
  // corruption: do not resurrect a stale backup for it.
  if (primaryError.code === "ENOENT") return normalizeDaemonCfg();
  // A leftover lock is also not corruption. Restoring .bak here can flip
  // enabled while the real file is still good.
  if (primaryError.transientIoError) throw primaryError;
  if (primaryError.code && !(primaryError instanceof SyntaxError)) throw primaryError;

  try {
    const restored = normalizeDaemonCfg(readJsonWithRetry(`${CFG_FILE}.bak`));
    try { quarantineFile(CFG_FILE, "invalid-json"); } catch {}
    writeJsonAtomic(CFG_FILE, restored, { backup: false });
    logWarn(`Daemon configuration was restored from backup: ${primaryError.message}`);
    return restored;
  } catch (backupError) {
    if (backupError?.code !== "ENOENT") {
      logWarn(`Daemon configuration backup is also unreadable: ${backupError.message}`);
    }
  }
  try { quarantineFile(CFG_FILE, "invalid-json"); } catch {}
  logWarn(`Daemon configuration was reset to defaults: ${primaryError.message}`);
  return normalizeDaemonCfg();
}

function saveDaemonCfg(cfg) {
  ensureDir(DATA_DIR);
  const next = normalizeDaemonCfg(cfg);
  writeJsonAtomic(CFG_FILE, next);
  return next;
}

module.exports = {
  loadDaemonCfg,
  saveDaemonCfg,
  normalizeDaemonCfg,
  DEFAULT_DAEMON_CFG,
  normalizeSyncIntervalMinutes,
};

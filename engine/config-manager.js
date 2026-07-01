const { CFG_FILE, DATA_DIR, REFRESH_MINUTES } = require("./config");
const { ensureDir } = require("./storage");
const { writeJsonAtomic, restoreBackup, quarantineFile } = require("./atomic-file");
const { logWarn } = require("./logger");

const DEFAULT_AUTO_SWITCH_CFG = {
  enabled: false,
  primary_threshold: 20,
  secondary_threshold: 30,
  account_scope_mode: "all",
  selected_account_ids: [],
  sync_interval_minutes: REFRESH_MINUTES,
};

function normalizeSyncIntervalMinutes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return REFRESH_MINUTES;
  return Math.min(60, Math.max(1, Math.round(number)));
}

function normalizeAutoSwitchCfg(cfg) {
  const next = Object.assign({}, DEFAULT_AUTO_SWITCH_CFG, cfg || {});
  next.sync_interval_minutes = normalizeSyncIntervalMinutes(next.sync_interval_minutes);
  if (next.account_scope_mode !== "selected") next.account_scope_mode = "all";
  if (!Array.isArray(next.selected_account_ids)) next.selected_account_ids = [];
  return next;
}

function loadAutoSwitchCfg() {
  try {
    return normalizeAutoSwitchCfg(JSON.parse(require("node:fs").readFileSync(CFG_FILE, "utf8")));
  } catch (error) {
    try {
      if (restoreBackup(CFG_FILE)) {
        logWarn(`Auto-switch configuration was restored from backup: ${error.message}`);
        return normalizeAutoSwitchCfg(JSON.parse(require("node:fs").readFileSync(CFG_FILE, "utf8")));
      }
      if (require("node:fs").existsSync(CFG_FILE)) quarantineFile(CFG_FILE, "invalid-json");
    } catch {}
    return normalizeAutoSwitchCfg();
  }
}

function saveAutoSwitchCfg(cfg) {
  ensureDir(DATA_DIR);
  writeJsonAtomic(CFG_FILE, normalizeAutoSwitchCfg(cfg));
}

module.exports = { loadAutoSwitchCfg, saveAutoSwitchCfg, DEFAULT_AUTO_SWITCH_CFG, normalizeSyncIntervalMinutes };

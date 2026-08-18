const { CFG_FILE, DATA_DIR, REFRESH_MINUTES } = require("./config");
const { ensureDir } = require("./storage");
const { writeJsonAtomic, quarantineFile } = require("./atomic-file");
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

// The config file is user-editable, so clamp thresholds into the percentage
// range the switch policy expects.
function normalizeThreshold(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function normalizeAutoSwitchCfg(cfg) {
  const next = Object.assign({}, DEFAULT_AUTO_SWITCH_CFG, cfg || {});
  next.enabled = !!next.enabled;
  next.primary_threshold = normalizeThreshold(next.primary_threshold, DEFAULT_AUTO_SWITCH_CFG.primary_threshold);
  next.secondary_threshold = normalizeThreshold(next.secondary_threshold, DEFAULT_AUTO_SWITCH_CFG.secondary_threshold);
  next.sync_interval_minutes = normalizeSyncIntervalMinutes(next.sync_interval_minutes);
  if (next.account_scope_mode !== "selected") next.account_scope_mode = "all";
  next.selected_account_ids = Array.isArray(next.selected_account_ids)
    ? next.selected_account_ids.filter((id) => id != null && String(id).trim() !== "").map(String)
    : [];
  return next;
}

function loadAutoSwitchCfg() {
  const fs = require("node:fs");
  let primaryError = null;
  try {
    return normalizeAutoSwitchCfg(JSON.parse(fs.readFileSync(CFG_FILE, "utf8")));
  } catch (error) {
    primaryError = error;
  }
  // A missing file is a fresh start (or an intentional reset), not
  // corruption: do not resurrect a stale backup for it.
  if (primaryError.code === "ENOENT") return normalizeAutoSwitchCfg();

  try {
    if (fs.existsSync(`${CFG_FILE}.bak`)) {
      // Parse and validate the backup before touching the disk, so a corrupt
      // backup cannot destroy the evidence or masquerade as a recovery.
      const restored = normalizeAutoSwitchCfg(JSON.parse(fs.readFileSync(`${CFG_FILE}.bak`, "utf8")));
      try { quarantineFile(CFG_FILE, "invalid-json"); } catch {}
      writeJsonAtomic(CFG_FILE, restored, { backup: false });
      logWarn(`Auto-switch configuration was restored from backup: ${primaryError.message}`);
      return restored;
    }
  } catch (backupError) {
    logWarn(`Auto-switch configuration backup is also unreadable: ${backupError.message}`);
  }
  try { quarantineFile(CFG_FILE, "invalid-json"); } catch {}
  logWarn(`Auto-switch configuration was reset to defaults: ${primaryError.message}`);
  return normalizeAutoSwitchCfg();
}

function saveAutoSwitchCfg(cfg) {
  ensureDir(DATA_DIR);
  writeJsonAtomic(CFG_FILE, normalizeAutoSwitchCfg(cfg));
}

function remapSelectedAccountIds(fromIds, toId) {
  const extras = [...new Set((fromIds || []).filter(Boolean).map(String))];
  const keeper = String(toId || "").trim();
  if (!extras.length || !keeper) return false;
  const extraSet = new Set(extras);
  const cfg = loadAutoSwitchCfg();
  const next = [];
  const seen = new Set();
  let changed = false;
  for (const id of cfg.selected_account_ids) {
    const mapped = extraSet.has(id) ? keeper : id;
    if (mapped !== id) changed = true;
    if (seen.has(mapped)) {
      changed = true;
      continue;
    }
    seen.add(mapped);
    next.push(mapped);
  }
  if (!changed) return false;
  cfg.selected_account_ids = next;
  saveAutoSwitchCfg(cfg);
  return true;
}

module.exports = { loadAutoSwitchCfg, saveAutoSwitchCfg, remapSelectedAccountIds, DEFAULT_AUTO_SWITCH_CFG, normalizeSyncIntervalMinutes };

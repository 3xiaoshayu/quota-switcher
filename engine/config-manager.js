const { ts } = require("./crypto-utils");
const { CFG_FILE, DATA_DIR } = require("./config");
const { ensureDir } = require("./storage");

const DEFAULT_AUTO_SWITCH_CFG = {
  enabled: false,
  primary_threshold: 20,
  secondary_threshold: 30,
  account_scope_mode: "all",
  selected_account_ids: [],
};

function loadAutoSwitchCfg() {
  try {
    return Object.assign({}, DEFAULT_AUTO_SWITCH_CFG, JSON.parse(require("node:fs").readFileSync(CFG_FILE, "utf8")));
  } catch {
    return Object.assign({}, DEFAULT_AUTO_SWITCH_CFG);
  }
}

function saveAutoSwitchCfg(cfg) {
  ensureDir(DATA_DIR);
  require("node:fs").writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

module.exports = { loadAutoSwitchCfg, saveAutoSwitchCfg, DEFAULT_AUTO_SWITCH_CFG };

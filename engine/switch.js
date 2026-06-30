const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { tsIso, ts } = require("./crypto-utils");
const { CODEX_DIR, CODEX_AUMID } = require("./config");
const { loadIdx, saveIdx, loadAcct, saveAcct, currentAcct } = require("./storage");
const { ensureDir } = require("./storage");

function writeAuthJson(acct) {
  const obj = {
    auth_mode: null,
    OPENAI_API_KEY: null,
    tokens: {
      id_token: acct.tokens.id_token,
      access_token: acct.tokens.access_token,
      refresh_token: acct.tokens.refresh_token || null,
      account_id: acct.account_id,
    },
    last_refresh: tsIso(),
  };
  ensureDir(CODEX_DIR);
  const tmp = path.join(CODEX_DIR, "auth.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, path.join(CODEX_DIR, "auth.json"));
}

function writeProjection(acct) {
  const obj = {
    version: 1, writer: "codex-switch-managed",
    account_id: acct.id, email: acct.email,
    token_generation: acct.token_generation, written_at: ts(),
  };
  const tmp = path.join(CODEX_DIR, "codex_auth_projection.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, path.join(CODEX_DIR, "codex_auth_projection.json"));
}

function clearApiBaseUrl() {
  const cf = path.join(CODEX_DIR, "config.toml");
  if (!fs.existsSync(cf)) return;
  let lines = fs.readFileSync(cf, "utf8").split("\n");
  const flt = lines.filter((l) => !/^\s*(api_base_url|openai_base_url)\s*=/.test(l));
  if (flt.length !== lines.length) fs.writeFileSync(cf, flt.join("\n"), "utf8");
}

function killCodex() {
  try { cp.execSync("taskkill /F /IM Codex.exe >nul 2>&1", { stdio: "ignore", timeout: 10000 }); } catch {}
  try { cp.execSync("taskkill /F /IM node_repl.exe >nul 2>&1", { stdio: "ignore", timeout: 10000 }); } catch {}
  cp.execSync("ping -n 3 127.0.0.1 >nul", { stdio: "ignore", timeout: 5000 });
}

function startCodex() {
  cp.exec('start "" explorer.exe "shell:AppsFolder\\' + CODEX_AUMID + '"', { stdio: "ignore" });
}

function doSwitch(acct) {
  const cur = currentAcct();
  if (cur && cur.id === acct.id) return { already: true, account: acct };

  killCodex();
  const authPath = path.join(CODEX_DIR, "auth.json");
  if (fs.existsSync(authPath)) fs.copyFileSync(authPath, authPath + ".bak");

  clearApiBaseUrl();
  writeAuthJson(acct);
  writeProjection(acct);

  const idx = loadIdx();
  idx.current_account_id = acct.id;
  saveIdx(idx);

  acct.last_used = ts();
  saveAcct(acct);

  startCodex();

  return { already: false, account: acct };
}

module.exports = {
  writeAuthJson, writeProjection, clearApiBaseUrl,
  killCodex, startCodex, doSwitch,
};

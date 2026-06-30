const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR, ACCTS_DIR, IDX_PATH } = require("./config");

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function loadIdx() {
  ensureDir(DATA_DIR);
  try { return JSON.parse(fs.readFileSync(IDX_PATH, "utf8")); }
  catch { return { version: "2.0", accounts: [], current_account_id: null }; }
}

function saveIdx(idx) {
  const tmp = IDX_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, IDX_PATH);
}

function loadAcct(id) {
  const f = path.join(ACCTS_DIR, id + ".json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch { return null; }
}

function saveAcct(a) {
  ensureDir(ACCTS_DIR);
  const f = path.join(ACCTS_DIR, a.id + ".json");
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(a, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, f);
}

function deleteAcct(id) {
  const f = path.join(ACCTS_DIR, id + ".json");
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

function listAccts() {
  ensureDir(ACCTS_DIR);
  const r = [];
  if (!fs.existsSync(ACCTS_DIR)) return r;
  for (const f of fs.readdirSync(ACCTS_DIR)) {
    if (!f.startsWith("codex_") || !f.endsWith(".json") || f.endsWith(".bak")) continue;
    try { r.push(JSON.parse(fs.readFileSync(path.join(ACCTS_DIR, f), "utf8"))); } catch {}
  }
  r.sort((a, b) => (b.last_used || 0) - (a.last_used || 0));
  return r;
}

function currentAcct() {
  const idx = loadIdx();
  if (!idx.current_account_id) return null;
  return loadAcct(idx.current_account_id);
}

module.exports = { ensureDir, loadIdx, saveIdx, loadAcct, saveAcct, deleteAcct, listAccts, currentAcct };

const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR, ACCTS_DIR, IDX_PATH } = require("./config");

let secretCodec = null;

function setSecretCodec(codec) {
  if (!codec || typeof codec.encrypt !== "function" || typeof codec.decrypt !== "function") {
    throw new TypeError("Invalid account secret codec");
  }
  secretCodec = codec;
}

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
  try { return decodeAccount(JSON.parse(fs.readFileSync(f, "utf8")), f); }
  catch { return null; }
}

function saveAcct(a) {
  ensureDir(ACCTS_DIR);
  const f = path.join(ACCTS_DIR, a.id + ".json");
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(encodeAccount(a), null, 2) + "\n", "utf8");
  fs.renameSync(tmp, f);
}

function encodeAccount(account) {
  if (!secretCodec) throw new Error("Account encryption is not initialized");
  const copy = { ...account };
  const tokens = copy.tokens || {};
  delete copy.tokens;
  delete copy.tokens_encrypted;
  return {
    ...copy,
    storage_version: 3,
    token_protection: secretCodec.name || "os-protected",
    tokens_encrypted: secretCodec.encrypt(JSON.stringify(tokens)),
  };
}

function decodeAccount(raw, filePath) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.tokens_encrypted) {
    if (!secretCodec) throw new Error("Account encryption is not initialized");
    return {
      ...raw,
      tokens: JSON.parse(secretCodec.decrypt(raw.tokens_encrypted)),
    };
  }

  if (raw.tokens) {
    if (!secretCodec) throw new Error("Account encryption is not initialized");
    const migrated = { ...raw };
    saveAcct(migrated);
    return migrated;
  }

  throw new Error(`Account file has no token payload: ${filePath}`);
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
    try {
      const fullPath = path.join(ACCTS_DIR, f);
      const account = decodeAccount(JSON.parse(fs.readFileSync(fullPath, "utf8")), fullPath);
      if (account) r.push(account);
    } catch {}
  }
  r.sort((a, b) => (b.last_used || 0) - (a.last_used || 0));
  return r;
}

function currentAcct() {
  const idx = loadIdx();
  if (!idx.current_account_id) return null;
  return loadAcct(idx.current_account_id);
}

module.exports = { setSecretCodec, ensureDir, loadIdx, saveIdx, loadAcct, saveAcct, deleteAcct, listAccts, currentAcct };

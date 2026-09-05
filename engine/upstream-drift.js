// Detects when an official client changed the on-disk login format this
// manager depends on, so the window can say "the official format changed"
// up front instead of failing halfway through a switch.
//
// Every check is read-only and tolerant: a locked or missing file is
// "unknown" or "signed_out", never "drift". Only a file that clearly exists,
// parses, and carries none of the fields we know is reported as drift.
const { pathExists, readJsonWithBackup } = require("./atomic-file");
const { withVscdb, listKeys, hasItemTable, getItem, asBuffer } = require("./sqlite-native");
const { AUTH_KEYS: CURSOR_AUTH_KEYS, SQLITE_LABELS: CURSOR_LABELS } = require("./cursor-db");
const { OAUTH_ITEM_KEY, SQLITE_LABELS: ANTIGRAVITY_LABELS } = require("./antigravity-db");
const { decodeItemTableValue, decodeOauthTokenTopic } = require("./antigravity-proto");
const { AUTH_PATH } = require("./auth-state");

const CURSOR_PREFIXES = ["cursorAuth/", "cursor."];
const ANTIGRAVITY_PREFIX = OAUTH_ITEM_KEY.slice(0, OAUTH_ITEM_KEY.indexOf(".") + 1);
const CODEX_KNOWN_TOP_LEVEL = new Set([
  "tokens",
  "last_refresh",
  "OPENAI_API_KEY",
  "auth_mode",
  "agent_identity",
  "agentIdentity",
  "account_id",
]);
const SAMPLE_LIMIT = 4;

function result(status, detail = null, sample = []) {
  return { status, detail, sample: sample.slice(0, SAMPLE_LIMIT) };
}

function sampleText(keys) {
  return keys.slice(0, SAMPLE_LIMIT).join(", ") + (keys.length > SAMPLE_LIMIT ? " …" : "");
}

// keys: every ItemTable key, or null when the database has no ItemTable.
function classifyCursorKeys(keys) {
  if (!Array.isArray(keys)) return result("drift", "官方 Cursor 的登录库里没有 ItemTable 表");
  if (keys.includes("cursorAuth/accessToken")) return result("ok");
  const known = new Set(CURSOR_AUTH_KEYS);
  const unknown = keys.filter((key) => CURSOR_PREFIXES.some((prefix) => key.startsWith(prefix)) && !known.has(key));
  if (unknown.length) {
    return result("drift", `官方 Cursor 的登录键名变了，只认得的键都不在，多出：${sampleText(unknown)}`, unknown);
  }
  return result("signed_out");
}

// decoded: undefined when the item is absent, null when it did not decode,
// otherwise the token object we read.
function classifyAntigravityItem(keys, decoded) {
  if (!Array.isArray(keys)) return result("drift", "官方 Antigravity IDE 的登录库里没有 ItemTable 表");
  if (keys.includes(OAUTH_ITEM_KEY)) {
    if (decoded && (decoded.access_token || decoded.refresh_token)) return result("ok");
    return result("drift", `官方 Antigravity IDE 的 ${OAUTH_ITEM_KEY} 编码变了，读不出令牌`);
  }
  const siblings = keys.filter((key) => key.startsWith(ANTIGRAVITY_PREFIX));
  if (siblings.length) {
    return result("drift", `官方 Antigravity IDE 的登录键名变了，${OAUTH_ITEM_KEY} 不在，同组有：${sampleText(siblings)}`, siblings);
  }
  return result("signed_out");
}

// value: parsed auth.json, or null when the file is missing or not JSON.
function classifyCodexAuthValue(value) {
  if (value == null) return result("signed_out");
  if (typeof value !== "object" || Array.isArray(value)) {
    return result("drift", "官方 Codex 的 auth.json 不再是一个对象");
  }
  const tokens = value.tokens && typeof value.tokens === "object" ? value.tokens : null;
  if (tokens && (tokens.access_token || tokens.id_token)) return result("ok");
  if (value.agent_identity || value.agentIdentity) return result("unsupported", "官方 Codex 当前是 Agent 身份");
  if (value.OPENAI_API_KEY || String(value.auth_mode || "").toLowerCase() === "apikey") {
    return result("unsupported", "官方 Codex 当前用的是 API Key 登录");
  }
  const keys = Object.keys(value);
  if (!keys.length) return result("signed_out");
  const unknown = keys.filter((key) => !CODEX_KNOWN_TOP_LEVEL.has(key));
  if (tokens || !unknown.length) return result("signed_out");
  return result("drift", `官方 Codex 的 auth.json 里没有认识的字段，只有：${sampleText(unknown)}`, unknown);
}

async function readKeysAndItem(dbPath, labels, itemKey) {
  return withVscdb(dbPath, { readOnly: true, labels }, (db) => {
    if (!db || !hasItemTable(db)) return { keys: null, raw: null };
    const keys = listKeys(db);
    const raw = itemKey ? getItem(db, itemKey) : null;
    return { keys, raw: raw == null ? null : Buffer.from(asBuffer(raw)) };
  });
}

async function inspectCursorFormat(dbPath) {
  if (!dbPath || !pathExists(dbPath)) return result("signed_out");
  try {
    const { keys } = await readKeysAndItem(dbPath, CURSOR_LABELS, null);
    return classifyCursorKeys(keys);
  } catch (error) {
    return result("unknown", error?.message || String(error));
  }
}

async function inspectAntigravityFormat(dbPath) {
  if (!dbPath || !pathExists(dbPath)) return result("signed_out");
  try {
    const { keys, raw } = await readKeysAndItem(dbPath, ANTIGRAVITY_LABELS, OAUTH_ITEM_KEY);
    let decoded;
    if (raw) {
      try {
        decoded = decodeOauthTokenTopic(decodeItemTableValue(raw)) || null;
      } catch {
        decoded = null;
      }
    }
    return classifyAntigravityItem(keys, decoded);
  } catch (error) {
    return result("unknown", error?.message || String(error));
  }
}

function inspectCodexFormat(authPath = AUTH_PATH) {
  if (!authPath || !pathExists(authPath)) return result("signed_out");
  let value;
  try {
    value = readJsonWithBackup(authPath);
  } catch (error) {
    if (error instanceof SyntaxError) return result("drift", "官方 Codex 的 auth.json 不是 JSON");
    return result("unknown", error?.message || String(error));
  }
  return classifyCodexAuthValue(value);
}

module.exports = {
  classifyCursorKeys,
  classifyAntigravityItem,
  classifyCodexAuthValue,
  inspectCursorFormat,
  inspectAntigravityFormat,
  inspectCodexFormat,
};

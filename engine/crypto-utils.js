const crypto = require("node:crypto");
const { TOKEN_SKEW_SEC } = require("./config");

function b64url(len) {
  return crypto.randomBytes(len).toString("base64url");
}

function sha256hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function codeChallenge(v) {
  return crypto.createHash("sha256").update(v).digest("base64url");
}

function ts() {
  return Math.floor(Date.now() / 1000);
}

function tsIso() {
  const d = new Date();
  const ms = Date.now() % 1000;
  return d.toISOString().replace(/\.\d{3}Z$/, "." + String(ms).padStart(6, "0") + "Z");
}

function buildId(email, aid, oid) {
  return "codex_" + sha256hex(`${(email || "").toLowerCase()}|${aid || ""}|${oid || ""}`).slice(0, 32);
}

function buildCursorId(email, authId) {
  return "cursor_" + sha256hex(`${(email || "").toLowerCase()}|${authId || ""}`).slice(0, 32);
}

function buildAntigravityId(email, authId) {
  return "antigravity_" + sha256hex(`${(email || "").toLowerCase()}|${authId || ""}`).slice(0, 32);
}

function extractCursorWorkosUserId(accessToken) {
  const payload = jwtPayload(accessToken);
  const sub = String(payload?.sub || "").trim();
  if (!sub) return null;
  const parts = sub.split("|");
  const last = String(parts[parts.length - 1] || "").trim();
  if (last.startsWith("user_")) return last;
  if (sub.startsWith("user_")) return sub;
  return null;
}

function jwtPayload(tok) {
  try {
    const parts = tok.split(".");
    if (parts.length !== 3) return null;
    const b = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b + "=".repeat((4 - (b.length % 4)) % 4), "base64").toString("utf8"));
  } catch { return null; }
}

function jwtExp(tok) {
  const p = jwtPayload(tok);
  return p && p.exp ? Number(p.exp) : null;
}

function isExpiryStale(exp, now = ts()) {
  const value = Number(exp);
  if (!Number.isFinite(value) || value <= 0) return true;
  return value < now + TOKEN_SKEW_SEC;
}

function isTokenExpired(accessToken) {
  return isExpiryStale(jwtExp(accessToken));
}

function authClaim(token) {
  const p = jwtPayload(token);
  return p ? (p["https://api.openai.com/auth"] || {}) : null;
}

function extractChatgptAccountId(accessToken) {
  const ad = authClaim(accessToken);
  if (!ad) return null;
  // Newer tokens use chatgpt_account_id; older ones use account_id.
  const id = ad.chatgpt_account_id || ad.account_id;
  return id ? String(id) : null;
}

const ORG_ID_KEYS = ["organization_id", "chatgpt_organization_id", "chatgpt_org_id", "org_id", "poid", "POID"];

function extractChatgptOrganizationId(token) {
  const ad = authClaim(token);
  if (!ad) return null;
  for (const key of ORG_ID_KEYS) {
    const value = ad[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  const organizations = Array.isArray(ad.organizations) ? ad.organizations : [];
  const chosen = organizations.find((org) => org && org.is_default) || organizations[0];
  return chosen?.id ? String(chosen.id) : null;
}

module.exports = {
  b64url, sha256hex, codeChallenge, ts, tsIso, buildId, buildCursorId, buildAntigravityId,
  jwtPayload, jwtExp, isExpiryStale, isTokenExpired, extractChatgptAccountId, extractChatgptOrganizationId,
  extractCursorWorkosUserId,
};

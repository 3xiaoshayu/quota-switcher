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

function isTokenExpired(accessToken) {
  const exp = jwtExp(accessToken);
  if (!exp) return true;
  return exp < ts() + TOKEN_SKEW_SEC;
}

function extractChatgptAccountId(accessToken) {
  const p = jwtPayload(accessToken);
  if (!p) return null;
  const ad = p["https://api.openai.com/auth"] || {};
  return ad.account_id ? String(ad.account_id) : null;
}

module.exports = {
  b64url, sha256hex, codeChallenge, ts, tsIso, buildId,
  jwtPayload, jwtExp, isTokenExpired, extractChatgptAccountId,
};

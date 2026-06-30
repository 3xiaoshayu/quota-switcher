const http = require("node:http");
const https = require("node:https");
const { REFRESH_TIMEOUT } = require("./config");

function httpJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const headers = Object.assign(
      { "Content-Type": "application/json", "Accept": "application/json" },
      opts.headers || {}
    );
    const timeout = opts.timeout || REFRESH_TIMEOUT;
    const req = mod.request(url, { method: opts.method || "GET", headers, timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
    req.on("error", reject);
    if (opts.body) req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

function buildCodexHeaders(acct) {
  const { extractChatgptAccountId } = require("./crypto-utils");
  const headers = {
    "Authorization": "Bearer " + acct.tokens.access_token,
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": "https://chatgpt.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "OpenAI-Beta": "codex-1",
    "originator": "Codex Desktop",
  };
  const aid = acct.account_id || extractChatgptAccountId(acct.tokens.access_token);
  if (aid) headers["ChatGPT-Account-Id"] = aid;
  return headers;
}

function extractErrorCode(body) {
  try {
    const v = JSON.parse(body);
    if (v.error && typeof v.error === "object") return v.error.code || null;
    if (v.error && typeof v.error === "string") return v.error;
    if (v.code) return String(v.code);
    return null;
  } catch { return null; }
}

function isTokenRevoked(body) {
  const code = extractErrorCode(body);
  return code === "token_revoked" || code === "token_invalidated" ||
    body.includes("token_revoked") || body.includes("token_invalidated");
}

module.exports = { httpJson, buildCodexHeaders, extractErrorCode, isTokenRevoked };

const http = require("node:http");
const https = require("node:https");
const { ProxyAgent } = require("proxy-agent");
const { getProxyForUrl: getEnvProxyForUrl } = require("proxy-from-env");
const { REFRESH_TIMEOUT } = require("./config");

let sharedProxyAgent = null;

function toHeaderObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function normalizeProxyRule(rule) {
  if (!rule) return "";
  const first = String(rule)
    .split(";")
    .map((item) => item.trim())
    .find((item) => item && !/^direct$/i.test(item));
  if (!first) return "";

  if (/^(https?|socks4a?|socks5h?|socks5?|pac\+)/i.test(first)) {
    return first;
  }

  const match = first.match(/^([a-z]+)\s+(.+)$/i);
  if (!match) return `http://${first}`;

  const type = match[1].toUpperCase();
  const target = match[2].trim();
  if (!target) return "";

  if (type === "PROXY" || type === "HTTP") return `http://${target}`;
  if (type === "HTTPS") return `https://${target}`;
  if (type === "SOCKS" || type === "SOCKS5") return `socks5://${target}`;
  if (type === "SOCKS4") return `socks4://${target}`;
  return "";
}

async function getElectronProxyForUrl(url) {
  try {
    const electron = require("electron");
    const defaultSession = electron?.session?.defaultSession;
    if (!defaultSession?.resolveProxy) return "";
    return normalizeProxyRule(await defaultSession.resolveProxy(url));
  } catch {
    return "";
  }
}

async function resolveProxyForUrl(url) {
  const envProxy = getEnvProxyForUrl(url);
  if (envProxy) return envProxy;
  return getElectronProxyForUrl(url);
}

function getProxyAgent() {
  if (!sharedProxyAgent) {
    sharedProxyAgent = new ProxyAgent({ getProxyForUrl: resolveProxyForUrl });
  }
  return sharedProxyAgent;
}

async function electronHttpJson(url, opts, headers, timeout) {
  let fetchFn = null;
  try {
    const electron = require("electron");
    fetchFn = electron?.net?.fetch;
  } catch {
    return null;
  }
  if (typeof fetchFn !== "function") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetchFn(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined,
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      status: response.status,
      headers: toHeaderObject(response.headers),
      body,
    };
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function nodeHttpJson(url, opts, headers, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const agent = getProxyAgent();
    const req = mod.request(url, { method: opts.method || "GET", headers, timeout, agent }, (res) => {
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

async function httpJson(url, opts = {}) {
  const headers = Object.assign(
    { "Content-Type": "application/json", "Accept": "application/json" },
    opts.headers || {}
  );
  const timeout = opts.timeout || REFRESH_TIMEOUT;

  const electronResult = await electronHttpJson(url, opts, headers, timeout);
  if (electronResult) return electronResult;

  return nodeHttpJson(url, opts, headers, timeout);
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

const http = require("node:http");
const https = require("node:https");
const { ProxyAgent } = require("proxy-agent");
const { getProxyForUrl: getEnvProxyForUrl } = require("proxy-from-env");
const { REFRESH_TIMEOUT } = require("./config");

let sharedProxyAgent = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  if (!error) return "unknown error";
  const code = error.code || error.name || "";
  const message = error.message || String(error);
  return code ? `${code}: ${message}` : message;
}

function asError(error) {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isTransientNetworkError(error) {
  const text = errorMessage(error).toLowerCase();
  return text.includes("socket") ||
    text.includes("tls") ||
    text.includes("timeout") ||
    text.includes("请求超时") ||
    text.includes("econnreset") ||
    text.includes("econnaborted") ||
    text.includes("etimedout") ||
    text.includes("err_connection") ||
    text.includes("err_network") ||
    text.includes("network");
}

async function withOneRetry(label, task) {
  try {
    return await task();
  } catch (firstError) {
    if (!isTransientNetworkError(firstError)) throw firstError;
    await delay(500);
    try {
      return await task();
    } catch (secondError) {
      const retryError = asError(secondError);
      retryError.message = `${label} failed after retry: ${errorMessage(retryError)}; first error: ${errorMessage(firstError)}`;
      throw retryError;
    }
  }
}

function buildNetworkFailure(url, attempts) {
  const host = (() => {
    try { return new URL(url).host; } catch { return url; }
  })();
  const details = attempts
    .map((attempt) => `${attempt.label}: ${errorMessage(attempt.error)}`)
    .join(" | ");
  return new Error(
    `网络请求失败 (${host})。已尝试可用网络栈。` +
    `如果正在使用代理/TUN，请确认它允许 Codex Account Manager 访问 OpenAI。详情：${details}`,
  );
}

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
  // Non-idempotent requests (OAuth token refresh, code exchange) must never
  // be replayed: after a timeout the server may already have processed them,
  // and replaying a rotated refresh token or consumed code kills the account.
  const idempotent = opts.idempotent !== false;

  const attempts = [];
  try {
    const runElectron = () => electronHttpJson(url, opts, headers, timeout);
    const electronResult = idempotent
      ? await withOneRetry("Electron network", runElectron)
      : await runElectron();
    if (electronResult) return electronResult;
    // A null result means the Electron stack is unavailable and nothing was
    // sent yet, so the Node attempt below is a first attempt, not a replay.
  } catch (error) {
    attempts.push({ label: "Electron", error });
    if (!idempotent) throw buildNetworkFailure(url, attempts);
  }

  try {
    const runNode = () => nodeHttpJson(url, opts, headers, timeout);
    return idempotent
      ? await withOneRetry("Node network", runNode)
      : await runNode();
  } catch (error) {
    attempts.push({ label: "Node", error });
    throw buildNetworkFailure(url, attempts);
  }
}

function buildCodexHeaders(acct) {
  const { extractChatgptAccountId } = require("./crypto-utils");
  // The chatgpt.com backend only needs the bearer token plus the account id;
  // browser-imitation headers are no longer required by the upstream API.
  const headers = {
    "Authorization": "Bearer " + acct.tokens.access_token,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  const aid = acct.account_id || extractChatgptAccountId(acct.tokens.access_token);
  if (aid) headers["ChatGPT-Account-Id"] = aid;
  return headers;
}

function extractErrorCode(body) {
  try {
    const v = JSON.parse(body);
    if (v.detail && typeof v.detail === "object" && v.detail.code) return String(v.detail.code);
    if (v.error && typeof v.error === "object") return v.error.code || null;
    if (v.error && typeof v.error === "string") return v.error;
    if (v.code) return String(v.code);
    return null;
  } catch { return null; }
}

module.exports = { httpJson, buildCodexHeaders, extractErrorCode };

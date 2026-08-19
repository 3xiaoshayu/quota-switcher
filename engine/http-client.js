const http = require("node:http");
const https = require("node:https");
const { ProxyAgent } = require("proxy-agent");
const { REFRESH_TIMEOUT } = require("./config");
const { resolveLiveProxy, invalidateLiveProxy, hostLooksPoisoned, applySignatureToRuntime } = require("./proxy-resolve");

const MAX_JSON_BODY_BYTES = 1024 * 1024;

const agentsBySignature = new Map();
let httpJsonTransport = null;

function tooLargeError() {
  const error = new Error("响应过大");
  error.code = "response_too_large";
  return error;
}

function concatUtf8Capped(chunks, maxBytes = MAX_JSON_BODY_BYTES) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  if (total > maxBytes) throw tooLargeError();
  return Buffer.concat(chunks).toString("utf8");
}

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
  return new Error(`网络请求失败 (${host})。详情：${details}`);
}

function agentCacheKey(signature, protocol) {
  return `${protocol || "https:"}|${signature?.proxyUrl || "__direct__"}`;
}

function getAgentForSignature(signature = null, protocol = "https:") {
  const key = agentCacheKey(signature, protocol);
  const hit = agentsBySignature.get(key);
  if (hit) return hit;
  const proxyUrl = signature?.proxyUrl || "";
  const keepAlive = { keepAlive: true, maxSockets: 8 };
  const agent = proxyUrl
    ? new ProxyAgent({ getProxyForUrl: () => proxyUrl, keepAlive: true })
    : protocol === "http:"
      ? new http.Agent(keepAlive)
      : new https.Agent(keepAlive);
  agentsBySignature.set(key, agent);
  return agent;
}

function resetHttpAgentsForTests() {
  for (const agent of agentsBySignature.values()) {
    try { if (typeof agent.destroy === "function") agent.destroy(); } catch {}
  }
  agentsBySignature.clear();
}

function setHttpJsonTransport(transport) {
  httpJsonTransport = typeof transport === "function" ? transport : null;
}

function getHttpJsonTransport() {
  return httpJsonTransport;
}

function nodeHttpJson(url, opts, headers, timeout, signature = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const agent = getAgentForSignature(signature, u.protocol);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = mod.request(url, { method: opts.method || "GET", headers, timeout, agent }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_JSON_BODY_BYTES) {
          req.destroy();
          finish(reject, tooLargeError());
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          finish(resolve, { status: res.statusCode, headers: res.headers, body: concatUtf8Capped(chunks) });
        } catch (error) {
          finish(reject, error);
        }
      });
    });
    req.on("timeout", () => { req.destroy(); finish(reject, new Error("请求超时")); });
    req.on("error", (error) => finish(reject, error));
    if (opts.body) req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

async function httpJsonLocal(url, opts = {}) {
  const headers = Object.assign(
    { "Content-Type": "application/json", "Accept": "application/json" },
    opts.headers || {}
  );
  const timeout = opts.timeout || REFRESH_TIMEOUT;
  const idempotent = opts.idempotent !== false;
  const host = (() => { try { return new URL(url).host; } catch { return "unknown"; } })();
  const signature = await resolveLiveProxy(url);
  await applySignatureToRuntime(signature, { touchSession: false });
  if (!signature.proxyUrl && await hostLooksPoisoned(host)) {
    throw new Error(`网络请求失败 (${host})。本机 DNS 异常且没有可用的本地代理。`);
  }

  // Never use Chromium net.fetch here. It shares the UI session and a bad
  // Content-Length / hijack page freezes the main window as 未响应.
  const attempts = [];
  try {
    const runNode = () => nodeHttpJson(url, opts, headers, timeout, signature);
    return idempotent
      ? await withOneRetry("Node network", runNode)
      : await runNode();
  } catch (error) {
    attempts.push({ label: "Node", error });
    invalidateLiveProxy();
    const retrySignature = await resolveLiveProxy(url);
    if (idempotent && retrySignature.proxyUrl && retrySignature.proxyUrl !== signature.proxyUrl) {
      await applySignatureToRuntime(retrySignature, { touchSession: false });
      try {
        return await withOneRetry("Node network", () => nodeHttpJson(url, opts, headers, timeout, retrySignature));
      } catch (retryError) {
        attempts.push({ label: "Node-retry", error: retryError });
      }
    }
    throw buildNetworkFailure(url, attempts);
  }
}

async function httpJson(url, opts = {}) {
  if (httpJsonTransport) {
    try {
      return await httpJsonTransport(url, opts);
    } catch (error) {
      if (error && error.code === "engine_worker_down") return httpJsonLocal(url, opts);
      throw error;
    }
  }
  return httpJsonLocal(url, opts);
}

function buildCodexHeaders(acct) {
  const { extractChatgptAccountId } = require("./crypto-utils");
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

module.exports = {
  httpJson,
  httpJsonLocal,
  setHttpJsonTransport,
  getHttpJsonTransport,
  buildCodexHeaders,
  extractErrorCode,
  MAX_JSON_BODY_BYTES,
  concatUtf8Capped,
  nodeHttpJson,
  getAgentForSignature,
  resetHttpAgentsForTests,
};

const http = require("node:http");
const https = require("node:https");
const { ProxyAgent } = require("proxy-agent");
const { REFRESH_TIMEOUT } = require("./config");
const { resolveLiveProxy, invalidateLiveProxy, hostLooksPoisoned, applySignatureToRuntime } = require("./proxy-resolve");

const MAX_JSON_BODY_BYTES = 1024 * 1024;

let sharedProxyAgent = null;

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

function toHeaderObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function resolveProxyForUrl(url) {
  const signature = await resolveLiveProxy(url);
  return signature.proxyUrl || "";
}

function getProxyAgent() {
  if (!sharedProxyAgent) {
    sharedProxyAgent = new ProxyAgent({ getProxyForUrl: resolveProxyForUrl });
  }
  return sharedProxyAgent;
}

async function readResponseUtf8Capped(response, maxBytes = MAX_JSON_BODY_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (typeof response.body?.cancel === "function") {
      try { await response.body.cancel(); } catch { /* already closed */ }
    }
    throw tooLargeError();
  }
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const size = value ? value.byteLength : 0;
      total += size;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw tooLargeError();
      }
      if (value) chunks.push(Buffer.from(value));
    }
    return concatUtf8Capped(chunks, maxBytes);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw tooLargeError();
  return text;
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
    const body = await readResponseUtf8Capped(response);
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

async function httpJson(url, opts = {}) {
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
    const runNode = () => nodeHttpJson(url, opts, headers, timeout);
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
        return await withOneRetry("Node network", () => nodeHttpJson(url, opts, headers, timeout));
      } catch (retryError) {
        attempts.push({ label: "Node-retry", error: retryError });
      }
    }
    throw buildNetworkFailure(url, attempts);
  }
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
  buildCodexHeaders,
  extractErrorCode,
  MAX_JSON_BODY_BYTES,
  concatUtf8Capped,
  nodeHttpJson,
};

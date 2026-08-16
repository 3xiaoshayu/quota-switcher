const http = require("node:http");
const https = require("node:https");
const { ProxyAgent } = require("proxy-agent");
const { REFRESH_TIMEOUT } = require("./config");
const { resolveLiveProxy, invalidateLiveProxy, hostLooksPoisoned, applySignatureToRuntime } = require("./proxy-resolve");

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
  const idempotent = opts.idempotent !== false;
  const host = (() => { try { return new URL(url).host; } catch { return "unknown"; } })();
  const signature = await resolveLiveProxy(url);
  await applySignatureToRuntime(signature);
  if (!signature.proxyUrl && await hostLooksPoisoned(host)) {
    throw new Error(`网络请求失败 (${host})。本机 DNS 异常且没有可用的本地代理。`);
  }

  const attempts = [];
  try {
    const runElectron = () => electronHttpJson(url, opts, headers, timeout);
    const electronResult = (idempotent && !signature.proxyUrl)
      ? await withOneRetry("Electron network", runElectron)
      : await runElectron();
    if (electronResult) return electronResult;
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
    invalidateLiveProxy();
    const retrySignature = await resolveLiveProxy(url);
    if (idempotent && retrySignature.proxyUrl && retrySignature.proxyUrl !== signature.proxyUrl) {
      await applySignatureToRuntime(retrySignature);
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

module.exports = { httpJson, buildCodexHeaders, extractErrorCode };

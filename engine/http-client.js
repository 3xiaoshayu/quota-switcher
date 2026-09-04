const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const { ProxyAgent } = require("proxy-agent");
const { REFRESH_TIMEOUT } = require("./config");
function proxyResolve() {
  return require("./proxy-resolve");
}

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

function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function looksLikeGzip(buf) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function contentEncoding(headers) {
  const raw = headers?.["content-encoding"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first || "").toLowerCase().split(",")[0].trim();
}

function decodeHttpBody(headers, chunks) {
  const encoding = contentEncoding(headers);
  const raw = Buffer.concat(chunks);
  if (raw.length > MAX_JSON_BODY_BYTES) throw tooLargeError();
  const sniffGzip = (!encoding || encoding === "identity") && looksLikeGzip(raw);
  if ((!encoding || encoding === "identity") && !sniffGzip) {
    return stripUtf8Bom(concatUtf8Capped(chunks));
  }
  let out = null;
  try {
    if (encoding === "gzip" || encoding === "x-gzip" || sniffGzip) {
      out = zlib.gunzipSync(raw);
    } else if (encoding === "deflate") {
      try {
        out = zlib.inflateSync(raw);
      } catch {
        out = zlib.inflateRawSync(raw);
      }
    } else {
      return stripUtf8Bom(concatUtf8Capped(chunks));
    }
  } catch (error) {
    const failed = new Error("响应解压失败");
    failed.code = "response_decode_failed";
    failed.cause = error;
    throw failed;
  }
  if (out.length > MAX_JSON_BODY_BYTES) throw tooLargeError();
  return stripUtf8Bom(out.toString("utf8"));
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
    text.includes("enotfound") ||
    text.includes("eai_again") ||
    text.includes("enetunreach") ||
    text.includes("ehostunreach") ||
    text.includes("eaddrnotavail") ||
    text.includes("enetdown") ||
    text.includes("ehostdown") ||
    text.includes("epipe") ||
    text.includes("und_err") ||
    text.includes("err_connection") ||
    text.includes("err_network") ||
    text.includes("network");
}

function isUnreachableProxyError(error) {
  const text = errorMessage(error).toLowerCase();
  return text.includes("econnrefused")
    || text.includes("enotfound")
    || text.includes("eai_again")
    || text.includes("enetunreach")
    || text.includes("ehostunreach")
    || text.includes("eaddrnotavail")
    || text.includes("enetdown")
    || text.includes("ehostdown");
}

function isProxyGatewayStatus(status) {
  const code = Number(status);
  return code === 407 || code === 408 || code === 421 || code === 429 || code === 502 || code === 503 || code === 504
    || code === 520 || code === 521 || code === 522 || code === 523 || code === 524
    || code === 525 || code === 526 || code === 527 || code === 530;
}

function proxyGatewayError(status) {
  const error = new Error(`HTTP ${status} proxy_gateway`);
  error.code = "proxy_gateway";
  error.status = status;
  return error;
}

function remainingTimeout(deadline, fallback) {
  if (!deadline) return fallback;
  return Math.max(0, deadline - Date.now());
}

async function withOneRetry(label, task, deadline) {
  try {
    return await task();
  } catch (firstError) {
    if (!isTransientNetworkError(firstError)) throw firstError;
    const left = remainingTimeout(deadline, 0);
    if (left < 150) throw firstError;
    await delay(Math.min(500, Math.max(0, left - 80)));
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

function isRedirectStatus(status) {
  const code = Number(status);
  return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

function canFollowRedirect(method) {
  const verb = String(method || "GET").toUpperCase();
  return verb === "GET" || verb === "HEAD";
}

function resolveRedirectUrl(currentUrl, location) {
  const raw = String(location || "").trim();
  if (!raw) return null;
  try {
    const current = new URL(currentUrl);
    const next = new URL(raw, currentUrl);
    if (next.protocol !== "http:" && next.protocol !== "https:") return null;
    // A redirect off TLS would replay the bearer token in clear text.
    if (current.protocol === "https:" && next.protocol === "http:") return null;
    return next.toString();
  } catch {
    return null;
  }
}

const CREDENTIAL_HEADER_NAMES = new Set(["authorization", "cookie", "chatgpt-account-id", "proxy-authorization"]);

function sameOrigin(leftUrl, rightUrl) {
  try {
    return new URL(leftUrl).origin === new URL(rightUrl).origin;
  } catch {
    return false;
  }
}

// Credentials are scoped to the origin that issued them. A redirect to another
// host must not carry the ChatGPT / Cursor / Google bearer along with it.
function headersForRedirect(headers, fromUrl, toUrl) {
  if (sameOrigin(fromUrl, toUrl)) return headers;
  const stripped = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (CREDENTIAL_HEADER_NAMES.has(String(name).toLowerCase())) continue;
    stripped[name] = value;
  }
  return stripped;
}

function serializeBody(body) {
  if (body == null || body === "") return null;
  return Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

function hasHeader(headers, wanted) {
  const name = String(wanted).toLowerCase();
  return Object.keys(headers || {}).some((key) => String(key).toLowerCase() === name);
}

function nodeHttpJson(url, opts, headers, timeout, signature = null, hops = 0) {
  if (!(timeout > 0)) {
    return Promise.reject(new Error("请求超时"));
  }
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const agent = getAgentForSignature(signature, u.protocol);
    const payload = serializeBody(opts.body);
    // Node would otherwise send the body chunked; some token endpoints and
    // local proxies answer 411 to that. Declare the exact length instead.
    const requestHeaders = payload && !hasHeader(headers, "content-length") && !hasHeader(headers, "transfer-encoding")
      ? { ...headers, "Content-Length": String(payload.length) }
      : headers;
    let settled = false;
    let deadlineTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      fn(value);
    };
    const req = mod.request(url, { method: opts.method || "GET", headers: requestHeaders, timeout, agent }, (res) => {
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
          const status = res.statusCode;
          const nextUrl = hops < 2 && canFollowRedirect(opts.method) && isRedirectStatus(status)
            ? resolveRedirectUrl(url, res.headers.location)
            : null;
          if (nextUrl && nextUrl !== String(url)) {
            if (deadlineTimer) clearTimeout(deadlineTimer);
            if (settled) return;
            settled = true;
            const left = timeout - (Date.now() - startedAt);
            nodeHttpJson(nextUrl, opts, headersForRedirect(headers, url, nextUrl), left, signature, hops + 1).then(resolve, reject);
            return;
          }
          finish(resolve, { status, headers: res.headers, body: decodeHttpBody(res.headers, chunks) });
        } catch (error) {
          finish(reject, error);
        }
      });
      res.on("error", (error) => finish(reject, error));
      const dropResponse = () => {
        const error = new Error("socket hang up");
        error.code = "ECONNRESET";
        finish(reject, error);
      };
      res.on("aborted", dropResponse);
      res.on("close", () => {
        if (!res.complete) dropResponse();
      });
    });
    // Socket idle timeout resets whenever a byte arrives, so a slow trickle
    // would hang quota refresh forever. Bound the whole request as well.
    if (timeout > 0) {
      deadlineTimer = setTimeout(() => {
        req.destroy();
        finish(reject, new Error("请求超时"));
      }, timeout);
    }
    req.on("timeout", () => { req.destroy(); finish(reject, new Error("请求超时")); });
    req.on("error", (error) => finish(reject, error));
    if (payload) req.end(payload);
    else req.end();
  });
}

async function httpJsonLocal(url, opts = {}) {
  const headers = Object.assign(
    { "Content-Type": "application/json", "Accept": "application/json", "Accept-Encoding": "gzip, deflate" },
    opts.headers || {}
  );
  const timeout = opts.timeout || REFRESH_TIMEOUT;
  const deadline = Date.now() + timeout;
  const idempotent = opts.idempotent !== false;
  const host = (() => { try { return new URL(url).host; } catch { return "unknown"; } })();
  const proxy = proxyResolve();
  const signature = await proxy.resolveLiveProxy(url);
  await proxy.applySignatureToRuntime(signature, { touchSession: false });
  if (!signature.proxyUrl && await proxy.hostLooksPoisoned(host)) {
    throw new Error(`网络请求失败 (${host})。本机 DNS 异常且没有可用的本地代理。`);
  }

  // Never use Chromium net.fetch here. It shares the UI session and a bad
  // Content-Length / hijack page freezes the main window as 未响应.
  const runWith = async (nextSignature, nextDeadline) => {
    const result = await nodeHttpJson(
      url,
      opts,
      headers,
      remainingTimeout(nextDeadline, timeout),
      nextSignature,
    );
    // Clash and other local proxies often answer 429/502/503/504 (or
    // Cloudflare 52x) when the upstream path is dead or the proxy itself
    // is rate-limiting. That is a completed HTTP response, so the first
    // hop would otherwise stick and never fail over. Quota GET is safe
    // to replay; a refresh-token POST is not.
    if (idempotent && nextSignature?.proxyUrl && isProxyGatewayStatus(result.status)) {
      throw proxyGatewayError(result.status);
    }
    return result;
  };
  const attempts = [];
  try {
    const runNode = () => runWith(signature, deadline);
    return idempotent
      ? await withOneRetry("Node network", runNode, deadline)
      : await runNode();
  } catch (error) {
    attempts.push({ label: "Node", error });
    if (signature.proxyUrl) proxy.markProxyFailed(signature.proxyUrl);
    proxy.invalidateLiveProxy();
    const retrySignature = await proxy.resolveLiveProxy(url);
    const firstProxy = signature.proxyUrl || "";
    const nextProxy = retrySignature.proxyUrl || "";
    const proxyUnreachable = !!firstProxy && isUnreachableProxyError(error);
    if ((idempotent || proxyUnreachable) && nextProxy !== firstProxy) {
      await proxy.applySignatureToRuntime(retrySignature, { touchSession: false });
      // A hung first proxy can consume the whole first budget. The
      // alternate path (another local proxy, or direct) gets its own.
      const failoverDeadline = Date.now() + timeout;
      try {
        const runFailover = () => runWith(retrySignature, failoverDeadline);
        return idempotent
          ? await withOneRetry("Node network", runFailover, failoverDeadline)
          : await runFailover();
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

function stripXssiPrefix(text) {
  return String(text || "").replace(/^\uFEFF/, "").replace(/^\)\]\}',?\s*/, "");
}

// A 401/403 whose body is a web page did not come from the API: it is a
// Cloudflare challenge, a captive portal, or a local proxy's block page.
// Treating it as "token revoked" would demand a fresh login for nothing.
function looksLikeHtmlResponse(body, headers) {
  const raw = headers?.["content-type"];
  const contentType = String(Array.isArray(raw) ? raw[0] : raw || "").toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) return true;
  const text = String(body || "").trimStart().slice(0, 64).toLowerCase();
  return text.startsWith("<!doctype") || text.startsWith("<html") || text.startsWith("<head") || text.startsWith("<body");
}

function extractErrorCode(body) {
  try {
    const v = JSON.parse(stripXssiPrefix(body));
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
  stripXssiPrefix,
  looksLikeHtmlResponse,
  contentEncoding,
  MAX_JSON_BODY_BYTES,
  concatUtf8Capped,
  decodeHttpBody,
  nodeHttpJson,
  getAgentForSignature,
  resetHttpAgentsForTests,
  isTransientNetworkError,
  isUnreachableProxyError,
  isProxyGatewayStatus,
  isRedirectStatus,
  resolveRedirectUrl,
  headersForRedirect,
  withOneRetry,
};

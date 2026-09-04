const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const zlib = require("node:zlib");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_JSON_BODY_BYTES,
  concatUtf8Capped,
  nodeHttpJson,
  httpJsonLocal,
  isTransientNetworkError,
  isUnreachableProxyError,
  isProxyGatewayStatus,
  isRedirectStatus,
  resolveRedirectUrl,
  withOneRetry,
  resetHttpAgentsForTests,
  extractErrorCode,
  stripXssiPrefix,
  contentEncoding,
  decodeHttpBody,
} = require("../engine/http-client");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("Google XSSI prefixes are stripped before JSON error codes are read", () => {
  assert.equal(stripXssiPrefix(")]}'\n{\"ok\":true}"), "{\"ok\":true}");
  assert.equal(stripXssiPrefix(")]}',\n{\"ok\":true}"), "{\"ok\":true}");
  assert.equal(stripXssiPrefix("{\"ok\":true}"), "{\"ok\":true}");
  assert.equal(extractErrorCode(")]}'\n" + JSON.stringify({ error: { code: "rate_limit" } })), "rate_limit");
});

test("capped UTF-8 concat keeps a normal JSON body", () => {
  const body = concatUtf8Capped([Buffer.from('{"ok":true}')]);
  assert.equal(body, '{"ok":true}');
});

test("capped UTF-8 concat rejects a body that would freeze the UI", () => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const chunks = [];
  let total = 0;
  while (total <= MAX_JSON_BODY_BYTES) {
    chunks.push(chunk);
    total += chunk.length;
  }
  assert.throws(() => concatUtf8Capped(chunks), (error) => {
    assert.equal(error.code, "response_too_large");
    assert.match(error.message, /响应过大/);
    return true;
  });
});

test("quota HTTP never uses Chromium fetch on the UI session", () => {
  const source = fs.readFileSync(path.join(__dirname, "../engine/http-client.js"), "utf8");
  assert.match(source, /Never use Chromium net\.fetch here/);
  assert.match(source, /touchSession: false/);
  assert.match(source, /MAX_JSON_BODY_BYTES = 1024 \* 1024/);
  assert.match(source, /keepAlive: true/);
  assert.doesNotMatch(source, /if \(!signature\.proxyUrl\) \{/);
  assert.doesNotMatch(source, /electronHttpJson/);
});

test("HTTP agents are reused for the same proxy signature", () => {
  const { getAgentForSignature, resetHttpAgentsForTests } = require("../engine/http-client");
  resetHttpAgentsForTests();
  const directA = getAgentForSignature({ proxyUrl: "" }, "https:");
  const directB = getAgentForSignature({ proxyUrl: "" }, "https:");
  const proxyA = getAgentForSignature({ proxyUrl: "http://127.0.0.1:7890" }, "https:");
  const proxyB = getAgentForSignature({ proxyUrl: "http://127.0.0.1:7890" }, "https:");
  const proxyOther = getAgentForSignature({ proxyUrl: "http://127.0.0.1:10808" }, "https:");
  const httpDirect = getAgentForSignature({ proxyUrl: "" }, "http:");
  assert.equal(directA, directB);
  assert.equal(proxyA, proxyB);
  assert.notEqual(directA, proxyA);
  assert.notEqual(proxyA, proxyOther);
  assert.notEqual(directA, httpDirect);
  assert.equal(directA.keepAlive, true);
  resetHttpAgentsForTests();
});

test("HTTP transport falls back in-process when the engine worker is down", async () => {
  const { httpJson, setHttpJsonTransport } = require("../engine/http-client");
  let calls = 0;
  setHttpJsonTransport(async () => {
    calls += 1;
    const error = new Error("worker down");
    error.code = "engine_worker_down";
    throw error;
  });
  try {
    await assert.rejects(() => httpJson("http://127.0.0.1:1/", { timeout: 200 }), /网络请求失败|ECONNREFUSED|请求超时/);
    assert.equal(calls, 1);
  } finally {
    setHttpJsonTransport(null);
  }
});

test("HTTP transport is used when the engine worker is alive", async () => {
  const { httpJson, setHttpJsonTransport } = require("../engine/http-client");
  setHttpJsonTransport(async (url) => ({ status: 200, headers: {}, body: JSON.stringify({ url }) }));
  try {
    const result = await httpJson("https://example.invalid/quota");
    assert.equal(result.status, 200);
    assert.match(result.body, /example\.invalid/);
  } finally {
    setHttpJsonTransport(null);
  }
});

test("node HTTP JSON still returns a normal quota body inside the deadline", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 12, path: req.url }));
  });
  const port = await listen(server);
  try {
    const result = await nodeHttpJson(
      `http://127.0.0.1:${port}/quota`,
      {},
      { Accept: "application/json" },
      1000,
    );
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":12/);
  } finally {
    await closeServer(server);
  }
});

test("node HTTP JSON aborts a slow body trickle that would reset the socket timeout", async () => {
  let interval = null;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    interval = setInterval(() => {
      try { res.write("a"); } catch {}
    }, 40);
    req.on("close", () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    });
  });
  const port = await listen(server);
  try {
    const started = Date.now();
    await assert.rejects(
      () => nodeHttpJson(
        `http://127.0.0.1:${port}/quota`,
        {},
        { Accept: "application/json" },
        200,
      ),
      (error) => {
        assert.match(error.message, /请求超时/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 1500, "a dripping response must not hang past the overall deadline");
  } finally {
    if (interval) clearInterval(interval);
    await closeServer(server);
  }
});

test("transient DNS blips are retried, hard HTTP failures are not", () => {
  assert.equal(isTransientNetworkError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND chatgpt.com" }), true);
  assert.equal(isTransientNetworkError({ code: "EAI_AGAIN", message: "getaddrinfo EAI_AGAIN chatgpt.com" }), true);
  assert.equal(isTransientNetworkError({ code: "ENETUNREACH", message: "connect ENETUNREACH 2606:4700::1" }), true);
  assert.equal(isTransientNetworkError({ code: "EHOSTUNREACH", message: "connect EHOSTUNREACH 1.2.3.4" }), true);
  assert.equal(isTransientNetworkError({ code: "EPIPE", message: "write EPIPE" }), true);
  assert.equal(isTransientNetworkError({ code: "ENETDOWN", message: "connect ENETDOWN 127.0.0.1:7890" }), true);
  assert.equal(isTransientNetworkError({ code: "UND_ERR_SOCKET", message: "other side closed" }), true);
  assert.equal(isTransientNetworkError({ message: "HTTP 401" }), false);
});

test("a dropped undici proxy socket is retried inside the deadline", async () => {
  let looks = 0;
  const result = await withOneRetry("Node network", async () => {
    looks += 1;
    if (looks === 1) {
      const error = new Error("other side closed");
      error.code = "UND_ERR_SOCKET";
      throw error;
    }
    return { ok: true };
  }, Date.now() + 1000);
  assert.equal(result.ok, true);
  assert.equal(looks, 2);
});

test("a dropped proxy pipe is retried inside the deadline", async () => {
  let looks = 0;
  const result = await withOneRetry("Node network", async () => {
    looks += 1;
    if (looks === 1) {
      const error = new Error("write EPIPE");
      error.code = "EPIPE";
      throw error;
    }
    return { ok: true };
  }, Date.now() + 1000);
  assert.equal(result.ok, true);
  assert.equal(looks, 2);
});

test("a flaky DNS error is retried inside the deadline", async () => {
  let looks = 0;
  const result = await withOneRetry("Node network", async () => {
    looks += 1;
    if (looks === 1) {
      const error = new Error("getaddrinfo ENOTFOUND chatgpt.com");
      error.code = "ENOTFOUND";
      throw error;
    }
    return { ok: true };
  }, Date.now() + 1000);
  assert.equal(result.ok, true);
  assert.equal(looks, 2);
});

test("an unreachable IPv6 hop is retried inside the deadline", async () => {
  let looks = 0;
  const result = await withOneRetry("Node network", async () => {
    looks += 1;
    if (looks === 1) {
      const error = new Error("connect ENETUNREACH 2606:4700::1:443");
      error.code = "ENETUNREACH";
      throw error;
    }
    return { ok: true };
  }, Date.now() + 1000);
  assert.equal(result.ok, true);
  assert.equal(looks, 2);
});

test("quota HTTP retries stay inside one overall deadline", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  proxy.resolveLiveProxy = async () => ({ source: "test", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  const server = http.createServer(() => {});
  const port = await listen(server);
  try {
    const started = Date.now();
    await assert.rejects(
      () => httpJsonLocal(`http://127.0.0.1:${port}/quota`, { timeout: 250 }),
      /网络请求失败|请求超时/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 800, `shared deadline was 250ms, took ${elapsed}ms`);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    await closeServer(server);
  }
});

test("a proxy that just failed HTTP is skipped so failover can go direct", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  proxy.resetFailedProxiesForTests();
  const held = [];
  const hang = net.createServer((socket) => { held.push(socket); });
  const hangPort = await listen(hang);
  const good = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 9 }));
  });
  const goodPort = await listen(good);
  const hungProxy = `http://127.0.0.1:${hangPort}`;
  proxy.resolveLiveProxy = async () => {
    if (proxy.isProxyRecentlyFailed(hungProxy)) return { source: "direct", proxyUrl: "", probed: false };
    return { source: "test", proxyUrl: hungProxy, probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 400 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":9/);
    assert.equal(proxy.isProxyRecentlyFailed(hungProxy), true);
  } finally {
    for (const socket of held) {
      try { socket.destroy(); } catch {}
    }
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(hang);
    await closeServer(good);
  }
});

test("a hung first proxy still gets a fresh budget for direct or another proxy", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const held = [];
  const hang = net.createServer((socket) => { held.push(socket); });
  const hangPort = await listen(hang);
  const good = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 7 }));
  });
  const goodPort = await listen(good);
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (looks === 1) return { source: "test", proxyUrl: `http://127.0.0.1:${hangPort}`, probed: false };
    return { source: "test", proxyUrl: "", probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const started = Date.now();
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 400 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":7/);
    assert.ok(looks >= 2, "dead first proxy must be invalidated and resolved again");
    assert.ok(Date.now() - started < 2500, `failover should still return the quota body, took ${Date.now() - started}ms`);
  } finally {
    for (const socket of held) {
      try { socket.destroy(); } catch {}
    }
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(hang);
    await closeServer(good);
  }
});

test("refused proxies are unreachable, request timeouts are not", () => {
  assert.equal(isUnreachableProxyError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:1" }), true);
  assert.equal(isUnreachableProxyError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND proxy.local" }), true);
  assert.equal(isUnreachableProxyError({ code: "ENETUNREACH", message: "connect ENETUNREACH 2606:4700::1" }), true);
  assert.equal(isUnreachableProxyError({ code: "ENETDOWN", message: "connect ENETDOWN 127.0.0.1:7890" }), true);
  assert.equal(isUnreachableProxyError({ code: "EPIPE", message: "write EPIPE" }), false);
  assert.equal(isUnreachableProxyError({ message: "请求超时" }), false);
  assert.equal(isUnreachableProxyError({ code: "UND_ERR_SOCKET", message: "other side closed" }), false);
});

test("a proxy 502 on quota GET failovers to direct", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const bad = http.createServer((_req, res) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("Bad Gateway");
  });
  const badPort = await listen(bad);
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 11 }));
  });
  const goodPort = await listen(good);
  const badProxy = `http://127.0.0.1:${badPort}`;
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (proxy.isProxyRecentlyFailed(badProxy) || looks > 1) {
      return { source: "direct", proxyUrl: "", probed: false };
    }
    return { source: "test", proxyUrl: badProxy, probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    assert.equal(isProxyGatewayStatus(502), true);
    assert.equal(isProxyGatewayStatus(504), true);
    assert.equal(isProxyGatewayStatus(521), true);
    assert.equal(isProxyGatewayStatus(524), true);
    assert.equal(isProxyGatewayStatus(407), true);
    assert.equal(isProxyGatewayStatus(408), true);
    assert.equal(isProxyGatewayStatus(421), true);
    assert.equal(isProxyGatewayStatus(429), true);
    assert.equal(isProxyGatewayStatus(520), true);
    assert.equal(isProxyGatewayStatus(530), true);
    assert.equal(isProxyGatewayStatus(500), false);
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":11/);
    assert.equal(proxy.isProxyRecentlyFailed(badProxy), true);
    assert.ok(looks >= 2);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(bad);
    await closeServer(good);
  }
});

test("a proxy 421 on quota GET failovers to direct", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const bad = http.createServer((_req, res) => {
    res.writeHead(421, { "content-type": "text/plain" });
    res.end("Misdirected Request");
  });
  const badPort = await listen(bad);
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 4 }));
  });
  const goodPort = await listen(good);
  const badProxy = `http://127.0.0.1:${badPort}`;
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (proxy.isProxyRecentlyFailed(badProxy) || looks > 1) {
      return { source: "direct", proxyUrl: "", probed: false };
    }
    return { source: "test", proxyUrl: badProxy, probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":4/);
    assert.equal(proxy.isProxyRecentlyFailed(badProxy), true);
    assert.ok(looks >= 2);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(bad);
    await closeServer(good);
  }
});

test("a proxy 408 on quota GET failovers to direct", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const bad = http.createServer((_req, res) => {
    res.writeHead(408, { "content-type": "text/plain" });
    res.end("Request Timeout");
  });
  const badPort = await listen(bad);
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 9 }));
  });
  const goodPort = await listen(good);
  const badProxy = `http://127.0.0.1:${badPort}`;
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (proxy.isProxyRecentlyFailed(badProxy) || looks > 1) {
      return { source: "direct", proxyUrl: "", probed: false };
    }
    return { source: "test", proxyUrl: badProxy, probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":9/);
    assert.equal(proxy.isProxyRecentlyFailed(badProxy), true);
    assert.ok(looks >= 2);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(bad);
    await closeServer(good);
  }
});

test("a proxy 429 on quota GET failovers to direct", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const bad = http.createServer((_req, res) => {
    res.writeHead(429, { "content-type": "text/plain", "retry-after": "30" });
    res.end("Too Many Requests");
  });
  const badPort = await listen(bad);
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 13 }));
  });
  const goodPort = await listen(good);
  const badProxy = `http://127.0.0.1:${badPort}`;
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (proxy.isProxyRecentlyFailed(badProxy) || looks > 1) {
      return { source: "direct", proxyUrl: "", probed: false };
    }
    return { source: "test", proxyUrl: badProxy, probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":13/);
    assert.equal(proxy.isProxyRecentlyFailed(badProxy), true);
    assert.ok(looks >= 2);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(bad);
    await closeServer(good);
  }
});

test("a proxy 520 on quota GET failovers to direct", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const bad = http.createServer((_req, res) => {
    res.writeHead(520, { "content-type": "text/plain" });
    res.end("Unknown Error");
  });
  const badPort = await listen(bad);
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 3 }));
  });
  const goodPort = await listen(good);
  const badProxy = `http://127.0.0.1:${badPort}`;
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (proxy.isProxyRecentlyFailed(badProxy) || looks > 1) {
      return { source: "direct", proxyUrl: "", probed: false };
    }
    return { source: "test", proxyUrl: badProxy, probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":3/);
    assert.equal(proxy.isProxyRecentlyFailed(badProxy), true);
    assert.ok(looks >= 2);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(bad);
    await closeServer(good);
  }
});

test("a proxy 407 on quota GET failovers to direct", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const bad = http.createServer((_req, res) => {
    res.writeHead(407, { "content-type": "text/plain", "proxy-authenticate": "Basic" });
    res.end("Proxy Authentication Required");
  });
  const badPort = await listen(bad);
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 5 }));
  });
  const goodPort = await listen(good);
  const badProxy = `http://127.0.0.1:${badPort}`;
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (proxy.isProxyRecentlyFailed(badProxy) || looks > 1) {
      return { source: "direct", proxyUrl: "", probed: false };
    }
    return { source: "test", proxyUrl: badProxy, probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":5/);
    assert.equal(proxy.isProxyRecentlyFailed(badProxy), true);
    assert.ok(looks >= 2);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(bad);
    await closeServer(good);
  }
});

test("a proxy 524 on quota GET failovers to direct", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const bad = http.createServer((_req, res) => {
    res.writeHead(524, { "content-type": "text/plain" });
    res.end("A Timeout Occurred");
  });
  const badPort = await listen(bad);
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 7 }));
  });
  const goodPort = await listen(good);
  const badProxy = `http://127.0.0.1:${badPort}`;
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (proxy.isProxyRecentlyFailed(badProxy) || looks > 1) {
      return { source: "direct", proxyUrl: "", probed: false };
    }
    return { source: "test", proxyUrl: badProxy, probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":7/);
    assert.equal(proxy.isProxyRecentlyFailed(badProxy), true);
    assert.ok(looks >= 2);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(bad);
    await closeServer(good);
  }
});

test("a proxy 429 on token POST does not replay", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const bad = http.createServer((_req, res) => {
    res.writeHead(429, { "content-type": "text/plain" });
    res.end("Too Many Requests");
  });
  const badPort = await listen(bad);
  let posts = 0;
  const good = http.createServer((req, res) => {
    if (req.method === "POST") posts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "should-not" }));
  });
  const goodPort = await listen(good);
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (looks === 1) return { source: "test", proxyUrl: `http://127.0.0.1:${badPort}`, probed: false };
    return { source: "direct", proxyUrl: "", probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/token`, {
      method: "POST",
      body: "grant_type=refresh_token",
      timeout: 800,
      idempotent: false,
    });
    assert.equal(result.status, 429);
    assert.equal(posts, 0);
    assert.equal(looks, 1);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(bad);
    await closeServer(good);
  }
});

test("a proxy 502 on token POST does not replay", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const bad = http.createServer((_req, res) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("Bad Gateway");
  });
  const badPort = await listen(bad);
  let posts = 0;
  const good = http.createServer((req, res) => {
    if (req.method === "POST") posts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "should-not" }));
  });
  const goodPort = await listen(good);
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (looks === 1) return { source: "test", proxyUrl: `http://127.0.0.1:${badPort}`, probed: false };
    return { source: "direct", proxyUrl: "", probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/token`, {
      method: "POST",
      body: "grant_type=refresh_token",
      timeout: 800,
      idempotent: false,
    });
    assert.equal(result.status, 502);
    assert.equal(posts, 0);
    assert.equal(looks, 1);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(bad);
    await closeServer(good);
  }
});

test("a refused first proxy still failovers a non-idempotent token POST", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const closed = net.createServer();
  const closedPort = await listen(closed);
  await closeServer(closed);
  let posts = 0;
  const good = http.createServer((req, res) => {
    if (req.method === "POST") posts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "ok" }));
  });
  const goodPort = await listen(good);
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (looks === 1) return { source: "test", proxyUrl: `http://127.0.0.1:${closedPort}`, probed: false };
    return { source: "test", proxyUrl: "", probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/token`, {
      method: "POST",
      body: "grant_type=refresh_token",
      timeout: 400,
      idempotent: false,
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /access_token/);
    assert.equal(posts, 1);
    assert.ok(looks >= 2);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(good);
  }
});

test("a non-idempotent token POST does not replay after a request timeout", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const held = [];
  const hang = net.createServer((socket) => { held.push(socket); });
  const hangPort = await listen(hang);
  let posts = 0;
  const good = http.createServer((req, res) => {
    if (req.method === "POST") posts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "should-not" }));
  });
  const goodPort = await listen(good);
  let looks = 0;
  proxy.resolveLiveProxy = async () => {
    looks += 1;
    if (looks === 1) return { source: "test", proxyUrl: `http://127.0.0.1:${hangPort}`, probed: false };
    return { source: "test", proxyUrl: "", probed: false };
  };
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    await assert.rejects(
      () => httpJsonLocal(`http://127.0.0.1:${goodPort}/token`, {
        method: "POST",
        body: "grant_type=refresh_token",
        timeout: 200,
        idempotent: false,
      }),
      /网络请求失败|请求超时/,
    );
    assert.equal(posts, 0, "a timed-out token POST must not be replayed on direct");
    assert.ok(looks >= 1);
  } finally {
    for (const socket of held) {
      try { socket.destroy(); } catch {}
    }
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(hang);
    await closeServer(good);
  }
});

test("quota GET follows a 302 to the usage body", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 19 }));
  });
  const goodPort = await listen(good);
  const hop = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${goodPort}/usage` });
    res.end();
  });
  const hopPort = await listen(hop);
  proxy.resolveLiveProxy = async () => ({ source: "direct", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    assert.equal(isRedirectStatus(302), true);
    assert.equal(resolveRedirectUrl(`http://127.0.0.1:${hopPort}/quota`, "/usage").endsWith("/usage"), true);
    const result = await httpJsonLocal(`http://127.0.0.1:${hopPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":19/);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(hop);
    await closeServer(good);
  }
});

test("token POST does not follow a 302", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  let posts = 0;
  const good = http.createServer((req, res) => {
    if (req.method === "POST") posts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "should-not" }));
  });
  const goodPort = await listen(good);
  const hop = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${goodPort}/token` });
    res.end("moved");
  });
  const hopPort = await listen(hop);
  proxy.resolveLiveProxy = async () => ({ source: "direct", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${hopPort}/token`, {
      method: "POST",
      body: "grant_type=refresh_token",
      timeout: 800,
      idempotent: false,
    });
    assert.equal(result.status, 302);
    assert.equal(posts, 0);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(hop);
    await closeServer(good);
  }
});

test("quota GET decodes a gzip usage body", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const payload = JSON.stringify({ remaining: 23 });
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(zlib.gzipSync(payload));
  });
  const goodPort = await listen(good);
  proxy.resolveLiveProxy = async () => ({ source: "direct", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":23/);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(good);
  }
});

test("quota GET decodes gzip when Content-Encoding has a trailing space or list", () => {
  assert.equal(contentEncoding({ "content-encoding": "gzip " }), "gzip");
  assert.equal(contentEncoding({ "content-encoding": "gzip, deflate" }), "gzip");
  assert.equal(contentEncoding({ "content-encoding": ["gzip"] }), "gzip");
  const payload = JSON.stringify({ remaining: 19 });
  const body = decodeHttpBody({ "content-encoding": "gzip " }, [zlib.gzipSync(payload)]);
  assert.match(body, /"remaining":19/);
  const listed = decodeHttpBody({ "content-encoding": "gzip, deflate" }, [zlib.gzipSync(payload)]);
  assert.match(listed, /"remaining":19/);
});

test("quota GET sniffs a gzip body even without Content-Encoding", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const payload = JSON.stringify({ remaining: 17 });
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(zlib.gzipSync(payload));
  });
  const goodPort = await listen(good);
  proxy.resolveLiveProxy = async () => ({ source: "direct", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":17/);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(good);
  }
});

test("quota GET strips a UTF-8 BOM before parsing usage JSON", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`\uFEFF${JSON.stringify({ remaining: 13 })}`);
  });
  const goodPort = await listen(good);
  proxy.resolveLiveProxy = async () => ({ source: "direct", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.equal(result.body.charCodeAt(0) === 0xfeff, false);
    assert.match(result.body, /"remaining":13/);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(good);
  }
});

test("a broken gzip quota body stays a temporary miss", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  const good = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(Buffer.from("not-gzip"));
  });
  const goodPort = await listen(good);
  proxy.resolveLiveProxy = async () => ({ source: "direct", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    await assert.rejects(
      () => httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 }),
      /响应解压失败/,
    );
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(good);
  }
});

test("a truncated quota body fails before the full timeout", async () => {
  const bad = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "80" });
    res.write("{");
    res.destroy();
  });
  const badPort = await listen(bad);
  try {
    const started = Date.now();
    await assert.rejects(
      () => nodeHttpJson(`http://127.0.0.1:${badPort}/quota`, {}, { Accept: "application/json" }, 800),
      /socket|ECONNRESET|请求超时/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 400, `truncated body should fail before the 800ms budget, took ${elapsed}ms`);
  } finally {
    resetHttpAgentsForTests();
    await closeServer(bad);
  }
});

test("a cross-origin redirect drops the bearer and account headers", async () => {
  const { headersForRedirect } = require("../engine/http-client");
  const headers = {
    Authorization: "Bearer secret",
    "ChatGPT-Account-Id": "acct",
    Cookie: "WorkosCursorSessionToken=x",
    Accept: "application/json",
  };
  const sameOrigin = headersForRedirect(headers, "https://chatgpt.com/a", "https://chatgpt.com/b?x=1");
  assert.equal(sameOrigin.Authorization, "Bearer secret");
  assert.equal(sameOrigin["ChatGPT-Account-Id"], "acct");
  const crossOrigin = headersForRedirect(headers, "https://chatgpt.com/a", "https://evil.example/b");
  assert.equal(crossOrigin.Authorization, undefined);
  assert.equal(crossOrigin["ChatGPT-Account-Id"], undefined);
  assert.equal(crossOrigin.Cookie, undefined);
  assert.equal(crossOrigin.Accept, "application/json");
  const otherPort = headersForRedirect(headers, "http://127.0.0.1:1000/a", "http://127.0.0.1:2000/a");
  assert.equal(otherPort.Authorization, undefined);

  const seen = [];
  const target = http.createServer((req, res) => {
    seen.push({ authorization: req.headers.authorization || null, accept: req.headers.accept || null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const targetPort = await listen(target);
  const hop = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/usage` });
    res.end();
  });
  const hopPort = await listen(hop);
  try {
    const result = await nodeHttpJson(`http://127.0.0.1:${hopPort}/quota`, {}, {
      Authorization: "Bearer secret",
      Accept: "application/json",
    }, 800);
    assert.equal(result.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, null, "bearer must not follow a redirect to another origin");
    assert.equal(seen[0].accept, "application/json");
  } finally {
    resetHttpAgentsForTests();
    await closeServer(hop);
    await closeServer(target);
  }
});

test("a redirect from https to plain http is not followed", () => {
  assert.equal(resolveRedirectUrl("https://chatgpt.com/quota", "http://chatgpt.com/quota"), null);
  assert.equal(resolveRedirectUrl("https://chatgpt.com/quota", "https://chatgpt.com/usage"), "https://chatgpt.com/usage");
  assert.equal(resolveRedirectUrl("http://127.0.0.1:1/quota", "http://127.0.0.1:2/usage"), "http://127.0.0.1:2/usage");
  assert.equal(resolveRedirectUrl("https://chatgpt.com/quota", "ftp://chatgpt.com/usage"), null);
});

test("POST bodies are sent with an exact Content-Length instead of chunked", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({
        contentLength: req.headers["content-length"] || null,
        transferEncoding: req.headers["transfer-encoding"] || null,
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const port = await listen(server);
  try {
    const form = "grant_type=refresh_token&refresh_token=abc";
    await nodeHttpJson(`http://127.0.0.1:${port}/token`, { method: "POST", body: form }, {
      "Content-Type": "application/x-www-form-urlencoded",
    }, 800);
    await nodeHttpJson(`http://127.0.0.1:${port}/meta`, { method: "POST", body: { email: "中文@example.com" } }, {
      "Content-Type": "application/json",
    }, 800);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].transferEncoding, null);
    assert.equal(seen[0].contentLength, String(Buffer.byteLength(form)));
    assert.equal(seen[0].body, form);
    assert.equal(seen[1].transferEncoding, null);
    assert.equal(seen[1].contentLength, String(Buffer.byteLength(JSON.stringify({ email: "中文@example.com" }))));
    assert.equal(JSON.parse(seen[1].body).email, "中文@example.com");
  } finally {
    resetHttpAgentsForTests();
    await closeServer(server);
  }
});

test("a truncated quota GET is retried inside the deadline", async () => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  let hits = 0;
  const good = http.createServer((_req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(200, { "content-type": "application/json", "content-length": "80" });
      res.write("{");
      res.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ remaining: 6 }));
  });
  const goodPort = await listen(good);
  proxy.resolveLiveProxy = async () => ({ source: "direct", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  proxy.resetFailedProxiesForTests();
  try {
    const result = await httpJsonLocal(`http://127.0.0.1:${goodPort}/quota`, { timeout: 800 });
    assert.equal(result.status, 200);
    assert.match(result.body, /"remaining":6/);
    assert.equal(hits, 2);
  } finally {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    proxy.resetFailedProxiesForTests();
    resetHttpAgentsForTests();
    await closeServer(good);
  }
});

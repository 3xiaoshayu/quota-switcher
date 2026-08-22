const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeProxyRule,
  parseWindowsProxyServer,
  parseWindowsProxyEnable,
  isPoisonedIp,
  collectCandidatesFromHints,
  lastGoodSource,
  markProxyFailed,
  isProxyRecentlyFailed,
  resetFailedProxiesForTests,
  redactProxyUrl,
  socksFallbackUrl,
  syncProxyEnv,
  readWindowsInternetProxy,
} = require("../engine/proxy-resolve");

test("a proxy that just failed HTTP is remembered so resolve can skip it", () => {
  resetFailedProxiesForTests();
  markProxyFailed("http://127.0.0.1:7890");
  assert.equal(isProxyRecentlyFailed("http://127.0.0.1:7890"), true);
  assert.equal(isProxyRecentlyFailed("http://127.0.0.1:10808"), false);
  assert.equal(isProxyRecentlyFailed("http://127.0.0.1:7890", Date.now() + 61_000), false);
  resetFailedProxiesForTests();
  assert.equal(isProxyRecentlyFailed("http://127.0.0.1:7890"), false);
});

test("PAC SOCKS rules use remote DNS", () => {
  assert.equal(normalizeProxyRule("SOCKS5 127.0.0.1:10808"), "socks5h://127.0.0.1:10808");
  assert.equal(normalizeProxyRule("PROXY 127.0.0.1:10808"), "http://127.0.0.1:10808");
  assert.equal(normalizeProxyRule("DIRECT"), "");
  assert.equal(normalizeProxyRule("socks5://127.0.0.1:10808"), "socks5h://127.0.0.1:10808");
});

test("Windows leftover proxy server still parses when system proxy is off", () => {
  assert.deepEqual(parseWindowsProxyServer("127.0.0.1:10808"), ["127.0.0.1:10808"]);
  assert.deepEqual(parseWindowsProxyServer("http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808"), [
    "http://127.0.0.1:10809",
    "http://127.0.0.1:10809",
    "socks5h://127.0.0.1:10808",
  ]);
});

test("Windows ProxyEnable DWORD is read from padded hex", () => {
  assert.deepEqual(parseWindowsProxyEnable("    ProxyEnable    REG_DWORD    0x00000000"), {
    raw: "00000000",
    enabled: false,
  });
  assert.deepEqual(parseWindowsProxyEnable("    ProxyEnable    REG_DWORD    0x00000001"), {
    raw: "00000001",
    enabled: true,
  });
});

test("local HTTP candidates can fall back to remote-DNS SOCKS", () => {
  assert.equal(socksFallbackUrl("http://127.0.0.1:10808"), "socks5h://127.0.0.1:10808");
  assert.equal(socksFallbackUrl("https://127.0.0.1:10808"), "");
  assert.equal(socksFallbackUrl("http://proxy.example:8080"), "");
});

test("Windows socks leftover keeps remote DNS", () => {
  const list = collectCandidatesFromHints({
    windows: { enabled: false, server: "socks=127.0.0.1:10808" },
  });
  assert.equal(list[0].source, "windowsLeftover");
  assert.equal(list[0].proxyUrl, "socks5h://127.0.0.1:10808");
});

test("poisoned chatgpt.com answers are recognized", () => {
  assert.equal(isPoisonedIp("162.125.2.6"), true);
  assert.equal(isPoisonedIp("69.171.228.74"), true);
  assert.equal(isPoisonedIp("128.242.240.157"), true);
  assert.equal(isPoisonedIp("2a03:2880:f11b:83:face:b00c:0:25de"), true);
  assert.equal(isPoisonedIp("104.18.32.7"), false);
});

test("candidate order keeps env ahead of port scan", () => {
  const list = collectCandidatesFromHints({
    envProxy: "http://127.0.0.1:9",
    extraPorts: [10808],
  });
  assert.equal(list[0].source, "env");
  assert.equal(list[0].proxyUrl, "http://127.0.0.1:9");
  assert.ok(list.some((item) => item.source === "portScan" && item.proxyUrl === "http://127.0.0.1:10808"));
});

test("ProxyEnable off still keeps leftover local proxy as a candidate", () => {
  const list = collectCandidatesFromHints({
    windows: { enabled: false, server: "127.0.0.1:10808" },
  });
  assert.equal(list[0].source, "windowsLeftover");
  assert.equal(list[0].proxyUrl, "http://127.0.0.1:10808");
});

test("enabled Windows proxy is labeled windows not leftover", () => {
  const list = collectCandidatesFromHints({
    windows: { enabled: true, server: "127.0.0.1:7890" },
  });
  assert.equal(list[0].source, "windows");
  assert.equal(list[0].proxyUrl, "http://127.0.0.1:7890");
});

test("override and lastGood stay ahead of env", () => {
  const list = collectCandidatesFromHints({
    override: "http://127.0.0.1:1",
    lastGood: "http://127.0.0.1:2",
    envProxy: "http://127.0.0.1:3",
  });
  assert.deepEqual(list.slice(0, 3).map((item) => item.source), ["override", "lastGood", "env"]);
});

test("empty hints do not invent a cached empty proxy", () => {
  const list = collectCandidatesFromHints({});
  assert.ok(list.every((item) => item.proxyUrl));
  assert.ok(list.some((item) => item.source === "portScan"));
});

test("lastGood remembers the original discovery source", () => {
  assert.equal(lastGoodSource("windowsLeftover", "lastGood"), "windowsLeftover");
  assert.equal(lastGoodSource("lastGood", "env"), "env");
  assert.equal(lastGoodSource(undefined, "windowsLeftover"), "windowsLeftover");
});

test("proxy URLs redact credentials in logs", () => {
  assert.match(redactProxyUrl("http://user:secret@127.0.0.1:10808"), /redacted/);
  assert.doesNotMatch(redactProxyUrl("http://user:secret@127.0.0.1:10808"), /secret/);
});

test("syncProxyEnv does not grow NO_PROXY on repeated quota refreshes", () => {
  const saved = {
    no_proxy: process.env.no_proxy,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    https_proxy: process.env.https_proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
  };
  try {
    syncProxyEnv("http://127.0.0.1:10808");
    const first = process.env.NO_PROXY;
    assert.match(first, /127\.0\.0\.1/);
    assert.ok(first.length < 256);
    for (let i = 0; i < 80; i += 1) syncProxyEnv("http://127.0.0.1:10808");
    assert.equal(process.env.NO_PROXY, first);
    assert.equal(process.env.no_proxy, first);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("port scan still covers the known local proxy ports", () => {
  const list = collectCandidatesFromHints({});
  const ports = list.filter((item) => item.source === "portScan").map((item) => item.proxyUrl);
  for (const port of [10808, 10809, 7890, 7897, 7891, 7892, 6152, 20171, 1080, 2080]) {
    assert.ok(ports.includes(`http://127.0.0.1:${port}`), String(port));
  }
});

test("readWindowsInternetProxy does not block on execFileSync", async () => {
  const cp = require("node:child_process");
  const originalSync = cp.execFileSync;
  let syncCalled = false;
  cp.execFileSync = (...args) => {
    syncCalled = true;
    return originalSync(...args);
  };
  try {
    await require("../engine/proxy-resolve").readWindowsInternetProxy();
    assert.equal(syncCalled, false);
  } finally {
    cp.execFileSync = originalSync;
  }
});

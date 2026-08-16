const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeProxyRule,
  parseWindowsProxyServer,
  parseWindowsProxyEnable,
  isPoisonedIp,
  collectCandidatesFromHints,
  lastGoodSource,
  redactProxyUrl,
  socksFallbackUrl,
} = require("../engine/proxy-resolve");

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

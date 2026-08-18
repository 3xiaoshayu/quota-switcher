const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const dns = require("node:dns").promises;
const { execFile } = require("node:child_process");
const { getProxyForUrl: getEnvProxyForUrl } = require("proxy-from-env");
const { DATA_DIR, HOME } = require("./config");
const { writeJsonAtomic } = require("./atomic-file");

const NETWORK_FILE = path.join(DATA_DIR, "network.json");
const LOCAL_PROXY_PORTS = [10808, 10809, 7890, 7897, 7891, 7892, 6152, 20171, 1080, 2080];
const CONNECT_PROBE_MS = 1500;
const PORT_OPEN_MS = 300;
const DNS_LOOKUP_MS = 1000;
const PROXY_ENV_KEYS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"];
const NO_PROXY_KEYS = ["no_proxy", "NO_PROXY"];
const LOCAL_NO_PROXY = "127.0.0.1,localhost,::1";

const inheritedProxyEnv = Object.fromEntries(
  [...PROXY_ENV_KEYS, ...NO_PROXY_KEYS].map((key) => [key, process.env[key]]),
);

let liveSignature = null;
const liveByHost = new Map();
let appliedProxyUrl = undefined;

function normalizeProxyRule(rule) {
  if (!rule) return "";
  const first = String(rule)
    .split(";")
    .map((item) => item.trim())
    .find((item) => item && !/^direct$/i.test(item));
  if (!first) return "";

  if (/^(https?|socks4a?|socks5h?|socks5?|pac\+):\/\//i.test(first)) {
    return first.replace(/^socks5:\/\//i, "socks5h://").replace(/^socks4:\/\//i, "socks4a://");
  }

  const match = first.match(/^([a-z][a-z0-9]*)\s+(.+)$/i);
  if (!match) return /^[\w.-]+:\d+$/.test(first) ? `http://${first}` : "";

  const type = match[1].toUpperCase();
  const target = match[2].trim();
  if (!target) return "";

  if (type === "PROXY" || type === "HTTP") return `http://${target}`;
  if (type === "HTTPS") return `https://${target}`;
  if (type === "SOCKS" || type === "SOCKS5") return `socks5h://${target}`;
  if (type === "SOCKS4") return `socks4a://${target}`;
  return "";
}

function parseWindowsProxyServer(server) {
  const text = String(server || "").trim();
  if (!text) return [];
  if (!text.includes("=")) return [text];
  const found = [];
  for (const part of text.split(";")) {
    const match = part.trim().match(/^(https?|socks)=(.+)$/i);
    if (!match) continue;
    const hostPort = match[2].trim();
    if (!hostPort) continue;
    found.push(/^socks$/i.test(match[1]) ? `socks5h://${hostPort}` : `http://${hostPort}`);
  }
  return found;
}

function parseWindowsProxyEnable(regOutput) {
  const match = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(regOutput || ""));
  if (!match) return { raw: "missing", enabled: false };
  return { raw: match[1], enabled: Number.parseInt(match[1], 16) === 1 };
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function readWindowsInternetProxy() {
  try {
    const { stdout: enableOut } = await execFileAsync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    });
    const parsed = parseWindowsProxyEnable(enableOut);
    let server = "";
    try {
      const { stdout: serverOut } = await execFileAsync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2000,
      });
      server = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(serverOut)?.[1]?.trim() || "";
    } catch {
      server = "";
    }
    return { enable: parsed.raw, enabled: parsed.enabled, server };
  } catch (error) {
    return { enable: "error", enabled: false, server: "", error: String(error?.message || error) };
  }
}

function isPoisonedIp(ip) {
  const value = String(ip || "").toLowerCase();
  if (!value) return false;
  if (value.includes("face:b00c")) return true;
  return /^(31\.13\.|69\.171\.|157\.240\.|173\.252\.|199\.16\.|199\.59\.|199\.96\.|162\.125\.|108\.160\.|128\.242\.|2a03:2880:)/.test(value);
}

function isLocalProxyHost(host) {
  return /^(127\.0\.0\.1|localhost|::1)$/i.test(String(host || "").trim());
}

function redactProxyUrl(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username) parsed.username = "redacted";
    if (parsed.password) parsed.password = "redacted";
    return parsed.toString();
  } catch {
    return "<invalid>";
  }
}

function loadNetworkState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NETWORK_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function lastGoodSource(previous, incoming) {
  if (incoming && incoming !== "lastGood") return incoming;
  if (previous && previous !== "lastGood") return previous;
  return incoming || previous || "lastGood";
}

function persistLastGood(signature) {
  if (!signature?.proxyUrl) return;
  try {
    const current = loadNetworkState();
    writeJsonAtomic(NETWORK_FILE, {
      ...current,
      lastGood: {
        source: lastGoodSource(current.lastGood?.source, signature.source),
        proxyUrl: signature.proxyUrl,
        probedAt: Date.now(),
      },
    }, { backup: false });
  } catch {}
}

function readCursorHttpProxy() {
  const settingsPath = path.join(process.env.APPDATA || "", "Cursor", "User", "settings.json");
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      return String(parsed["http.proxy"] || "").trim();
    } catch {
      return /"http\.proxy"\s*:\s*"([^"]+)"/.exec(raw)?.[1]?.trim() || "";
    }
  } catch {
    return "";
  }
}

function readConfigProxyPorts() {
  const files = [
    path.join(HOME, ".config", "clash", "config.yaml"),
    path.join(process.env.APPDATA || "", "clash", "config.yaml"),
    path.join(process.env.USERPROFILE || "", ".config", "clash", "config.yaml"),
  ];
  const ports = [];
  for (const filePath of files) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const mixed = /(?:^|\n)\s*mixed-port:\s*(\d+)/i.exec(raw);
      const port = /(?:^|\n)\s*port:\s*(\d+)/i.exec(raw);
      const socks = /(?:^|\n)\s*socks-port:\s*(\d+)/i.exec(raw);
      for (const match of [mixed, port, socks]) {
        const value = Number(match?.[1] || 0);
        if (value > 0 && value < 65536) ports.push(value);
      }
    } catch {}
  }
  return ports;
}

function collectCandidatesFromHints(hints = {}) {
  const list = [];
  const seen = new Set();
  const add = (source, proxyUrl) => {
    const normalized = normalizeProxyRule(proxyUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    list.push({ source, proxyUrl: normalized });
  };

  if (hints.override) add("override", hints.override);
  if (hints.lastGood) add("lastGood", hints.lastGood);
  if (hints.envProxy) add("env", hints.envProxy);

  const windows = hints.windows || { enabled: false, server: "" };
  for (const server of parseWindowsProxyServer(windows.server)) {
    add(windows.enabled ? "windows" : "windowsLeftover", server);
  }

  if (hints.pacRule) add("pac", hints.pacRule);
  if (hints.cursorProxy) add("cursor", hints.cursorProxy);

  const ports = [...new Set([...(hints.extraPorts || []), ...LOCAL_PROXY_PORTS])];
  for (const port of ports) add("portScan", `http://127.0.0.1:${port}`);
  return list;
}

async function collectCandidates(url, extras = {}) {
  const stored = loadNetworkState();
  return collectCandidatesFromHints({
    override: stored.overrideProxyUrl,
    lastGood: stored.lastGood?.proxyUrl,
    envProxy: getEnvProxyForUrl(url),
    windows: extras.windows || await readWindowsInternetProxy(),
    pacRule: extras.pacRule || "",
    cursorProxy: extras.cursorProxy ?? readCursorHttpProxy(),
    extraPorts: extras.extraPorts || readConfigProxyPorts(),
  });
}

function connectWithTimeout(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const finish = (error) => {
      socket.removeAllListeners();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(null));
    socket.once("timeout", () => finish(new Error("timeout")));
    socket.once("error", finish);
  });
}

async function isPortOpen(host, port) {
  try {
    const socket = await connectWithTimeout(host, port, PORT_OPEN_MS);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

function readHttpStatus(socket) {
  return new Promise((resolve, reject) => {
    socket.once("data", (chunk) => resolve(String(chunk)));
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("timeout")));
  });
}

async function probeHttpConnect(proxyHost, proxyPort, destHost) {
  let socket;
  try {
    socket = await connectWithTimeout(proxyHost, proxyPort, CONNECT_PROBE_MS);
    socket.setTimeout(CONNECT_PROBE_MS);
    socket.write(`CONNECT ${destHost}:443 HTTP/1.1\r\nHost: ${destHost}:443\r\n\r\n`);
    const response = await readHttpStatus(socket);
    return /^HTTP\/1\.[01] 200\b/i.test(response);
  } catch {
    return false;
  } finally {
    socket?.destroy();
  }
}

async function probeSocks5(proxyHost, proxyPort) {
  let socket;
  try {
    socket = await connectWithTimeout(proxyHost, proxyPort, CONNECT_PROBE_MS);
    socket.setTimeout(CONNECT_PROBE_MS);
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const chunk = await new Promise((resolve, reject) => {
      socket.once("data", resolve);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("timeout")));
    });
    return Buffer.isBuffer(chunk) && chunk.length >= 2 && chunk[0] === 0x05 && chunk[1] === 0x00;
  } catch {
    return false;
  } finally {
    socket?.destroy();
  }
}

async function probeProxyUrl(proxyUrl, destHost) {
  try {
    const parsed = new URL(proxyUrl);
    const host = parsed.hostname;
    const port = Number(parsed.port || (/^https:$/i.test(parsed.protocol) ? 443 : 80));
    if (!host || !port) return false;
    if (!(await isPortOpen(host, port))) return false;
    if (/^https?:$/i.test(parsed.protocol)) return probeHttpConnect(host, port, destHost);
    if (/^socks5h?:$/i.test(parsed.protocol)) return probeSocks5(host, port);
    return false;
  } catch {
    return false;
  }
}

function socksFallbackUrl(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    if (!/^http:$/i.test(parsed.protocol) || !isLocalProxyHost(parsed.hostname)) return "";
    return `socks5h://${parsed.host}`;
  } catch {
    return "";
  }
}

async function lookupAddresses(host) {
  try {
    const looked = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("dns-timeout")), DNS_LOOKUP_MS)),
    ]);
    return Array.isArray(looked) ? looked.map((item) => item.address) : [];
  } catch {
    return [];
  }
}

async function hostLooksPoisoned(host) {
  const addresses = await lookupAddresses(host);
  return addresses.some((item) => isPoisonedIp(item));
}

async function readPacRule(url) {
  try {
    const electron = require("electron");
    return normalizeProxyRule(await electron.session?.defaultSession?.resolveProxy?.(url));
  } catch {
    return "";
  }
}

function composeNoProxy() {
  const seen = new Set();
  const parts = [];
  for (const raw of [inheritedProxyEnv.no_proxy, inheritedProxyEnv.NO_PROXY, LOCAL_NO_PROXY]) {
    if (!raw) continue;
    for (const item of String(raw).split(",")) {
      const host = item.trim();
      if (!host || seen.has(host)) continue;
      seen.add(host);
      parts.push(host);
    }
  }
  return parts.join(",");
}

function syncProxyEnv(proxyUrl) {
  if (!proxyUrl) {
    for (const key of PROXY_ENV_KEYS) {
      if (inheritedProxyEnv[key] == null) delete process.env[key];
      else process.env[key] = inheritedProxyEnv[key];
    }
    const noProxy = composeNoProxy();
    for (const key of NO_PROXY_KEYS) process.env[key] = noProxy;
    return;
  }

  for (const key of PROXY_ENV_KEYS) process.env[key] = proxyUrl;
  const noProxy = composeNoProxy();
  for (const key of NO_PROXY_KEYS) process.env[key] = noProxy;
}

function logProxySignature(signature) {
  try {
    const { logInfo } = require("./logger");
    const proxy = signature.proxyUrl ? redactProxyUrl(signature.proxyUrl) : "<none>";
    logInfo(`[Proxy] source=${signature.source} proxy_url=${proxy} probed=${signature.probed ? "ok" : "skip"}`);
  } catch {}
}

async function resolveLiveProxy(url = "https://chatgpt.com/") {
  const destHost = (() => { try { return new URL(url).hostname; } catch { return "chatgpt.com"; } })();
  const cached = liveByHost.get(destHost);
  if (cached?.proxyUrl) return cached;
  if (liveSignature?.proxyUrl && await probeProxyUrl(liveSignature.proxyUrl, destHost)) {
    liveByHost.set(destHost, liveSignature);
    return liveSignature;
  }

  const poisoned = await hostLooksPoisoned(destHost);
  const candidates = await collectCandidates(url, { pacRule: await readPacRule(url) });

  for (const candidate of candidates) {
    if (await probeProxyUrl(candidate.proxyUrl, destHost)) {
      liveSignature = { ...candidate, probed: true };
      liveByHost.set(destHost, liveSignature);
      persistLastGood(liveSignature);
      return liveSignature;
    }
    const socksUrl = socksFallbackUrl(candidate.proxyUrl);
    if (socksUrl && socksUrl !== candidate.proxyUrl && await probeProxyUrl(socksUrl, destHost)) {
      liveSignature = { source: candidate.source, proxyUrl: socksUrl, probed: true };
      liveByHost.set(destHost, liveSignature);
      persistLastGood(liveSignature);
      return liveSignature;
    }
  }

  if (!poisoned) {
    return { source: "direct", proxyUrl: "", probed: false };
  }
  return { source: "none", proxyUrl: "", probed: false };
}

function invalidateLiveProxy() {
  liveSignature = null;
  liveByHost.clear();
  appliedProxyUrl = undefined;
}

async function discoverProxyForUrl(url) {
  const signature = await resolveLiveProxy(url);
  return signature.proxyUrl || "";
}

async function applySignatureToRuntime(signature, options = {}) {
  const touchSession = options.touchSession !== false;
  const nextUrl = signature.proxyUrl || "";
  if (appliedProxyUrl === nextUrl) {
    syncProxyEnv(nextUrl);
    return { ...signature, mode: nextUrl ? "explicit" : "system" };
  }
  appliedProxyUrl = nextUrl;
  syncProxyEnv(signature.proxyUrl);
  logProxySignature(signature);
  if (!touchSession) {
    return { ...signature, mode: nextUrl ? "explicit" : "system" };
  }

  let session = null;
  try {
    session = require("electron").session?.defaultSession;
  } catch {
    return { ...signature, mode: signature.proxyUrl ? "explicit" : "system" };
  }
  if (!session?.setProxy) return { ...signature, mode: signature.proxyUrl ? "explicit" : "system" };

  if (signature.proxyUrl) {
    const chromiumRules = signature.proxyUrl.replace(/^socks5h:/i, "socks5:").replace(/^socks4a:/i, "socks4:");
    await session.setProxy({
      proxyRules: chromiumRules,
      proxyBypassRules: "localhost,127.0.0.1,<local>",
    });
    return { ...signature, mode: "explicit" };
  }

  await session.setProxy({ mode: "system" });
  return { ...signature, mode: "system" };
}

async function applyStartupProxyHint() {
  const { initLogger } = require("./logger");
  initLogger();
  const lastGood = loadNetworkState().lastGood;
  if (lastGood?.proxyUrl) {
    return applySignatureToRuntime({
      source: lastGood.source || "lastGood",
      proxyUrl: lastGood.proxyUrl,
      probed: false,
    });
  }
  return applySignatureToRuntime({ source: "system", proxyUrl: "", probed: false });
}

async function applyAppProxy() {
  const { initLogger } = require("./logger");
  initLogger();
  const signature = await resolveLiveProxy("https://chatgpt.com/");
  return applySignatureToRuntime(signature);
}

module.exports = {
  NETWORK_FILE,
  normalizeProxyRule,
  parseWindowsProxyServer,
  parseWindowsProxyEnable,
  readWindowsInternetProxy,
  socksFallbackUrl,
  isPoisonedIp,
  isLocalProxyHost,
  redactProxyUrl,
  lastGoodSource,
  collectCandidatesFromHints,
  collectCandidates,
  probeProxyUrl,
  hostLooksPoisoned,
  resolveLiveProxy,
  invalidateLiveProxy,
  discoverProxyForUrl,
  applyAppProxy,
  applyStartupProxyHint,
  applySignatureToRuntime,
  loadNetworkState,
  syncProxyEnv,
};

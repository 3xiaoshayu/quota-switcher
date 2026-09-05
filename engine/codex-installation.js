const cp = require("node:child_process");
const { CODEX_AUMID } = require("./config");

const DETECT_TIMEOUT_MS = 4000;
let cachedStatus = null;
let cachedAt = 0;
const CACHE_MS = 60 * 1000;
// A PowerShell hiccup (slow start, AV scan) is not "Codex is not installed".
// Keep that answer only briefly so the next switch re-checks instead of
// failing for a whole minute.
const FAILURE_CACHE_MS = 5 * 1000;

function emptyStatus(extra) {
  return {
    appId: CODEX_AUMID,
    source: "microsoft-store",
    supported: process.platform === "win32",
    installed: false,
    ...(extra || {}),
  };
}

function startAppsScript() {
  const appId = CODEX_AUMID.replace(/'/g, "''");
  return `$app = Get-StartApps | Where-Object { $_.AppID -eq '${appId}' } | Select-Object -First 1 Name, AppID; ` +
    "if ($null -eq $app) { '{}' } else { $app | ConvertTo-Json -Compress }";
}

function parseStartAppsOutput(output) {
  const app = output ? JSON.parse(output) : {};
  if (app && app.AppID === CODEX_AUMID) {
    return {
      appId: CODEX_AUMID,
      source: "microsoft-store",
      supported: process.platform === "win32",
      installed: true,
      name: app.Name || "Codex",
    };
  }
  return emptyStatus({ reason: "not-found" });
}

function remember(status) {
  cachedStatus = status;
  cachedAt = Date.now();
  return status;
}

function cacheWindowFor(status) {
  return status?.reason === "detection-failed" ? FAILURE_CACHE_MS : CACHE_MS;
}

function getCachedStatus(now = Date.now()) {
  if (cachedStatus && (now - cachedAt) < cacheWindowFor(cachedStatus)) return cachedStatus;
  return null;
}

function resetCodexInstallationCacheForTests() {
  cachedStatus = null;
  cachedAt = 0;
}

function runPowerShell(script) {
  return cp.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: DETECT_TIMEOUT_MS, windowsHide: true },
  ).trim();
}

function getCodexInstallationStatus() {
  const cached = getCachedStatus();
  if (cached) return cached;

  if (process.platform !== "win32") {
    return remember(emptyStatus({ reason: "windows-only" }));
  }

  try {
    return remember(parseStartAppsOutput(runPowerShell(startAppsScript())));
  } catch (error) {
    return remember(emptyStatus({
      reason: "detection-failed",
      error: error.message || String(error),
    }));
  }
}

function getCodexInstallationStatusAsync() {
  const cached = getCachedStatus();
  if (cached) return Promise.resolve(cached);

  if (process.platform !== "win32") {
    return Promise.resolve(remember(emptyStatus({ reason: "windows-only" })));
  }

  return new Promise((resolve) => {
    const child = cp.execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", startAppsScript()],
      { encoding: "utf8", timeout: DETECT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(remember(emptyStatus({
            reason: "detection-failed",
            error: error.message || String(error),
          })));
          return;
        }
        try {
          resolve(remember(parseStartAppsOutput(String(stdout || "").trim())));
        } catch (parseError) {
          resolve(remember(emptyStatus({
            reason: "detection-failed",
            error: parseError.message || String(parseError),
          })));
        }
      },
    );
    const killer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, DETECT_TIMEOUT_MS + 500);
    child.on("close", () => clearTimeout(killer));
  });
}

function assertOfficialCodexInstalled() {
  const status = getCodexInstallationStatus();
  if (!status.installed) {
    const error = new Error("未检测到官方 Microsoft Store 版 Codex。请先从 Microsoft Store 安装 Codex，再回来切换账号。");
    error.code = "CODEX_NOT_INSTALLED";
    error.codexStatus = status;
    throw error;
  }
  return status;
}

async function assertOfficialCodexInstalledAsync() {
  const status = await getCodexInstallationStatusAsync();
  if (!status.installed) {
    const error = new Error("未检测到官方 Microsoft Store 版 Codex。请先从 Microsoft Store 安装 Codex，再回来切换账号。");
    error.code = "CODEX_NOT_INSTALLED";
    error.codexStatus = status;
    throw error;
  }
  return status;
}

module.exports = {
  getCodexInstallationStatus,
  getCodexInstallationStatusAsync,
  assertOfficialCodexInstalled,
  assertOfficialCodexInstalledAsync,
  parseStartAppsOutput,
  cacheWindowFor,
  resetCodexInstallationCacheForTests,
  CACHE_MS,
  FAILURE_CACHE_MS,
};

const cp = require("node:child_process");
const { CODEX_AUMID } = require("./config");

function runPowerShell(script) {
  return cp.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 6000, windowsHide: true },
  ).trim();
}

function getCodexInstallationStatus() {
  const base = {
    appId: CODEX_AUMID,
    source: "microsoft-store",
    supported: process.platform === "win32",
    installed: false,
  };

  if (process.platform !== "win32") {
    return { ...base, reason: "windows-only" };
  }

  try {
    const appId = CODEX_AUMID.replace(/'/g, "''");
    const output = runPowerShell(
      `$app = Get-StartApps | Where-Object { $_.AppID -eq '${appId}' } | Select-Object -First 1 Name, AppID; ` +
      "if ($null -eq $app) { '{}' } else { $app | ConvertTo-Json -Compress }",
    );
    const app = output ? JSON.parse(output) : {};
    if (app && app.AppID === CODEX_AUMID) {
      return {
        ...base,
        installed: true,
        name: app.Name || "Codex",
      };
    }
    return { ...base, reason: "not-found" };
  } catch (error) {
    return {
      ...base,
      reason: "detection-failed",
      error: error.message || String(error),
    };
  }
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

module.exports = {
  getCodexInstallationStatus,
  assertOfficialCodexInstalled,
};

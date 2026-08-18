const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { httpJson } = require("./http-client");
const { logWarn } = require("./logger");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, options, (error, stdout, stderr) => {
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

function roamingAppData() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function userDataCandidates() {
  return [
    path.join(roamingAppData(), "Antigravity IDE"),
    path.join(roamingAppData(), "Antigravity"),
  ];
}

function stateDbForUserData(userDataDir) {
  return path.join(userDataDir, "User", "globalStorage", "state.vscdb");
}

function preferUserDataDir() {
  const candidates = userDataCandidates();
  for (const candidate of candidates) {
    if (fs.existsSync(stateDbForUserData(candidate))) return candidate;
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function defaultVscdbPath() {
  return stateDbForUserData(preferUserDataDir());
}

function defaultExeCandidates() {
  const local = localAppData();
  return [
    path.join(local, "Programs", "Antigravity IDE", "Antigravity IDE.exe"),
    path.join(local, "Programs", "Antigravity", "Antigravity IDE.exe"),
    path.join(local, "Programs", "antigravity", "Antigravity.exe"),
    path.join(local, "Programs", "Antigravity", "Antigravity.exe"),
  ];
}

function firstExistingExe() {
  for (const candidate of defaultExeCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseRunningExe(output) {
  const exe = String(output || "").trim().replace(/^['"]+|['"]+$/g, "");
  return exe && fs.existsSync(exe) ? exe : null;
}

const RUNNING_COMMAND = "$p = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.Name -eq 'Antigravity IDE.exe' -or ($_.Name -eq 'Antigravity.exe' -and ($_.ExecutablePath -like '*\\Antigravity IDE\\*' -or $_.ExecutablePath -like '*\\Programs\\antigravity\\*' -or $_.ExecutablePath -like '*\\Programs\\Antigravity\\*'))) } | Select-Object -First 1 -ExpandProperty ExecutablePath; if ($p) { $p } else { '' }";

function findRunningExe() {
  try {
    const output = cp.execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      RUNNING_COMMAND,
    ], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    return parseRunningExe(output);
  } catch {
    return null;
  }
}

async function findRunningExeAsync() {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      RUNNING_COMMAND,
    ], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    return parseRunningExe(stdout);
  } catch {
    return null;
  }
}

function defaultExePath() {
  return firstExistingExe();
}

function processPath(item) {
  return String(item?.executablePath || "").replace(/\//g, "\\").toLowerCase();
}

function isThisManagerPath(exe) {
  return exe.includes("codex-account-manager") || exe.includes("codex-deskep");
}

function isOfficialIdePath(exe) {
  return exe.includes("\\antigravity ide\\");
}

function isOfficialHubPath(exe) {
  return /\\programs\\antigravity\\/.test(exe);
}

function isOfficialAntigravityPath(exe) {
  return isOfficialIdePath(exe) || isOfficialHubPath(exe);
}

function isAntigravityProcess(item) {
  const name = String(item?.name || "").toLowerCase();
  const exe = processPath(item);
  if (isThisManagerPath(exe)) return false;
  if (name === "antigravity ide.exe") return true;
  if (name === "antigravity.exe") return isOfficialAntigravityPath(exe);
  if (name !== "electron.exe") return false;
  return isOfficialAntigravityPath(exe);
}

async function defaultListProcesses(runCommand = execFileAsync) {
  const script = [
    "$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Antigravity IDE.exe','Antigravity.exe','electron.exe') }",
    "$match = @($items | Where-Object { $_.Name -eq 'Antigravity IDE.exe' -or ($_.Name -eq 'Antigravity.exe' -and ($_.ExecutablePath -like '*\\Antigravity IDE\\*' -or $_.ExecutablePath -like '*\\Programs\\antigravity\\*' -or $_.ExecutablePath -like '*\\Programs\\Antigravity\\*')) -or ($_.Name -eq 'electron.exe' -and ($_.ExecutablePath -like '*\\Antigravity IDE\\*' -or $_.ExecutablePath -like '*\\Programs\\antigravity\\*')) })",
    "$ids = New-Object 'System.Collections.Generic.HashSet[int]'",
    "$match | ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }",
    "do { $changed = $false; foreach ($item in $items) { if ($ids.Contains([int]$item.ParentProcessId) -and -not $ids.Contains([int]$item.ProcessId)) { [void]$ids.Add([int]$item.ProcessId); $changed = $true } } } while ($changed)",
    "@($items | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{ Name = $_.Name; ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; ExecutablePath = $_.ExecutablePath } }) | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    const output = String(stdout || "").trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      name: item.Name,
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      executablePath: item.ExecutablePath || null,
    })).filter((item) => Number.isInteger(item.pid) && item.pid > 0 && isAntigravityProcess({
      name: item.Name || item.name,
      executablePath: item.ExecutablePath || item.executablePath,
    }));
  } catch (error) {
    const wrapped = new Error(`Could not enumerate official Antigravity IDE processes: ${error.message}`, { cause: error });
    wrapped.code = "antigravity_process_enumeration_failed";
    logWarn(wrapped.message);
    throw wrapped;
  }
}

function launchAntigravity(exePath, childProcess = cp) {
  const target = exePath || defaultExePath();
  if (!target) {
    const error = new Error("Official Antigravity IDE was not found");
    error.code = "antigravity_app_path_not_found";
    throw error;
  }
  const child = childProcess.spawn(target, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once?.("error", (error) => {
    logWarn(`Could not launch official Antigravity IDE: ${error.message}`);
  });
  child.unref?.();
  return true;
}

const defaultRuntime = {
  httpJson,
  sleep,
  now: () => Date.now(),
  openUrl: null,
  vscdbPath: defaultVscdbPath,
  exePath: defaultExePath,
  listProcesses: defaultListProcesses,
  async gracefulClose(pid) {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  },
  async forceClose(pid) {
    try {
      await execFileAsync("taskkill.exe", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  },
  launch(exePath) {
    return launchAntigravity(exePath);
  },
};

let runtime = { ...defaultRuntime };

function getAntigravityRuntime() {
  return runtime;
}

function setAntigravityRuntimeForTests(nextRuntime = null) {
  runtime = nextRuntime ? { ...defaultRuntime, ...nextRuntime } : { ...defaultRuntime };
}

function setAntigravityOpenUrlHandler(handler) {
  runtime.openUrl = typeof handler === "function" ? handler : null;
}

module.exports = {
  getAntigravityRuntime,
  setAntigravityRuntimeForTests,
  setAntigravityOpenUrlHandler,
  defaultVscdbPath,
  defaultExePath,
  defaultExeCandidates,
  firstExistingExe,
  findRunningExeAsync,
  isAntigravityProcess,
  isOfficialHubPath,
  launchAntigravity,
  preferUserDataDir,
  userDataCandidates,
};

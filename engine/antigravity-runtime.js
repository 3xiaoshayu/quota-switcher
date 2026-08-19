const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { httpJson } = require("./http-client");
const {
  readWindowsAntigravityCredential,
  writeWindowsAntigravityCredential,
  restoreWindowsAntigravityCredential,
} = require("./antigravity-credential");
const { logInfo, logWarn } = require("./logger");
const { isThisAppPath } = require("./app-brand");

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

function preferUserDataDirForExe(exePath) {
  const [ideDir, hubDir] = userDataCandidates();
  const exe = processPath({ executablePath: exePath });
  if (isOfficialHubPath(exe) && !isOfficialIdePath(exe)) return hubDir;
  if (isOfficialIdePath(exe)) return ideDir;
  return null;
}

function preferUserDataDir(exePath) {
  const fromExe = preferUserDataDirForExe(exePath || firstExistingExe());
  if (fromExe) return fromExe;
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
    path.join(local, "Programs", "antigravity", "Antigravity.exe"),
    path.join(local, "Programs", "Antigravity", "Antigravity.exe"),
    path.join(local, "Programs", "Antigravity IDE", "Antigravity IDE.exe"),
    path.join(local, "Programs", "Antigravity", "Antigravity IDE.exe"),
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
  return isThisAppPath(exe);
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
  if (name === "antigravity.exe") {
    if (!exe) return true;
    return isOfficialAntigravityPath(exe);
  }
  if (name !== "electron.exe") return false;
  return isOfficialAntigravityPath(exe);
}

const LIST_ANTIGRAVITY_PROCESSES_COMMAND = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$rows = @(Get-Process -Name 'Antigravity','Antigravity IDE' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Name = ($_.ProcessName + '.exe'); ProcessId = $_.Id; ParentProcessId = 0; ExecutablePath = $_.Path } })",
  "if ($rows.Count -eq 0) { '[]' } else { @($rows) | ConvertTo-Json -Compress }",
].join("; ");

async function defaultListProcesses(runCommand = execFileAsync) {
  try {
    const { stdout } = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", LIST_ANTIGRAVITY_PROCESSES_COMMAND], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    const output = String(stdout || "").trim();
    if (!output || output === "[]") return [];
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

function usesWindowsSystemCredential(exePath) {
  const exe = processPath({ executablePath: exePath || "" });
  return !!exe && isOfficialHubPath(exe) && !isOfficialIdePath(exe);
}

function clearStaleAntigravityLock(userDataDir) {
  if (!userDataDir) return false;
  let cleared = false;
  for (const name of ["lockfile", "DevToolsActivePort"]) {
    const target = path.join(userDataDir, name);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        cleared = true;
      }
    } catch (error) {
      logWarn(`Could not clear official Antigravity lock ${name}: ${error.message}`);
    }
  }
  return cleared;
}

function launchArgsFor(userDataDir) {
  const args = [];
  if (userDataDir) {
    args.push("--user-data-dir", userDataDir);
  }
  args.push("--reuse-window");
  return args;
}

function spawnOfficialGui(target, args, childProcess) {
  if (process.platform === "win32") {
    return childProcess.spawn(process.env.ComSpec || "cmd.exe", [
      "/d",
      "/c",
      "start",
      "",
      "/D",
      path.dirname(target),
      target,
      ...args,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  }
  return childProcess.spawn(target, args, {
    detached: true,
    stdio: "ignore",
  });
}

function launchAntigravity(exePath, childProcess = cp, options = {}) {
  const target = exePath || defaultExePath();
  if (!target) {
    const error = new Error("Official Antigravity IDE was not found");
    error.code = "antigravity_app_path_not_found";
    throw error;
  }
  const userDataDir = options.userDataDir || preferUserDataDirForExe(target) || preferUserDataDir();
  const args = launchArgsFor(userDataDir);
  const child = spawnOfficialGui(target, args, childProcess);
  child.once?.("error", (error) => {
    logWarn(`Could not launch official Antigravity: ${error.message}`);
  });
  child.unref?.();
  logInfo(`Launching official Antigravity: ${target}`);
  return true;
}

const defaultRuntime = {
  httpJson,
  sleep,
  now: () => Date.now(),
  openUrl: null,
  execFile: execFileAsync,
  vscdbPath: defaultVscdbPath,
  exePath: defaultExePath,
  userDataDir: preferUserDataDir,
  listProcesses: defaultListProcesses,
  writeSystemCredential: writeWindowsAntigravityCredential,
  restoreSystemCredential: restoreWindowsAntigravityCredential,
  readSystemCredential: readWindowsAntigravityCredential,
  clearStaleLock: clearStaleAntigravityLock,
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
  launch(exePath, options) {
    return launchAntigravity(exePath, cp, options);
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
  preferUserDataDirForExe,
  usesWindowsSystemCredential,
  clearStaleAntigravityLock,
  userDataCandidates,
};

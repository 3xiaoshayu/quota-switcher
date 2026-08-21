const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { httpJson } = require("./http-client");
const { logWarn } = require("./logger");
const { pathExists } = require("./atomic-file");
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

function defaultVscdbPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
}

function defaultCursorExeCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return [
    path.join(local, "Programs", "cursor", "Cursor.exe"),
    path.join(local, "Programs", "Cursor", "Cursor.exe"),
  ];
}

function firstExistingCursorExe() {
  for (const candidate of defaultCursorExeCandidates()) {
    if (pathExists(candidate)) return candidate;
  }
  return null;
}

function parseRunningCursorExe(output) {
  const exe = String(output || "").trim().replace(/^['"]+|['"]+$/g, "");
  if (exe && pathExists(exe)) return exe;
  return null;
}

const RUNNING_CURSOR_COMMAND = "$p = Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path; if ($p) { $p } else { '' }";

function findRunningCursorExe() {
  try {
    const output = cp.execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      RUNNING_CURSOR_COMMAND,
    ], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    return parseRunningCursorExe(output);
  } catch {}
  return null;
}

async function findRunningCursorExeAsync() {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      RUNNING_CURSOR_COMMAND,
    ], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    return parseRunningCursorExe(stdout);
  } catch {
    return null;
  }
}

function defaultCursorExePath() {
  return firstExistingCursorExe();
}

function processPath(item) {
  return String(item?.executablePath || "").replace(/\//g, "\\").toLowerCase();
}

function isCursorProcess(item) {
  const name = String(item?.name || "").toLowerCase();
  const exe = processPath(item);
  if (name === "cursor.exe") return true;
  if (name !== "electron.exe") return false;
  if (!exe.includes("\\cursor\\")) return false;
  if (isThisAppPath(exe)) return false;
  return true;
}

const LIST_CURSOR_PROCESSES_COMMAND = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$rows = @(Get-Process -Name 'Cursor','electron' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Name = ($_.ProcessName + '.exe'); ProcessId = $_.Id; ParentProcessId = 0; ExecutablePath = $_.Path } })",
  "if ($rows.Count -eq 0) { '[]' } else { @($rows) | ConvertTo-Json -Compress }",
].join("; ");

function mapListedProcess(item) {
  const name = item.Name || item.name;
  const executablePath = item.ExecutablePath || item.executablePath || null;
  return {
    name,
    pid: Number(item.ProcessId ?? item.pid),
    parentPid: Number(item.ParentProcessId ?? item.parentPid) || 0,
    executablePath,
  };
}

async function defaultListProcesses(runCommand = execFileAsync) {
  try {
    const { stdout } = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", LIST_CURSOR_PROCESSES_COMMAND], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    const output = String(stdout || "").trim();
    if (!output || output === "[]") return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map(mapListedProcess)
      .filter((item) => Number.isInteger(item.pid) && item.pid > 0 && isCursorProcess(item));
  } catch (error) {
    const wrapped = new Error(`Could not enumerate official Cursor processes: ${error.message}`, { cause: error });
    wrapped.code = "cursor_process_enumeration_failed";
    logWarn(wrapped.message);
    throw wrapped;
  }
}

function launchCursor(exePath, childProcess = cp) {
  const target = exePath || defaultCursorExePath();
  if (!target) {
    const error = new Error("Official Cursor was not found");
    error.code = "cursor_app_path_not_found";
    throw error;
  }
  const child = childProcess.spawn(target, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once?.("error", (error) => {
    logWarn(`Could not launch official Cursor: ${error.message}`);
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
  cursorExePath: defaultCursorExePath,
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
    return launchCursor(exePath);
  },
};

let runtime = { ...defaultRuntime };

function getCursorRuntime() {
  return runtime;
}

function setCursorRuntimeForTests(nextRuntime = null) {
  runtime = nextRuntime ? { ...defaultRuntime, ...nextRuntime } : { ...defaultRuntime };
}

function setCursorOpenUrlHandler(handler) {
  runtime.openUrl = typeof handler === "function" ? handler : null;
}

module.exports = {
  getCursorRuntime,
  setCursorRuntimeForTests,
  setCursorOpenUrlHandler,
  defaultVscdbPath,
  defaultCursorExePath,
  defaultCursorExeCandidates,
  firstExistingCursorExe,
  findRunningCursorExeAsync,
  defaultListProcesses,
  isCursorProcess,
  launchCursor,
};

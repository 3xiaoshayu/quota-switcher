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
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseRunningCursorExe(output) {
  const exe = String(output || "").trim().replace(/^['"]+|['"]+$/g, "");
  if (exe && fs.existsSync(exe)) return exe;
  return null;
}

const RUNNING_CURSOR_COMMAND = "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Cursor.exe' -and $_.ExecutablePath } | Select-Object -First 1 -ExpandProperty ExecutablePath; if ($p) { $p } else { '' }";

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
  if (exe.includes("codex-account-manager") || exe.includes("codex-deskep")) return false;
  return true;
}

async function defaultListProcesses(runCommand = execFileAsync) {
  const script = [
    "$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Cursor.exe','electron.exe') }",
    "$cursor = @($items | Where-Object { $_.Name -eq 'Cursor.exe' -or ($_.Name -eq 'electron.exe' -and (($_.ExecutablePath -like '*\\Cursor\\*') -or ($_.ExecutablePath -like '*\\cursor\\*'))) })",
    "$ids = New-Object 'System.Collections.Generic.HashSet[int]'",
    "$cursor | ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }",
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
    })).filter((item) => Number.isInteger(item.pid) && item.pid > 0 && isCursorProcess({
      name: item.Name || item.name,
      executablePath: item.ExecutablePath || item.executablePath,
    }));
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
  isCursorProcess,
  launchCursor,
};

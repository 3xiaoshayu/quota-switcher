const fs = require("node:fs");
const {
  defaultCursorExePath,
  defaultVscdbPath,
  firstExistingCursorExe,
  findRunningCursorExeAsync,
  getCursorRuntime,
} = require("./cursor-runtime");

let cachedStatus = null;
let cachedAt = 0;
const CACHE_MS = 60 * 1000;

function resolveDbPath(runtime) {
  return typeof runtime.vscdbPath === "function" ? runtime.vscdbPath() : defaultVscdbPath();
}

function hasCustomExeResolver(runtime) {
  return typeof runtime.cursorExePath === "function" && runtime.cursorExePath !== defaultCursorExePath;
}

function resolveFastExePath(runtime) {
  if (hasCustomExeResolver(runtime)) {
    return runtime.cursorExePath();
  }
  return firstExistingCursorExe();
}

function buildStatus(exePath, dbPath, source) {
  const installed = !!exePath && fs.existsSync(exePath);
  const vscdbPresent = !!dbPath && fs.existsSync(dbPath);
  return {
    installed,
    exePath: installed ? exePath : null,
    vscdbPath: dbPath,
    vscdbPresent,
    supported: process.platform === "win32",
    source: installed ? source : (vscdbPresent ? "local-login" : "unknown"),
  };
}

function remember(status) {
  cachedStatus = status;
  cachedAt = Date.now();
  return status;
}

function getCursorInstallationStatus() {
  if (cachedStatus && (Date.now() - cachedAt) < CACHE_MS) return cachedStatus;
  const runtime = getCursorRuntime();
  return remember(buildStatus(resolveFastExePath(runtime), resolveDbPath(runtime), "local-install"));
}

async function getCursorInstallationStatusAsync() {
  if (cachedStatus && cachedStatus.installed && (Date.now() - cachedAt) < CACHE_MS) {
    return cachedStatus;
  }
  const runtime = getCursorRuntime();
  const dbPath = resolveDbPath(runtime);
  let exePath = resolveFastExePath(runtime);
  let source = "local-install";
  if (!hasCustomExeResolver(runtime) && (!exePath || !fs.existsSync(exePath))) {
    exePath = await findRunningCursorExeAsync();
    source = "running-process";
  }
  return remember(buildStatus(exePath, dbPath, source));
}

function assertOfficialCursorInstalled() {
  const runtime = getCursorRuntime();
  const exePath = typeof runtime.cursorExePath === "function" ? runtime.cursorExePath() : defaultCursorExePath();
  const status = buildStatus(exePath, resolveDbPath(runtime), "local-install");
  if (status.installed) {
    remember(status);
    return status;
  }
  const error = new Error("Official Cursor was not found");
  error.code = "cursor_app_path_not_found";
  throw error;
}

module.exports = {
  getCursorInstallationStatus,
  getCursorInstallationStatusAsync,
  assertOfficialCursorInstalled,
};

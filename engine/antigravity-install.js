const { pathExists } = require("./atomic-file");
const {
  defaultExePath,
  defaultVscdbPath,
  firstExistingExe,
  findRunningExeAsync,
  getAntigravityRuntime,
} = require("./antigravity-runtime");

let cachedStatus = null;
let cachedAt = 0;
const CACHE_MS = 60 * 1000;

function resolveDbPath(runtime) {
  return typeof runtime.vscdbPath === "function" ? runtime.vscdbPath() : defaultVscdbPath();
}

function hasCustomExeResolver(runtime) {
  return typeof runtime.exePath === "function" && runtime.exePath !== defaultExePath;
}

function resolveFastExePath(runtime) {
  if (hasCustomExeResolver(runtime)) return runtime.exePath();
  return firstExistingExe();
}

function buildStatus(exePath, dbPath, source) {
  const installed = !!exePath && pathExists(exePath);
  const vscdbPresent = !!dbPath && pathExists(dbPath);
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

function getAntigravityInstallationStatus() {
  if (cachedStatus && (Date.now() - cachedAt) < CACHE_MS) return cachedStatus;
  const runtime = getAntigravityRuntime();
  return remember(buildStatus(resolveFastExePath(runtime), resolveDbPath(runtime), "local-install"));
}

async function getAntigravityInstallationStatusAsync() {
  if (cachedStatus && cachedStatus.installed && (Date.now() - cachedAt) < CACHE_MS) {
    return cachedStatus;
  }
  const runtime = getAntigravityRuntime();
  const dbPath = resolveDbPath(runtime);
  let exePath = resolveFastExePath(runtime);
  let source = "local-install";
  if (!hasCustomExeResolver(runtime) && (!exePath || !pathExists(exePath))) {
    exePath = await findRunningExeAsync();
    source = "running-process";
  }
  return remember(buildStatus(exePath, dbPath, source));
}

function assertOfficialAntigravityInstalled() {
  const runtime = getAntigravityRuntime();
  const exePath = typeof runtime.exePath === "function" ? runtime.exePath() : defaultExePath();
  const status = buildStatus(exePath, resolveDbPath(runtime), "local-install");
  if (status.installed) {
    remember(status);
    return status;
  }
  const error = new Error("Official Antigravity IDE was not found");
  error.code = "antigravity_app_path_not_found";
  throw error;
}

module.exports = {
  getAntigravityInstallationStatus,
  getAntigravityInstallationStatusAsync,
  assertOfficialAntigravityInstalled,
};

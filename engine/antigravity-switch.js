const path = require("node:path");
const { ts } = require("./crypto-utils");
const { getAntigravityRuntime, usesWindowsSystemCredential, preferUserDataDirForExe } = require("./antigravity-runtime");
const { writeAntigravityAuth, snapshotVscdb, restoreVscdbSnapshot, waitForAntigravityVscdbWritable, waitForWalToClear } = require("./antigravity-db");
const {
  saveAntigravityAcct,
  loadAntigravityIdx,
  setCurrentAntigravityAccountId,
  upsertAntigravityIndex,
  snapshotAntigravityMeta,
  restoreAntigravityMeta,
} = require("./antigravity-storage");
const { getAntigravityInstallationStatusAsync, assertOfficialAntigravityInstalled } = require("./antigravity-install");
const { logInfo, logWarn, logError } = require("./logger");
const { describeCaughtError } = require("./sqlite-native");
const { pathExists } = require("./atomic-file");

const GRACEFUL_WAIT_MS = 1500;
const FORCE_WAIT_MS = 4000;
const LEFTOVER_WAIT_MS = 2500;
const PID_POLL_MS = 50;
const WAL_CLEAR_WAIT_MS = 2000;
const LOCK_RETRY_MS = 200;
const LOCK_POLL_MS = 50;

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForPidsToExit(pids, timeoutMs) {
  const runtime = getAntigravityRuntime();
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let remaining = pids.filter(pidIsAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await runtime.sleep(PID_POLL_MS);
    remaining = remaining.filter(pidIsAlive);
  }
  return remaining;
}

async function killAntigravity() {
  const runtime = getAntigravityRuntime();
  const processes = await runtime.listProcesses();
  const pids = [...new Set(processes.map((item) => item.pid).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (pids.length === 0) return [];
  await Promise.all(pids.map((pid) => runtime.gracefulClose(pid)));
  let remaining = await waitForPidsToExit(pids, GRACEFUL_WAIT_MS);
  if (remaining.length > 0) {
    await Promise.all(remaining.map((pid) => runtime.forceClose(pid)));
    remaining = await waitForPidsToExit(remaining, FORCE_WAIT_MS);
  }
  if (remaining.length > 0) {
    const error = new Error(`Official Antigravity IDE did not exit: ${remaining.join(", ")}`);
    error.code = "antigravity_process_still_running";
    throw error;
  }
  const leftovers = await runtime.listProcesses();
  if (leftovers.length > 0) {
    await Promise.all(leftovers.map((item) => runtime.forceClose(item.pid)));
    remaining = await waitForPidsToExit(leftovers.map((item) => item.pid), LEFTOVER_WAIT_MS);
    if (remaining.length > 0) {
      const error = new Error(`Official Antigravity IDE did not exit: ${remaining.join(", ")}`);
      error.code = "antigravity_process_still_running";
      throw error;
    }
  }
  logInfo(`Closed ${pids.length} official Antigravity process(es)`);
  return pids;
}

function injectToken(account) {
  return {
    access_token: account.tokens.access_token,
    refresh_token: account.tokens.refresh_token,
    token_type: account.tokens.token_type || "Bearer",
    expiry_timestamp: Number(account.tokens.expiry_timestamp || 0) || 0,
  };
}

function relaunchIfPossible(runtime, launchPath, options) {
  if (!launchPath) return;
  try { runtime.launch(launchPath, options); } catch {}
}

function resolveUserDataDir(runtime, launchPath) {
  if (typeof runtime.userDataDir === "function") {
    return runtime.userDataDir(launchPath);
  }
  return preferUserDataDirForExe(launchPath);
}

async function snapshotCredentialIfNeeded(runtime, writeCredential) {
  if (!writeCredential || typeof runtime.readSystemCredential !== "function") return null;
  try {
    return await runtime.readSystemCredential(runtime.execFile);
  } catch {
    return null;
  }
}

async function clearStaleLockWithRetry(runtime, userDataDir) {
  if (!userDataDir || typeof runtime.clearStaleLock !== "function") return;
  runtime.clearStaleLock(userDataDir);
  const lockPath = path.join(userDataDir, "lockfile");
  if (!pathExists(lockPath)) return;
  const deadline = Date.now() + LOCK_RETRY_MS;
  while (pathExists(lockPath) && Date.now() < deadline) {
    runtime.clearStaleLock(userDataDir);
    if (!pathExists(lockPath)) return;
    await runtime.sleep(LOCK_POLL_MS);
  }
}

async function doAntigravitySwitch(account) {
  if (!account?.id || !String(account.id).startsWith("antigravity_")) {
    throw new Error("The target account is not an Antigravity account");
  }
  if (!account.tokens?.access_token && !account.tokens?.refresh_token) {
    throw new Error("The target account is incomplete");
  }
  if (account.requires_reauth) {
    throw new Error("The target account requires reauthorization before it can be switched to");
  }

  const currentId = loadAntigravityIdx().current_antigravity_account_id;
  const runtime = getAntigravityRuntime();
  const dbPath = runtime.vscdbPath();
  const started = Date.now();
  let killMs = 0;
  let writeMs = 0;
  const install = await getAntigravityInstallationStatusAsync();
  if (!install.installed) {
    assertOfficialAntigravityInstalled();
  }
  const launchPath = install.exePath && pathExists(install.exePath) ? install.exePath : null;
  const userDataDir = resolveUserDataDir(runtime, launchPath);
  const writeCredential = usesWindowsSystemCredential(launchPath);
  const writeVscdb = !writeCredential;
  const launchOptions = { userDataDir };
  let snapshot = null;
  let credentialSnapshot = null;
  let launched = false;
  let launchError = null;
  let wrote = false;
  let wroteCredential = false;
  let metaSnapshot = null;

  try {
    await killAntigravity();
    await clearStaleLockWithRetry(runtime, userDataDir);
    killMs = Date.now() - started;
    credentialSnapshot = await snapshotCredentialIfNeeded(runtime, writeCredential);
    const writeStarted = Date.now();
    if (writeVscdb) {
      await waitForWalToClear(dbPath, WAL_CLEAR_WAIT_MS, runtime.sleep);
      await waitForAntigravityVscdbWritable(dbPath, { sleep: runtime.sleep });
      snapshot = await snapshotVscdb(dbPath);
    }
    if (writeCredential) {
      if (typeof runtime.writeSystemCredential !== "function") {
        throw new Error("Official Antigravity 2.0 login cannot be written");
      }
      await runtime.writeSystemCredential(account, runtime.execFile);
      wroteCredential = true;
      wrote = true;
    }
    if (writeVscdb) {
      await writeAntigravityAuth(dbPath, injectToken(account));
      wrote = true;
    }
    writeMs = Date.now() - writeStarted;
    metaSnapshot = snapshotAntigravityMeta(account.id);
    account.last_used = ts();
    saveAntigravityAcct(account);
    setCurrentAntigravityAccountId(account.id);
    upsertAntigravityIndex(account);
    if (launchPath) {
      try {
        runtime.launch(launchPath, launchOptions);
        launched = true;
      } catch (error) {
        launchError = "账号已写入，请手动打开 Antigravity";
        logWarn(`Antigravity account was written but launch failed: ${error.message}`);
      }
    } else {
      launchError = "账号已写入，请手动打开 Antigravity";
      logWarn("Antigravity account was written but official Antigravity was not found");
    }
    logInfo(`Antigravity switch timings kill=${killMs}ms write=${writeMs}ms total=${Date.now() - started}ms`);
    logInfo(`Switched official Antigravity to ${account.email}`);
    return {
      already: !!currentId && currentId === account.id,
      launched,
      launchError,
      account,
    };
  } catch (error) {
    logError(`Antigravity switch failed wrote=${wrote} kill=${killMs}ms write=${writeMs}ms ${describeCaughtError(error)}`);
    if (wrote) {
      if (writeVscdb) {
        try { restoreVscdbSnapshot(snapshot); } catch (restoreError) {
          logError(`Antigravity vscdb rollback failed: ${describeCaughtError(restoreError)}`);
        }
      }
      if (wroteCredential && typeof runtime.restoreSystemCredential === "function") {
        try { await runtime.restoreSystemCredential(credentialSnapshot, runtime.execFile); } catch (restoreError) {
          logError(`Antigravity system credential rollback failed: ${describeCaughtError(restoreError)}`);
        }
      }
      if (metaSnapshot) {
        try { restoreAntigravityMeta(metaSnapshot); } catch (restoreError) {
          logError(`Antigravity account index rollback failed: ${describeCaughtError(restoreError)}`);
        }
      }
    } else {
      relaunchIfPossible(runtime, launchPath, launchOptions);
    }
    throw error;
  }
}

module.exports = {
  killAntigravity,
  doAntigravitySwitch,
  injectToken,
};

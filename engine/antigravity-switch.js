const fs = require("node:fs");
const { ts } = require("./crypto-utils");
const { getAntigravityRuntime } = require("./antigravity-runtime");
const { writeAntigravityAuth, snapshotVscdb, restoreVscdbSnapshot, waitForWalToClear } = require("./antigravity-db");
const {
  loadAntigravityAcct,
  saveAntigravityAcct,
  currentAntigravityAcct,
  setCurrentAntigravityAccountId,
  upsertAntigravityIndex,
  snapshotAntigravityMeta,
  restoreAntigravityMeta,
} = require("./antigravity-storage");
const { getAntigravityInstallationStatusAsync, assertOfficialAntigravityInstalled } = require("./antigravity-install");
const { logInfo, logWarn, logError } = require("./logger");

async function waitForProcessesToExit(pids, timeoutMs) {
  const runtime = getAntigravityRuntime();
  const deadline = Date.now() + timeoutMs;
  let remaining = new Set(pids);
  while (remaining.size > 0 && Date.now() < deadline) {
    const running = new Set((await runtime.listProcesses()).map((item) => item.pid));
    remaining = new Set([...remaining].filter((pid) => running.has(pid)));
    if (remaining.size > 0) await runtime.sleep(200);
  }
  return [...remaining];
}

async function killAntigravity() {
  const runtime = getAntigravityRuntime();
  const processes = await runtime.listProcesses();
  const pids = processes.map((item) => item.pid);
  if (pids.length === 0) return [];
  for (const pid of pids) {
    await runtime.gracefulClose(pid);
  }
  let remaining = await waitForProcessesToExit(pids, 8000);
  if (remaining.length > 0) {
    for (const pid of remaining) {
      await runtime.forceClose(pid);
    }
    remaining = await waitForProcessesToExit(remaining, 8000);
  }
  if (remaining.length > 0) {
    const error = new Error(`Official Antigravity IDE did not exit: ${remaining.join(", ")}`);
    error.code = "antigravity_process_still_running";
    throw error;
  }
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

  const current = currentAntigravityAcct();
  const runtime = getAntigravityRuntime();
  const dbPath = runtime.vscdbPath();
  const install = await getAntigravityInstallationStatusAsync();
  if (!install.installed) {
    assertOfficialAntigravityInstalled();
  }
  const launchPath = install.exePath && fs.existsSync(install.exePath) ? install.exePath : null;
  const snapshot = snapshotVscdb(dbPath);
  let launched = false;
  let launchError = null;
  let wrote = false;
  let metaSnapshot = null;

  try {
    await killAntigravity();
    if (typeof runtime.sleep === "function") await runtime.sleep(400);
    const walSettled = await waitForWalToClear(dbPath, 2000, runtime.sleep);
    if (!walSettled) {
      if (launchPath) {
        try { runtime.launch(launchPath); } catch {}
      }
      const error = new Error("官方 Antigravity IDE 还没把登录库写完，请再试一次");
      error.code = "antigravity_vscdb_wal_pending";
      throw error;
    }
    await writeAntigravityAuth(dbPath, injectToken(account));
    wrote = true;
    metaSnapshot = snapshotAntigravityMeta(account.id);
    account.last_used = ts();
    saveAntigravityAcct(account);
    setCurrentAntigravityAccountId(account.id);
    upsertAntigravityIndex(account);
    if (launchPath) {
      try {
        runtime.launch(launchPath);
        launched = true;
      } catch (error) {
        launchError = "账号已写入，请手动打开 Antigravity IDE";
        logWarn(`Antigravity account was written but launch failed: ${error.message}`);
      }
    } else {
      launchError = "账号已写入，请手动打开 Antigravity IDE";
      logWarn("Antigravity account was written but official Antigravity IDE.exe was not found");
    }
    logInfo(`Switched official Antigravity to ${account.email}`);
    return {
      already: !!current && current.id === account.id,
      launched,
      launchError,
      account: loadAntigravityAcct(account.id),
    };
  } catch (error) {
    if (wrote) {
      try { restoreVscdbSnapshot(snapshot); } catch (restoreError) {
        logError(`Antigravity vscdb rollback failed: ${restoreError.message}`);
      }
      if (metaSnapshot) {
        try { restoreAntigravityMeta(metaSnapshot); } catch (restoreError) {
          logError(`Antigravity account index rollback failed: ${restoreError.message}`);
        }
      }
    }
    throw error;
  }
}

module.exports = {
  killAntigravity,
  doAntigravitySwitch,
  injectToken,
};

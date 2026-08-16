const fs = require("node:fs");
const { ts } = require("./crypto-utils");
const { getCursorRuntime } = require("./cursor-runtime");
const { writeCursorAuth, snapshotVscdb, restoreVscdbSnapshot, waitForWalToClear } = require("./cursor-db");
const { loadCursorAcct, saveCursorAcct, currentCursorAcct, setCurrentCursorAccountId, upsertCursorIndex, snapshotCursorMeta, restoreCursorMeta } = require("./cursor-storage");
const { getCursorInstallationStatusAsync } = require("./cursor-install");
const { logInfo, logWarn, logError } = require("./logger");

async function waitForProcessesToExit(pids, timeoutMs) {
  const runtime = getCursorRuntime();
  const deadline = Date.now() + timeoutMs;
  let remaining = new Set(pids);
  while (remaining.size > 0 && Date.now() < deadline) {
    const running = new Set((await runtime.listProcesses()).map((item) => item.pid));
    remaining = new Set([...remaining].filter((pid) => running.has(pid)));
    if (remaining.size > 0) await runtime.sleep(200);
  }
  return [...remaining];
}

async function killCursor() {
  const runtime = getCursorRuntime();
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
    const error = new Error(`Official Cursor did not exit: ${remaining.join(", ")}`);
    error.code = "cursor_process_still_running";
    throw error;
  }
  return pids;
}

function injectValues(account) {
  const email = account.email || "";
  const accessToken = account.tokens.access_token;
  const values = {
    "cursorAuth/accessToken": accessToken,
    "cursor.accessToken": accessToken,
    "cursorAuth/cachedEmail": email,
    "cursor.email": email,
  };
  if (account.tokens.refresh_token) values["cursorAuth/refreshToken"] = account.tokens.refresh_token;
  const authId = String(account.auth_id || "").trim();
  if (authId.startsWith("user_")) values["cursorAuth/authId"] = authId;
  if (account.plan_type) values["cursorAuth/stripeMembershipType"] = account.plan_type;
  if (account.subscription_status) values["cursorAuth/stripeSubscriptionStatus"] = account.subscription_status;
  return values;
}

async function doCursorSwitch(account) {
  if (!account?.id || !String(account.id).startsWith("cursor_")) {
    throw new Error("The target account is not a Cursor account");
  }
  if (!account.tokens?.access_token) throw new Error("The target account is incomplete");
  if (account.requires_reauth) {
    throw new Error("The target account requires reauthorization before it can be switched to");
  }

  const current = currentCursorAcct();
  const runtime = getCursorRuntime();
  const dbPath = runtime.vscdbPath();
  const install = await getCursorInstallationStatusAsync();
  const launchPath = install.exePath && fs.existsSync(install.exePath) ? install.exePath : null;
  const snapshot = snapshotVscdb(dbPath);
  let launched = false;
  let launchError = null;
  let wrote = false;
  let metaSnapshot = null;

  try {
    await killCursor();
    if (typeof runtime.sleep === "function") await runtime.sleep(400);
    const walSettled = await waitForWalToClear(dbPath, 2000, runtime.sleep);
    if (!walSettled) {
      if (launchPath) {
        try { runtime.launch(launchPath); } catch {}
      }
      const error = new Error("官方 Cursor 还没把登录库写完，请再试一次");
      error.code = "cursor_vscdb_wal_pending";
      throw error;
    }
    await writeCursorAuth(dbPath, injectValues(account));
    wrote = true;
    metaSnapshot = snapshotCursorMeta(account.id);
    account.last_used = ts();
    saveCursorAcct(account);
    setCurrentCursorAccountId(account.id);
    upsertCursorIndex(account);
    if (typeof runtime.afterSwitchMetaWrite === "function") {
      await runtime.afterSwitchMetaWrite();
    }
    if (launchPath) {
      try {
        runtime.launch(launchPath);
        launched = true;
      } catch (error) {
        launchError = "账号已写入，请手动打开 Cursor";
        logWarn(`Cursor account was written but launch failed: ${error.message}`);
      }
    } else {
      launchError = "账号已写入，请手动打开 Cursor";
      logWarn("Cursor account was written but official Cursor.exe was not found");
    }
    logInfo(`Switched official Cursor to ${account.email}`);
    return {
      already: !!current && current.id === account.id,
      launched,
      launchError,
      account: loadCursorAcct(account.id),
    };
  } catch (error) {
    if (wrote) {
      try { restoreVscdbSnapshot(snapshot); } catch (restoreError) {
        logError(`Cursor vscdb rollback failed: ${restoreError.message}`);
      }
      if (metaSnapshot) {
        try { restoreCursorMeta(metaSnapshot); } catch (restoreError) {
          logError(`Cursor account index rollback failed: ${restoreError.message}`);
        }
      }
    }
    throw error;
  }
}

module.exports = {
  killCursor,
  doCursorSwitch,
  injectValues,
};

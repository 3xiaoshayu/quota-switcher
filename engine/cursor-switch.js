const { ts } = require("./crypto-utils");
const { pathExists } = require("./atomic-file");
const { getCursorRuntime, firstExistingCursorExe } = require("./cursor-runtime");
const { applyOfficialCursorSwitch, restoreVscdbSnapshot, waitForCursorVscdbWritable, waitForWalToClear, finiteTeamId } = require("./cursor-db");
const { loadCursorAcct, saveCursorAcct, loadCursorIdx, setCurrentCursorAccountId, upsertCursorIndex, snapshotCursorMeta, restoreCursorMeta } = require("./cursor-storage");
const { applyCursorUiToValues, cursorUiFromValues, mergeCursorUi, mergeCursorSession, persistOfficialCursorState, invalidateCursorOfficialSync, sessionFromAccount } = require("./cursor-local");
const { usableEmail } = require("./account-identity");
const { logInfo, logWarn, logError } = require("./logger");
const { describeCaughtError } = require("./sqlite-native");

const GRACEFUL_WAIT_MS = 1500;
const FORCE_WAIT_MS = 4000;
const LEFTOVER_WAIT_MS = 2500;
const PID_POLL_MS = 50;
const WAL_CLEAR_WAIT_MS = 2000;

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForPidsToExit(pids, timeoutMs) {
  const runtime = getCursorRuntime();
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let remaining = pids.filter(pidIsAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await runtime.sleep(PID_POLL_MS);
    remaining = remaining.filter(pidIsAlive);
  }
  if (remaining.length === 0) return remaining;
  // A PID that is still alive but no longer shows up as an official process
  // was reused by something unrelated after the app exited; it must not block
  // the switch.
  const official = new Set((await runtime.listProcesses()).map((item) => item.pid));
  return remaining.filter((pid) => official.has(pid));
}

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (candidate && pathExists(candidate)) return candidate;
  }
  return null;
}

function resolveCursorLaunchPath(runningLaunchPath) {
  const runtime = getCursorRuntime();
  const fromRuntime = typeof runtime.cursorExePath === "function" ? runtime.cursorExePath() : null;
  return firstExistingPath([fromRuntime, runningLaunchPath, firstExistingCursorExe()]);
}

async function killCursor() {
  const runtime = getCursorRuntime();
  const processes = await runtime.listProcesses();
  const launchPath = firstExistingPath(processes.map((item) => item.executablePath));
  const pids = [...new Set(processes.map((item) => item.pid).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (pids.length === 0) return { pids, launchPath };
  await Promise.all(pids.map((pid) => runtime.gracefulClose(pid)));
  let remaining = await waitForPidsToExit(pids, GRACEFUL_WAIT_MS);
  if (remaining.length > 0) {
    await Promise.all(remaining.map((pid) => runtime.forceClose(pid)));
    remaining = await waitForPidsToExit(remaining, FORCE_WAIT_MS);
  }
  if (remaining.length > 0) {
    const error = new Error(`Official Cursor did not exit: ${remaining.join(", ")}`);
    error.code = "cursor_process_still_running";
    throw error;
  }
  const leftovers = await runtime.listProcesses();
  if (leftovers.length > 0) {
    await Promise.all(leftovers.map((item) => runtime.forceClose(item.pid)));
    remaining = await waitForPidsToExit(leftovers.map((item) => item.pid), LEFTOVER_WAIT_MS);
    if (remaining.length > 0) {
      const error = new Error(`Official Cursor did not exit: ${remaining.join(", ")}`);
      error.code = "cursor_process_still_running";
      throw error;
    }
  }
  return { pids, launchPath };
}

function workosSubject(authId) {
  const id = String(authId || "").trim();
  if (!id) return "";
  if (id.startsWith("auth0|")) return id;
  if (id.startsWith("user_")) return `auth0|${id}`;
  return "";
}

function cursorUserId(authId) {
  const id = String(authId || "").trim();
  if (id.startsWith("auth0|")) return id.slice("auth0|".length);
  return id;
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
  const authId = String(account.auth_id || account.tokens?.auth_id || "").trim();
  const userId = cursorUserId(authId);
  const subject = workosSubject(authId);
  if (userId.startsWith("user_")) values["cursorAuth/authId"] = userId;
  if (userId) values["cursorAuth/userId"] = userId;
  if (subject) {
    values["cursorAuth/stripeMembershipAuthId"] = subject;
    values["glass.lastSignedInAuthId"] = subject;
  }
  if (account.plan_type) values["cursorAuth/stripeMembershipType"] = account.plan_type;
  if (account.subscription_status) values["cursorAuth/stripeSubscriptionStatus"] = account.subscription_status;
  return applyCursorUiToValues(account, values);
}

function fillSessionAuth(account, session) {
  if (session.adminAuthId) return session;
  const subject = workosSubject(account.auth_id || account.tokens?.auth_id);
  if (subject) session.adminAuthId = subject;
  return session;
}

function assertSwitchWrote(account, values, session) {
  const wanted = usableEmail(account.email).toLowerCase();
  const got = usableEmail(values?.["cursorAuth/cachedEmail"] || values?.["cursor.email"]).toLowerCase();
  if (!wanted || wanted !== got) {
    const error = new Error("Cursor 登录库写入后核对失败，没有切到目标账号");
    error.code = "cursor_switch_verify_failed";
    throw error;
  }
  const expectedTeam = finiteTeamId(session?.teamId);
  const writtenTeam = finiteTeamId(session?.writtenTeamId);
  if (expectedTeam != null && writtenTeam != null && expectedTeam !== writtenTeam) {
    const error = new Error("Cursor 团队会话写入后核对失败，没有切到目标账号");
    error.code = "cursor_switch_verify_failed";
    throw error;
  }
  if (expectedTeam == null && writtenTeam != null) {
    const error = new Error("Cursor 团队会话写入后核对失败，没有切到目标账号");
    error.code = "cursor_switch_verify_failed";
    throw error;
  }
}

function relaunchIfPossible(runtime, launchPath) {
  if (!launchPath) return;
  try { runtime.launch(launchPath); } catch {}
}

async function doCursorSwitch(account) {
  if (!account?.id || !String(account.id).startsWith("cursor_")) {
    throw new Error("The target account is not a Cursor account");
  }
  if (!account.tokens?.access_token) throw new Error("The target account is incomplete");
  if (account.requires_reauth) {
    throw new Error("The target account requires reauthorization before it can be switched to");
  }

  const currentId = loadCursorIdx().current_cursor_account_id;
  const runtime = getCursorRuntime();
  const dbPath = runtime.vscdbPath();
  const started = Date.now();
  let killMs = 0;
  let writableMs = 0;
  let writeMs = 0;
  let snapshot = null;
  let launched = false;
  let launchError = null;
  let wrote = false;
  let metaSnapshot = null;
  let launchPath = null;

  try {
    const killed = await killCursor();
    killMs = Date.now() - started;
    launchPath = resolveCursorLaunchPath(killed.launchPath);
    await waitForWalToClear(dbPath, WAL_CLEAR_WAIT_MS, runtime.sleep);
    await waitForCursorVscdbWritable(dbPath, { sleep: runtime.sleep });
    writableMs = Date.now() - started - killMs;
    const writeStarted = Date.now();
    const applied = await applyOfficialCursorSwitch(dbPath, {
      buildWrite: ({ officialValues, officialSession }) => {
        try {
          persistOfficialCursorState(officialValues, officialSession);
        } catch (error) {
          logWarn(`Cursor profile cache was not captured before switch: ${error.message}`);
        }
        const latest = loadCursorAcct(account.id);
        if (latest?.cursor_ui) account.cursor_ui = mergeCursorUi(account.cursor_ui, latest.cursor_ui);
        if (latest?.cursor_session) account.cursor_session = mergeCursorSession(account.cursor_session, latest.cursor_session);
        const values = injectValues(account);
        account.cursor_ui = mergeCursorUi(account.cursor_ui, cursorUiFromValues(values));
        const session = fillSessionAuth(account, sessionFromAccount(account));
        return { values, session };
      },
    });
    writeMs = Date.now() - writeStarted;
    snapshot = applied.snapshot;
    const session = applied.session;
    wrote = true;
    assertSwitchWrote(account, applied.writtenValues, {
      ...session,
      writtenTeamId: applied.writtenSession?.teamId ?? applied.writtenSession?.adminTeamId,
    });
    metaSnapshot = snapshotCursorMeta(account.id);
    account.last_used = ts();
    account.cursor_session = session;
    saveCursorAcct(account);
    setCurrentCursorAccountId(account.id);
    invalidateCursorOfficialSync();
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
    logInfo(`Cursor switch timings kill=${killMs}ms writable=${writableMs}ms write=${writeMs}ms total=${Date.now() - started}ms`);
    logInfo(`Switched official Cursor to ${account.email}${session.teamId != null ? ` team=${session.teamId}` : " team=none"}`);
    return {
      already: !!currentId && currentId === account.id,
      launched,
      launchError,
      account,
    };
  } catch (error) {
    logError(`Cursor switch failed wrote=${wrote} kill=${killMs}ms writable=${writableMs}ms write=${writeMs}ms ${describeCaughtError(error)}`);
    if (wrote) {
      try { restoreVscdbSnapshot(snapshot); } catch (restoreError) {
        logError(`Cursor vscdb rollback failed: ${describeCaughtError(restoreError)}`);
      }
      if (metaSnapshot) {
        try { restoreCursorMeta(metaSnapshot); } catch (restoreError) {
          logError(`Cursor account index rollback failed: ${describeCaughtError(restoreError)}`);
        }
      }
    }
    // The official window was closed for the write. Whether or not anything
    // was written, the user gets their editor back on the previous login.
    relaunchIfPossible(runtime, launchPath);
    throw error;
  }
}

module.exports = {
  killCursor,
  doCursorSwitch,
  injectValues,
};

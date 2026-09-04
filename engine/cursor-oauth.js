const crypto = require("node:crypto");
const { b64url, codeChallenge } = require("./crypto-utils");
const {
  DATA_DIR,
  CURSOR_LOGIN_URL,
  CURSOR_POLL_URL,
  CURSOR_OAUTH_PENDING_PATH,
} = require("./config");
const { protectData, unprotectData, ensureDir } = require("./storage");
const { writeJsonAtomic, readJsonWithBackup, unlinkIfPresent } = require("./atomic-file");
const { getCursorRuntime } = require("./cursor-runtime");
const { upsertCursorAccount } = require("./cursor-local");
const { loadCursorAcct, saveCursorAcct, upsertCursorIndex } = require("./cursor-storage");
const { withAccountLock, withAccountLocks } = require("./operation-locks");
const { emailFromCursorToken, fetchCursorUserMeta } = require("./cursor-token");
const { getOAuthStatus } = require("./oauth");
const { logInfo, logWarn } = require("./logger");

const OAUTH_TTL_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_TRIES = 150;

let active = null;
let lastStatus = { status: "idle", message: null, targetAccountId: null, result: null };

function publicAccountResult(result) {
  if (!result?.account) return null;
  return {
    accountId: result.account.id,
    email: result.account.email,
    mismatch: !!result.mismatch,
    targetAccountId: result.targetAccountId || null,
    updated: !!result.updated,
  };
}

function setStatus(status, patch = {}) {
  lastStatus = {
    status,
    message: patch.message || null,
    targetAccountId: patch.targetAccountId ?? active?.pending?.targetAccountId ?? null,
    result: patch.result ? publicAccountResult(patch.result) : null,
  };
}

function getCursorOAuthStatus() {
  return {
    ...lastStatus,
    pending: !!active && !active.settled,
    expiresAt: active?.pending?.expiresAt || null,
  };
}

function persistPending(pending) {
  ensureDir(DATA_DIR);
  writeJsonAtomic(CURSOR_OAUTH_PENDING_PATH, {
    version: 1,
    protected_payload: protectData(JSON.stringify(pending)),
    created_at: pending.createdAt,
    expires_at: pending.expiresAt,
  });
}

function clearPendingFile() {
  try { unlinkIfPresent(CURSOR_OAUTH_PENDING_PATH); } catch {}
  try { unlinkIfPresent(`${CURSOR_OAUTH_PENDING_PATH}.bak`); } catch {}
}

function loadPending() {
  try {
    const envelope = readJsonWithBackup(CURSOR_OAUTH_PENDING_PATH);
    const pending = JSON.parse(unprotectData(envelope.protected_payload));
    if (!pending.expiresAt || pending.expiresAt <= Date.now()) {
      clearPendingFile();
      setStatus("expired", { message: "The pending OAuth authorization expired." });
      return null;
    }
    return pending;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.transientIoError) return null;
    if (!(error instanceof SyntaxError)) return null;
    clearPendingFile();
    return null;
  }
}

function openBrowser(url) {
  const runtime = getCursorRuntime();
  if (runtime.openUrl) {
    Promise.resolve(runtime.openUrl(url)).catch((error) => {
      logWarn(`Could not open Cursor OAuth browser: ${error.message}`);
    });
    return;
  }
  const cp = require("node:child_process");
  const child = cp.spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function settleActive(error, result) {
  if (!active || active.settled) return;
  active.settled = true;
  if (active.timer) clearTimeout(active.timer);
  clearPendingFile();
  const resolve = active.resolve;
  const reject = active.reject;
  const targetAccountId = active.pending.targetAccountId;
  active = null;
  if (error) {
    setStatus(error.code === "oauth_cancelled" ? "cancelled" : "error", {
      message: error.message,
      targetAccountId,
    });
    logWarn(`Cursor OAuth ended without an account: ${error.message}`);
    reject(error);
    return;
  }
  setStatus("completed", { result, targetAccountId });
  logInfo("Cursor OAuth account authorization completed");
  resolve(result);
}

function cancelCursorOAuth() {
  if (!active || active.settled) return false;
  const error = new Error("OAuth authorization was cancelled");
  error.code = "oauth_cancelled";
  settleActive(error, null);
  return true;
}

async function pollForTokens(pending) {
  const runtime = getCursorRuntime();
  const url = `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(pending.uuid)}&verifier=${encodeURIComponent(pending.verifier)}`;
  let networkMisses = 0;
  for (let attempt = 0; attempt < POLL_MAX_TRIES; attempt += 1) {
    if (!active || active.settled || active.pending !== pending) {
      const error = new Error("OAuth authorization was cancelled");
      error.code = "oauth_cancelled";
      throw error;
    }
    let response;
    try {
      response = await runtime.httpJson(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      // The user is still in the browser. One dropped poll (proxy blip, DNS
      // hiccup) must not throw the whole login away; the session timer still
      // bounds the wait.
      networkMisses += 1;
      if (networkMisses === 1) {
        logWarn(`Cursor OAuth poll hit a network miss; keeping the session: ${error.message}`);
      }
      await runtime.sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (response.status === 404) {
      await runtime.sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      let payload = {};
      try { payload = JSON.parse(response.body || "{}"); } catch {}
      if (payload.accessToken && payload.refreshToken) return payload;
    }
    await runtime.sleep(POLL_INTERVAL_MS);
  }
  const error = new Error("OAuth authorization timed out");
  error.code = "oauth_timeout";
  throw error;
}

async function finishCursorLogin(pending, payload) {
  const authId = String(payload.authId || "").trim();
  let email = authId.includes("@") ? authId : emailFromCursorToken(payload.accessToken);
  const result = await withAccountLock("__cursor_switch__", async () => upsertCursorAccount({
    email: email || "unknown",
    auth_id: authId || email || "unknown",
    access_token: payload.accessToken,
    refresh_token: payload.refreshToken,
  }, { targetAccountId: pending.targetAccountId || null }));
  try {
    const meta = await fetchCursorUserMeta(result.account);
    if (meta) {
      await withAccountLocks(["__cursor_switch__", result.account.id], async () => {
        const latest = loadCursorAcct(result.account.id) || result.account;
        if (result.account.email && result.account.email.includes("@")) latest.email = result.account.email;
        if (result.account.auth_id) {
          latest.auth_id = result.account.auth_id;
          if (latest.tokens) latest.tokens.auth_id = result.account.auth_id;
        }
        saveCursorAcct(latest);
        upsertCursorIndex(latest);
      });
    }
  } catch {}
  return result;
}

async function cursorLoginFlow(options = {}) {
  if (getOAuthStatus().pending) {
    throw new Error("authorization is already in progress");
  }
  if (active && !active.settled) {
    throw new Error("authorization is already in progress");
  }
  const now = Date.now();
  const verifier = b64url(32);
  const pending = {
    verifier,
    challenge: codeChallenge(verifier),
    uuid: crypto.randomUUID(),
    targetAccountId: options.targetAccountId || null,
    createdAt: now,
    expiresAt: now + OAUTH_TTL_MS,
  };
  persistPending(pending);
  const loginUrl = `${CURSOR_LOGIN_URL}?challenge=${encodeURIComponent(pending.challenge)}&uuid=${encodeURIComponent(pending.uuid)}&mode=login`;
  setStatus("waiting", { targetAccountId: pending.targetAccountId, message: "Waiting for browser authorization" });
  const session = {
    pending,
    settled: false,
    timer: null,
    resolve: null,
    reject: null,
  };
  active = session;
  const promise = new Promise((resolve, reject) => {
    session.resolve = resolve;
    session.reject = reject;
  });
  session.timer = setTimeout(() => {
    const error = new Error("OAuth authorization timed out");
    error.code = "oauth_timeout";
    settleActive(error, null);
  }, OAUTH_TTL_MS);
  openBrowser(loginUrl);
  pollForTokens(pending)
    .then((payload) => finishCursorLogin(pending, payload))
    .then((result) => settleActive(null, result))
    .catch((error) => settleActive(error, null));
  return promise;
}

function discardPendingCursorOAuth(reason) {
  if (active && !active.settled) return cancelCursorOAuth();
  clearPendingFile();
  setStatus("expired", { message: reason || "The pending OAuth authorization expired." });
  return true;
}

function restorePendingCursorOAuth() {
  if (active) return false;
  if (getOAuthStatus().pending) {
    discardPendingCursorOAuth("authorization is already in progress");
    return false;
  }
  const pending = loadPending();
  if (!pending) return false;
  setStatus("waiting", { targetAccountId: pending.targetAccountId, message: "Waiting for browser authorization" });
  const session = {
    pending,
    settled: false,
    timer: null,
    resolve: null,
    reject: null,
  };
  active = session;
  const promise = new Promise((resolve, reject) => {
    session.resolve = resolve;
    session.reject = reject;
  });
  session.timer = setTimeout(() => {
    const error = new Error("OAuth authorization timed out");
    error.code = "oauth_timeout";
    settleActive(error, null);
  }, Math.max(1000, pending.expiresAt - Date.now()));
  pollForTokens(pending)
    .then((payload) => finishCursorLogin(pending, payload))
    .then((result) => settleActive(null, result))
    .catch((error) => settleActive(error, null));
  promise.catch(() => {});
  return true;
}

module.exports = {
  cursorLoginFlow,
  cancelCursorOAuth,
  discardPendingCursorOAuth,
  getCursorOAuthStatus,
  restorePendingCursorOAuth,
};

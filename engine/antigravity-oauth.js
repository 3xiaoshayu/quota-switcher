const fs = require("node:fs");
const http = require("node:http");
const { b64url } = require("./crypto-utils");
const {
  DATA_DIR,
  ANTIGRAVITY_AUTH_URL,
  ANTIGRAVITY_OAUTH_PENDING_PATH,
  ANTIGRAVITY_CALLBACK_PORT,
  ANTIGRAVITY_SCOPES,
} = require("./config");
const { protectData, unprotectData, ensureDir } = require("./storage");
const { writeJsonAtomic, readJsonWithRetry } = require("./atomic-file");
const { getAntigravityRuntime } = require("./antigravity-runtime");
const { readOfficialOauthClient } = require("./antigravity-oauth-client");
const { upsertAntigravityAccount } = require("./antigravity-local");
const { exchangeGoogleToken, fetchGoogleUserInfo } = require("./antigravity-token");
const { withAccountLock } = require("./operation-locks");
const { getOAuthStatus } = require("./oauth");
const { getCursorOAuthStatus } = require("./cursor-oauth");
const { logInfo, logWarn } = require("./logger");
const { APP_DISPLAY_NAME } = require("./app-brand");

const OAUTH_TTL_MS = 5 * 60 * 1000;

let active = null;
let lastStatus = { status: "idle", message: null, targetAccountId: null, result: null, callbackPort: ANTIGRAVITY_CALLBACK_PORT };

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
    callbackPort: patch.callbackPort ?? active?.pending?.callbackPort ?? ANTIGRAVITY_CALLBACK_PORT,
  };
}

function getAntigravityOAuthStatus() {
  return {
    ...lastStatus,
    pending: !!active && !active.settled,
    expiresAt: active?.pending?.expiresAt || null,
  };
}

function persistPending(pending) {
  ensureDir(DATA_DIR);
  writeJsonAtomic(ANTIGRAVITY_OAUTH_PENDING_PATH, {
    version: 1,
    protected_payload: protectData(JSON.stringify(pending)),
    created_at: pending.createdAt,
    expires_at: pending.expiresAt,
  });
}

function clearPendingFile() {
  try { fs.unlinkSync(ANTIGRAVITY_OAUTH_PENDING_PATH); } catch {}
  try { fs.unlinkSync(`${ANTIGRAVITY_OAUTH_PENDING_PATH}.bak`); } catch {}
}

function loadPending() {
  if (!fs.existsSync(ANTIGRAVITY_OAUTH_PENDING_PATH)) return null;
  try {
    const envelope = readJsonWithRetry(ANTIGRAVITY_OAUTH_PENDING_PATH);
    const pending = JSON.parse(unprotectData(envelope.protected_payload));
    if (!pending.expiresAt || pending.expiresAt <= Date.now()) {
      clearPendingFile();
      setStatus("expired", { message: "The pending OAuth authorization expired." });
      return null;
    }
    return pending;
  } catch {
    clearPendingFile();
    return null;
  }
}

function openBrowser(url) {
  const runtime = getAntigravityRuntime();
  if (runtime.openUrl) {
    Promise.resolve(runtime.openUrl(url)).catch((error) => {
      logWarn(`Could not open Antigravity OAuth browser: ${error.message}`);
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

function closeServer(server) {
  if (!server) return;
  try { server.close(); } catch {}
}

function settleActive(error, result) {
  if (!active || active.settled) return;
  active.settled = true;
  if (active.timer) clearTimeout(active.timer);
  closeServer(active.server);
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
    logWarn(`Antigravity OAuth ended without an account: ${error.message}`);
    reject(error);
    return;
  }
  setStatus("completed", { result, targetAccountId });
  logInfo("Antigravity OAuth account authorization completed");
  resolve(result);
}

function cancelAntigravityOAuth() {
  if (!active || active.settled) return false;
  const error = new Error("OAuth authorization was cancelled");
  error.code = "oauth_cancelled";
  settleActive(error, null);
  return true;
}

function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;padding:32px">${body}</body></html>`;
}

function pathnameFromRequestUrl(requestUrl) {
  const raw = String(requestUrl || "");
  const withoutHash = raw.split("#")[0];
  const pathPart = withoutHash.split("?")[0] || "/";
  if (/^[a-zA-Z][a-zA-Z+.-]*:/.test(pathPart)) {
    try { return new URL(pathPart).pathname || "/"; } catch { /* keep pathPart */ }
  }
  if (pathPart.startsWith("/")) return pathPart;
  const slash = pathPart.indexOf("/");
  return slash >= 0 ? pathPart.slice(slash) : "/";
}

function parseAntigravityCallbackRequest(requestUrl) {
  const raw = String(requestUrl || "");
  const withoutHash = raw.split("#")[0];
  const queryIndex = withoutHash.indexOf("?");
  const query = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "");
  return {
    pathname: pathnameFromRequestUrl(raw),
    code: query.get("code"),
    state: query.get("state"),
    error: query.get("error"),
  };
}

function createCallbackListener(pending) {
  let resolveCode;
  let rejectCode;
  let resolveReady;
  let rejectReady;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let finished = false;
  const finish = (error, code) => {
    if (finished) return;
    finished = true;
    if (error) rejectCode(error);
    else resolveCode(code);
  };
  const server = http.createServer((request, response) => {
    const parsed = parseAntigravityCallbackRequest(request.url);
    if (parsed.pathname !== "/oauth-callback") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (parsed.error) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(htmlPage("授权未完成", "<p>浏览器授权已取消或失败，可以关闭此页。</p>"));
      finish(Object.assign(new Error(parsed.error), { code: "oauth_denied" }));
      return;
    }
    if (!parsed.code) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (pending.state && parsed.state && parsed.state !== pending.state) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(htmlPage("授权未完成", "<p>这次回调和当前授权对不上，请关闭此页后重新点一次网页授权。</p>"));
      finish(Object.assign(new Error("OAuth callback state did not match"), { code: "oauth_state_mismatch" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(htmlPage("授权完成", `<p>可以关闭此页，回到 ${APP_DISPLAY_NAME}。</p>`));
    finish(null, parsed.code);
  });
  server.on("error", (error) => {
    rejectReady(error);
    finish(error);
  });
  server.listen(pending.callbackPort, "127.0.0.1", () => {
    if (active && active.pending === pending) active.server = server;
    resolveReady();
  });
  return { server, ready, codePromise };
}

function antigravityRedirectUri(port) {
  return `http://localhost:${Number(port) || ANTIGRAVITY_CALLBACK_PORT}/oauth-callback`;
}

function buildAuthUrl(pending, client) {
  const redirectUri = antigravityRedirectUri(pending.callbackPort);
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: client.clientId,
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ANTIGRAVITY_SCOPES,
    state: pending.state,
  });
  return `${ANTIGRAVITY_AUTH_URL}?${params.toString()}`;
}

async function finishAntigravityLogin(pending, code) {
  const redirectUri = antigravityRedirectUri(pending.callbackPort);
  const { response, payload } = await exchangeGoogleToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  if (response.status < 200 || response.status >= 300 || !payload.access_token) {
    const error = new Error(payload.error_description || payload.error || `Google token exchange failed: HTTP ${response.status}`);
    error.code = payload.error || "oauth_token_exchange_failed";
    throw error;
  }
  let email = "";
  try {
    const info = await fetchGoogleUserInfo(payload.access_token);
    email = String(info?.email || "").trim();
  } catch {}
  const expiresIn = Number(payload.expires_in || 0);
  const { refreshFingerprint, usableEmail } = require("./antigravity-local");
  return withAccountLock("__antigravity_switch__", async () => upsertAntigravityAccount({
    email: usableEmail(email),
    auth_id: refreshFingerprint(payload.refresh_token || payload.access_token),
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || null,
    expiry_timestamp: expiresIn > 0 ? Math.floor(Date.now() / 1000) + Math.floor(expiresIn) : 0,
    token_type: payload.token_type || "Bearer",
  }, { targetAccountId: pending.targetAccountId || null }));
}

function startSession(pending, runner) {
  setStatus("waiting", {
    targetAccountId: pending.targetAccountId,
    message: "Waiting for browser authorization",
    callbackPort: pending.callbackPort,
  });
  const session = {
    pending,
    settled: false,
    timer: null,
    server: null,
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
  runner(pending)
    .then((result) => settleActive(null, result))
    .catch((error) => settleActive(error, null));
  return promise;
}

async function runPendingFlow(pending) {
  const runtime = getAntigravityRuntime();
  const client = typeof runtime.oauthClient === "function"
    ? runtime.oauthClient()
    : readOfficialOauthClient(typeof runtime.exePath === "function" ? runtime.exePath() : undefined);
  const listener = createCallbackListener(pending);
  await listener.ready;
  openBrowser(buildAuthUrl(pending, client));
  const code = await listener.codePromise;
  return finishAntigravityLogin(pending, code);
}

async function antigravityLoginFlow(options = {}) {
  if (getOAuthStatus().pending || getCursorOAuthStatus().pending) {
    throw new Error("authorization is already in progress");
  }
  if (active && !active.settled) {
    throw new Error("authorization is already in progress");
  }
  const now = Date.now();
  const pending = {
    state: b64url(16),
    targetAccountId: options.targetAccountId || null,
    callbackPort: ANTIGRAVITY_CALLBACK_PORT,
    createdAt: now,
    expiresAt: now + OAUTH_TTL_MS,
  };
  persistPending(pending);
  return startSession(pending, runPendingFlow);
}

function discardPendingAntigravityOAuth(reason) {
  if (active && !active.settled) return cancelAntigravityOAuth();
  clearPendingFile();
  setStatus("expired", { message: reason || "The pending OAuth authorization expired." });
  return true;
}

function restorePendingAntigravityOAuth() {
  if (active) return false;
  if (getOAuthStatus().pending || getCursorOAuthStatus().pending) {
    discardPendingAntigravityOAuth("authorization is already in progress");
    return false;
  }
  const pending = loadPending();
  if (!pending) return false;
  const promise = startSession(pending, runPendingFlow);
  promise.catch(() => {});
  return true;
}

module.exports = {
  antigravityLoginFlow,
  cancelAntigravityOAuth,
  discardPendingAntigravityOAuth,
  getAntigravityOAuthStatus,
  restorePendingAntigravityOAuth,
  buildAuthUrl,
  antigravityRedirectUri,
  parseAntigravityCallbackRequest,
  createCallbackListener,
};

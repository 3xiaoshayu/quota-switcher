const path = require("node:path");
const http = require("node:http");
const cp = require("node:child_process");
const { b64url, codeChallenge, buildId, ts, jwtPayload, extractChatgptAccountId, extractChatgptOrganizationId } = require("./crypto-utils");
const { CLIENT_ID, AUTH_URL, TOKEN_URL, SCOPES, CALLBACK_PORT, DATA_DIR } = require("./config");
const { httpJson, extractErrorCode } = require("./http-client");
const {
  ensureDir,
  protectData,
  unprotectData,
  loadIdx,
  saveIdx,
  upsertIndex,
  loadAcct,
  saveAcct,
  listAccts,
  deleteAcct,
} = require("./storage");
const { extraIdentityIds, foldDuplicateAccountsIfNeeded, mergePreservedQuota, pickIdentityKeeper, usableEmail } = require("./account-identity");
const { APP_DISPLAY_NAME } = require("./app-brand");
const { remapSelectedAccountIds } = require("./config-manager");
const { writeJsonAtomic, readJsonWithBackup, unlinkIfPresent } = require("./atomic-file");
const { logInfo, logWarn, logError } = require("./logger");

const PENDING_PATH = path.join(DATA_DIR, "codex_oauth_pending.json");
const OAUTH_TTL_MS = 5 * 60 * 1000;
let active = null;
let lastStatus = { status: "idle", message: null, targetAccountId: null, result: null };
let openUrlHandler = null;
let oauthAccountSavedHandler = null;

function publicAccountResult(result) {
  if (!result?.account) return null;
  return {
    accountId: result.account.id,
    email: result.account.email,
    mismatch: !!result.mismatch,
    targetAccountId: result.targetAccountId || null,
    updated: !!result.updated,
    switched: !!result.switched,
    switchError: result.switchError || null,
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

function getOAuthStatus() {
  return {
    ...lastStatus,
    pending: !!active && !active.settled,
    expiresAt: active?.pending?.expiresAt || null,
    callbackPort: CALLBACK_PORT,
  };
}

function setOpenUrlHandler(handler) {
  if (handler == null) {
    openUrlHandler = null;
    return;
  }
  if (typeof handler !== "function") {
    throw new TypeError("OAuth URL opener must be a function");
  }
  openUrlHandler = handler;
}

function setOAuthAccountSavedHandler(handler) {
  oauthAccountSavedHandler = typeof handler === "function" ? handler : null;
}

function shouldSwitchAfterOAuth(result) {
  if (!result?.account?.id) return false;
  // Reauthorizing the same card only refreshes tokens in the vault.
  // A new add, or a reauth that saved a different login as a new account,
  // should become the live Codex session — same as clicking 切换.
  if (result.targetAccountId && !result.mismatch) return false;
  return true;
}

async function switchCodexAfterOAuth(result) {
  if (!shouldSwitchAfterOAuth(result)) return result;
  const { withAccountLocks } = require("./operation-locks");
  const { doSwitch } = require("./switch");
  const currentId = loadIdx().current_account_id || null;
  const lockIds = ["__switch__", result.account.id];
  if (currentId && currentId !== result.account.id) lockIds.push(currentId);
  try {
    const switched = await withAccountLocks(lockIds, async () => {
      const account = loadAcct(result.account.id) || result.account;
      return doSwitch(account);
    });
    result.switched = !switched?.already;
    result.alreadyCurrent = !!switched?.already;
  } catch (error) {
    result.switched = false;
    result.switchError = error.message || String(error);
    logWarn(`OAuth account saved but Codex switch failed: ${result.switchError}`);
  }
  return result;
}

function notifyOAuthAccountSaved(result) {
  if (typeof oauthAccountSavedHandler !== "function" || !result?.account) return;
  try { oauthAccountSavedHandler(result); } catch (error) {
    logWarn(`OAuth account-saved handler failed: ${error.message}`);
  }
}

function openBrowser(url) {
  const target = String(url || "");
  if (!/^https:\/\//i.test(target)) {
    logWarn("Refused to open a non-HTTPS OAuth URL");
    return;
  }
  logInfo("Opening the OAuth authorization page in the browser");
  if (openUrlHandler) {
    Promise.resolve(openUrlHandler(target)).catch((error) => {
      logWarn(`Could not open OAuth browser: ${error.message}`);
    });
    return;
  }
  try {
    // explorer.exe treats ? and = in URLs as folder-search wildcards, so the
    // OAuth authorize link never reaches the browser. FileProtocolHandler
    // goes through ShellExecute and keeps the query string.
    const child = cp.spawn("rundll32.exe", ["url.dll,FileProtocolHandler", target], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => {
      logWarn(`Could not open OAuth browser: ${error.message}`);
    });
    child.unref();
  } catch (error) {
    logWarn(`Could not open OAuth browser: ${error.message}`);
  }
}

function persistPending(pending) {
  ensureDir(DATA_DIR);
  const protectedPayload = protectData(JSON.stringify(pending));
  writeJsonAtomic(PENDING_PATH, {
    version: 1,
    protected_payload: protectedPayload,
    created_at: pending.createdAt,
    expires_at: pending.expiresAt,
  });
}

function clearPendingFile() {
  try { unlinkIfPresent(PENDING_PATH); } catch {}
  try { unlinkIfPresent(`${PENDING_PATH}.bak`); } catch {}
}

function loadPending() {
  try {
    const envelope = readJsonWithBackup(PENDING_PATH);
    const pending = JSON.parse(unprotectData(envelope.protected_payload));
    if (!pending.expiresAt || pending.expiresAt <= Date.now()) {
      clearPendingFile();
      setStatus("expired", { message: "The pending OAuth authorization expired." });
      return null;
    }
    return pending;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.transientIoError) return null;
    // Leftover locks and other filesystem errors are not a dead session.
    if (!(error instanceof SyntaxError)) return null;
    clearPendingFile();
    logError(`Could not restore the pending OAuth authorization: ${error.message}`);
    setStatus("error", { message: "The pending OAuth authorization could not be restored." });
    return null;
  }
}

function buildPending(options = {}) {
  const verifier = b64url(32);
  const state = b64url(16);
  const redirectUri = `http://localhost:${CALLBACK_PORT}/auth/callback`;
  const createdAt = Date.now();
  return {
    verifier,
    state,
    redirectUri,
    challenge: codeChallenge(verifier),
    targetAccountId: options.targetAccountId || null,
    createdAt,
    expiresAt: createdAt + OAUTH_TTL_MS,
  };
}

function buildAuthorizationUrl(pending) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: pending.redirectUri,
    scope: SCOPES,
    code_challenge: pending.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: pending.state,
    originator: "codex_vscode",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function callbackHtml(success, message) {
  const color = success ? "#3fb950" : "#f85149";
  const title = success ? "授权已保存" : "授权失败";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0d1117;color:#c9d1d9}.card{padding:40px;border:1px solid #30363d;border-radius:14px;background:#161b22;text-align:center;max-width:420px}h1{color:${color};font-size:22px}p{color:#8b949e}</style></head><body><div class="card"><h1>${title}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

async function exchangeCode(pending, code) {
  const formBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  }).toString();
  const response = await httpJson(TOKEN_URL, {
    method: "POST",
    body: formBody,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    idempotent: false,
  });
  if (response.status >= 400) {
    const codeValue = extractErrorCode(response.body);
    throw new Error(`OAuth token exchange failed: HTTP ${response.status}${codeValue ? ` ${codeValue}` : ""}`);
  }
  const payload = JSON.parse(response.body);
  const tokens = {
    id_token: String(payload.id_token || ""),
    access_token: String(payload.access_token || ""),
    refresh_token: payload.refresh_token ? String(payload.refresh_token) : null,
  };
  if (!tokens.access_token) throw new Error("OAuth response did not contain an access token");
  return tokens;
}

function accountFromTokens(tokens, existing = null) {
  const payload = jwtPayload(tokens.id_token) || jwtPayload(tokens.access_token);
  if (!payload) throw new Error("The OAuth identity token could not be parsed");
  const auth = payload["https://api.openai.com/auth"] || {};
  // Keep known identity/profile fields when the new token carries thinner
  // claims; losing account_id would break the ChatGPT-Account-Id header.
  const email = String(payload.email || "") || String(existing?.email || "");
  // Prefer the access token claims (newer key names), then the id_token claim,
  // then any account id carried alongside the token payload.
  const accountId = extractChatgptAccountId(tokens.access_token)
    || (auth.chatgpt_account_id ? String(auth.chatgpt_account_id) : null)
    || (auth.account_id ? String(auth.account_id) : null)
    || (tokens.account_id || null)
    || existing?.account_id
    || existing?.tokens?.account_id
    || null;
  const userId = (auth.user_id ? String(auth.user_id) : (auth.chatgpt_user_id ? String(auth.chatgpt_user_id) : null))
    || existing?.user_id
    || null;
  const plan = (auth.chatgpt_plan_type ? String(auth.chatgpt_plan_type) : null)
    || existing?.plan_type
    || null;
  const subscriptionUntil = (auth.chatgpt_subscription_active_until
    ? String(auth.chatgpt_subscription_active_until)
    : null)
    || existing?.subscription_active_until
    || null;
  const organizationId = extractChatgptOrganizationId(tokens.access_token)
    || extractChatgptOrganizationId(tokens.id_token)
    || existing?.organization_id
    || null;
  const id = buildId(email, accountId, organizationId);
  const now = ts();
  return {
    id,
    email,
    plan_type: plan,
    subscription_active_until: subscriptionUntil,
    account_id: accountId,
    user_id: userId,
    organization_id: organizationId,
    auth_mode: "oauth",
    tokens: {
      id_token: tokens.id_token || "",
      access_token: tokens.access_token || "",
      refresh_token: tokens.refresh_token || existing?.tokens?.refresh_token || null,
      account_id: accountId,
    },
    token_generation: (existing?.token_generation || 0) + 1,
    token_updated_at: now,
    token_source_mode: "managed",
    requires_reauth: false,
    reauth_reason: null,
    banned: false,
    ...mergePreservedQuota(existing, {
      quota: tokens.quota,
      quota_error: tokens.quota_error,
      probe: tokens.probe,
      usage_updated_at: tokens.usage_updated_at,
    }),
    quota_refresh_failures: existing?.quota_refresh_failures || 0,
    quota_next_retry_at: existing?.quota_next_retry_at || null,
    created_at: existing?.created_at || now,
    last_used: existing?.last_used || now,
  };
}

function sameAccountIdentity(left, right) {
  const leftAccountId = String(left?.account_id || left?.tokens?.account_id || "");
  const rightAccountId = String(right?.account_id || right?.tokens?.account_id || "");
  if (leftAccountId && rightAccountId) return leftAccountId === rightAccountId;

  const leftEmail = usableEmail(left?.email).toLowerCase();
  const rightEmail = usableEmail(right?.email).toLowerCase();
  return !!leftEmail && leftEmail === rightEmail;
}

// Merge into an existing record for the same identity so identity-hash
// changes (e.g. improved organization extraction) cannot split an account.
function findSameIdentityId(preview, accounts = listAccts({ secrets: false })) {
  const matches = accounts.filter((account) => sameAccountIdentity(preview, account));
  if (preview.id && !matches.some((account) => account.id === preview.id)) {
    const self = accounts.find((account) => account.id === preview.id) || loadAcct(preview.id);
    if (self) matches.push(self);
  }
  return pickIdentityKeeper(matches, loadIdx().current_account_id)?.id || preview.id;
}

function persistCodexIndexEntry(account) {
  upsertIndex(account);
}

function collapseDuplicateCodexAccounts() {
  return foldDuplicateAccountsIfNeeded({
    listAccounts: listAccts,
    loadAccount: loadAcct,
    sameIdentity: sameAccountIdentity,
    currentId: loadIdx().current_account_id || null,
    persist: (keeper, extras) => {
      const index = loadIdx();
      if (extras.some((item) => item.id === index.current_account_id)) {
        index.current_account_id = keeper.id;
        saveIdx(index);
      }
      saveAcct(keeper);
      persistCodexIndexEntry(keeper);
      remapSelectedAccountIds(extras.map((item) => item.id), keeper.id);
      for (const extra of extras) {
        deleteAcct(extra.id, { allowCurrent: true });
      }
    },
    onError: (error) => logWarn(`Codex account fold skipped: ${error.message}`),
  });
}

async function upsert(tokens, options = {}) {
  const { withAccountLock, withAccountLocks } = require("./operation-locks");
  // Serialize identity lookup against other OAuth upserts so two callbacks
  // for the same person cannot pick different files before locks are held.
  return withAccountLock("__oauth_upsert__", async () => {
    const preview = accountFromTokens(tokens);
    const listed = listAccts({ secrets: false });
    const targetAccountId = options.targetAccountId || null;
    const targetAccount = targetAccountId ? loadAcct(targetAccountId) : null;
    const mismatch = !!targetAccountId && (!targetAccount || !sameAccountIdentity(preview, targetAccount));
    const saveId = !mismatch && targetAccountId ? targetAccountId : findSameIdentityId(preview, listed);
    const updated = listed.some((account) => account.id === saveId);
    const lockIds = [saveId, ...extraIdentityIds(preview, saveId, listed, sameAccountIdentity)];

    // Hold the account lock while merging so an in-flight token refresh cannot
    // overwrite this login with a stale snapshot (and vice versa).
    const account = await withAccountLocks(lockIds, async () => {
      const existing = loadAcct(saveId);
      const merged = accountFromTokens(tokens, existing);
      merged.id = saveId;
      saveAcct(merged);
      persistCodexIndexEntry(merged);
      const folded = collapseDuplicateCodexAccounts();
      return folded ? (loadAcct(saveId) || merged) : merged;
    });

    return { account, mismatch, targetAccountId, updated };
  });
}

function settleActive(error, result) {
  if (!active || active.settled) return;
  active.settled = true;
  clearTimeout(active.timer);
  const server = active.server;
  if (server.listening) {
    try { server.close(); } catch {}
  } else {
    server.once("listening", () => {
      try { server.close(); } catch {}
    });
  }
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
    logWarn(`OAuth flow ended without an account: ${error.message}`);
    reject(error);
    return;
  }
  setStatus("completed", { result, targetAccountId });
  logInfo(result.mismatch ? "OAuth completed with a different account and saved it separately" : "OAuth account authorization completed");
  resolve(result);
}

async function handleAuthorizationCode(pending, code) {
  const session = active;
  if (!session || session.settled || session.processing || session.pending !== pending) return false;
  session.processing = true;
  try {
    const tokens = await session.exchangeCode(pending, code);
    if (active !== session || session.settled) return false;
    const result = await upsert(tokens, { targetAccountId: pending.targetAccountId });
    if (active !== session || session.settled) return false;
    await switchCodexAfterOAuth(result);
    if (active !== session || session.settled) return false;
    notifyOAuthAccountSaved(result);
    settleActive(null, result);
    return true;
  } catch (error) {
    if (active !== session || session.settled) return false;
    logError(`OAuth token exchange failed: ${error.message}`);
    settleActive(error);
    return false;
  }
}

function startPendingSession(pending, options = {}) {
  if (active && !active.settled) throw new Error("An OAuth authorization is already in progress");
  persistPending(pending);
  setStatus("pending", { targetAccountId: pending.targetAccountId, message: "Waiting for browser authorization." });

  const completion = new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url || "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404);
        response.end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || state !== pending.state) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(callbackHtml(false, "回调缺少数据，或状态不匹配。"));
        return;
      }
      void handleAuthorizationCode(pending, code).then((ok) => {
        if (response.writableEnded) return;
        const success = !!ok && lastStatus.status === "completed";
        response.writeHead(success ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(callbackHtml(
          success,
          success ? `可以回到 ${APP_DISPLAY_NAME} 查看结果。` : "授权未能完成，请回到管理器重试。",
        ));
      }).catch(() => {
        if (response.writableEnded) return;
        response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        response.end(callbackHtml(false, "授权未能完成，请回到管理器重试。"));
      });
    });

    active = {
      pending,
      server,
      completion: null,
      exchangeCode: typeof options.exchangeCode === "function" ? options.exchangeCode : exchangeCode,
      resolve,
      reject,
      settled: false,
      processing: false,
      timer: setTimeout(() => {
        const error = new Error("OAuth authorization timed out");
        error.code = "oauth_timeout";
        settleActive(error);
      }, Math.max(1000, pending.expiresAt - Date.now())),
    };

    server.once("error", (error) => {
      // A stale server error (e.g. late bind failure after cancellation)
      // must not settle a newer session that owns `active` now.
      if (!active || active.server !== server) return;
      const wrapped = new Error(`OAuth callback port ${CALLBACK_PORT} is unavailable: ${error.message}`);
      wrapped.code = "oauth_port_unavailable";
      settleActive(wrapped);
    });
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      if (options.openBrowser !== false) openBrowser(buildAuthorizationUrl(pending));
    });
  });
  if (active) active.completion = completion;
  return completion;
}

function oauthLoginFlow(options = {}) {
  const { getCursorOAuthStatus } = require("./cursor-oauth");
  if (getCursorOAuthStatus().pending) {
    throw new Error("authorization is already in progress");
  }
  return startPendingSession(buildPending(options), {
    openBrowser: options.openBrowser !== false,
    exchangeCode: options.exchangeCode,
  });
}

function restorePendingOAuth() {
  const pending = loadPending();
  if (!pending) return false;
  startPendingSession(pending, { openBrowser: false }).catch(() => {});
  logInfo("Restored a pending OAuth callback listener");
  return true;
}

function cancelOAuth() {
  if (!active || active.settled) {
    clearPendingFile();
    setStatus("cancelled", { message: "No OAuth authorization is pending." });
    return false;
  }
  const error = new Error("OAuth authorization was cancelled");
  error.code = "oauth_cancelled";
  settleActive(error);
  return true;
}

async function completeOAuthManually(callbackUrl) {
  if (!active || active.settled) throw new Error("No OAuth authorization is pending");
  const session = active;
  let url;
  try {
    url = new URL(String(callbackUrl || ""));
  } catch {
    throw new Error("Enter the complete OAuth callback URL");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || state !== session.pending.state) throw new Error("The callback URL is missing code or has an invalid state");
  void handleAuthorizationCode(session.pending, code);
  return session.completion;
}

module.exports = {
  PENDING_PATH,
  accountFromTokens,
  oauthLoginFlow,
  restorePendingOAuth,
  cancelOAuth,
  completeOAuthManually,
  getOAuthStatus,
  setOpenUrlHandler,
  setOAuthAccountSavedHandler,
  upsert,
  sameAccountIdentity,
  collapseDuplicateCodexAccounts,
};

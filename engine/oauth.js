const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const cp = require("node:child_process");
const { b64url, codeChallenge, buildId, ts, jwtPayload } = require("./crypto-utils");
const { CLIENT_ID, AUTH_URL, TOKEN_URL, SCOPES, CALLBACK_PORT, DATA_DIR } = require("./config");
const { httpJson, extractErrorCode } = require("./http-client");
const {
  ensureDir,
  protectData,
  unprotectData,
  loadIdx,
  saveIdx,
  loadAcct,
  saveAcct,
} = require("./storage");
const { writeJsonAtomic } = require("./atomic-file");
const { logInfo, logWarn, logError } = require("./logger");

const PENDING_PATH = path.join(DATA_DIR, "codex_oauth_pending.json");
const OAUTH_TTL_MS = 5 * 60 * 1000;
let active = null;
let lastStatus = { status: "idle", message: null, targetAccountId: null, result: null };

function publicAccountResult(result) {
  if (!result?.account) return null;
  return {
    accountId: result.account.id,
    email: result.account.email,
    mismatch: !!result.mismatch,
    targetAccountId: result.targetAccountId || null,
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

function openBrowser(url) {
  try {
    const child = cp.spawn("explorer.exe", [url], {
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
  try { fs.unlinkSync(PENDING_PATH); } catch {}
  try { fs.unlinkSync(`${PENDING_PATH}.bak`); } catch {}
}

function loadPending() {
  if (!fs.existsSync(PENDING_PATH)) return null;
  try {
    const envelope = JSON.parse(fs.readFileSync(PENDING_PATH, "utf8"));
    const pending = JSON.parse(unprotectData(envelope.protected_payload));
    if (!pending.expiresAt || pending.expiresAt <= Date.now()) {
      clearPendingFile();
      setStatus("expired", { message: "The pending OAuth authorization expired." });
      return null;
    }
    return pending;
  } catch (error) {
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

function callbackHtml(success, message) {
  const color = success ? "#3fb950" : "#f85149";
  const title = success ? "Authorization received" : "Authorization failed";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0d1117;color:#c9d1d9}.card{padding:40px;border:1px solid #30363d;border-radius:14px;background:#161b22;text-align:center;max-width:420px}h1{color:${color};font-size:22px}p{color:#8b949e}</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

async function exchangeCode(pending, code) {
  const formBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
    scope: SCOPES,
  }).toString();
  const response = await httpJson(TOKEN_URL, {
    method: "POST",
    body: formBody,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
  const email = String(payload.email || "");
  const accountId = auth.account_id ? String(auth.account_id) : (tokens.account_id || null);
  const userId = auth.user_id ? String(auth.user_id) : null;
  const plan = auth.chatgpt_plan_type ? String(auth.chatgpt_plan_type) : null;
  const subscriptionUntil = auth.chatgpt_subscription_active_until
    ? String(auth.chatgpt_subscription_active_until)
    : null;
  const defaultOrganization = (auth.organizations || []).find((organization) => organization.is_default);
  const organizationId = defaultOrganization?.id || null;
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
    quota: existing?.quota || null,
    quota_error: null,
    usage_updated_at: existing?.usage_updated_at || null,
    quota_refresh_failures: 0,
    quota_next_retry_at: null,
    subscription_query_last_success_at: existing?.subscription_query_last_success_at || null,
    subscription_query_last_attempt_at: existing?.subscription_query_last_attempt_at || null,
    subscription_query_next_retry_at: null,
    subscription_query_last_error: null,
    reset_credits: existing?.reset_credits || null,
    reset_credits_error: null,
    created_at: existing?.created_at || now,
    last_used: existing?.last_used || now,
  };
}

function upsert(tokens, options = {}) {
  const preview = accountFromTokens(tokens);
  const targetAccountId = options.targetAccountId || null;
  const mismatch = !!targetAccountId && preview.id !== targetAccountId;
  const saveId = mismatch ? preview.id : (targetAccountId || preview.id);
  const existing = loadAcct(saveId);
  const account = accountFromTokens(tokens, existing);
  account.id = saveId;
  saveAcct(account);

  const index = loadIdx();
  const summary = {
    id: account.id,
    email: account.email,
    plan_type: account.plan_type,
    subscription_active_until: account.subscription_active_until,
    created_at: account.created_at,
    last_used: account.last_used,
  };
  const position = index.accounts.findIndex((item) => item.id === account.id);
  if (position >= 0) index.accounts[position] = summary;
  else index.accounts.push(summary);
  saveIdx(index);

  return { account, mismatch, targetAccountId };
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
  if (!session || session.settled || session.processing || session.pending !== pending) return;
  session.processing = true;
  try {
    const tokens = await session.exchangeCode(pending, code);
    if (active !== session || session.settled) return;
    const result = upsert(tokens, { targetAccountId: pending.targetAccountId });
    settleActive(null, result);
  } catch (error) {
    if (active !== session || session.settled) return;
    logError(`OAuth token exchange failed: ${error.message}`);
    settleActive(error);
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
        response.end(callbackHtml(false, "The callback was missing data or its state did not match."));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(callbackHtml(true, "You can return to Codex Account Manager."));
      void handleAuthorizationCode(pending, code);
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
  upsert,
};

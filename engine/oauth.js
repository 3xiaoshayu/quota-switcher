const http = require("node:http");
const { b64url, codeChallenge, buildId, ts, jwtPayload } = require("./crypto-utils");
const { CLIENT_ID, AUTH_URL, TOKEN_URL, SCOPES, CALLBACK_PORT } = require("./config");
const { httpJson } = require("./http-client");
const { loadIdx, saveIdx, loadAcct, saveAcct } = require("./storage");

function openBrowser(url) {
  const cp = require("node:child_process");
  cp.exec('start "" "' + url + '"', { stdio: "ignore" });
}

async function oauthLoginFlow() {
  // 检查端口可用
  const free = await new Promise((r) => {
    const s = http.createServer();
    s.listen(CALLBACK_PORT, "127.0.0.1", () => { s.close(); r(true); });
    s.on("error", () => r(false));
  });
  if (!free) throw new Error("端口 " + CALLBACK_PORT + " 被占用");

  const verifier = b64url(32);
  const challenge = codeChallenge(verifier);
  const state = b64url(16);
  const redirectUri = "http://localhost:" + CALLBACK_PORT + "/auth/callback";
  const authUrl = AUTH_URL +
    "?response_type=code&client_id=" + encodeURIComponent(CLIENT_ID) +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&scope=" + encodeURIComponent(SCOPES) +
    "&code_challenge=" + challenge + "&code_challenge_method=S256" +
    "&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=" + state +
    "&originator=codex_vscode";

  let srv = null, code;
  try {
    code = await new Promise((resolve, reject) => {
      let settled = false;
      srv = http.createServer((req, res) => {
        const u = new URL(req.url || "/", "http://127.0.0.1:" + CALLBACK_PORT);
        if (req.method === "GET" && u.pathname === "/cancel") {
          res.writeHead(200); res.end();
          if (!settled) { settled = true; srv.close(); reject(new Error("OAuth 已取消")); }
          return;
        }
        if (u.pathname === "/auth/callback") {
          const c2 = u.searchParams.get("code"), s2 = u.searchParams.get("state");
          const html = (title, icon, h1Color, h1Text) =>
            '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title>' +
            '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:linear-gradient(135deg,#0d1117 0%,#161b22 100%);color:#c9d1d9}' +
            '.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:48px 40px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.4)}' +
            '.icon{font-size:48px;margin-bottom:16px}h1{color:' + h1Color + ';font-size:24px;margin-bottom:8px}p{color:#8b949e;font-size:14px}</style></head><body>' +
            '<div class="card"><div class="icon">' + icon + '</div><h1>' + h1Text + '</h1><p>您可以关闭此页面</p></div></body></html>';
          if (c2 && s2 === state) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html("授权成功", "✅", "#3fb950", "授权成功"));
            settled = true; srv.close(); resolve(c2);
          } else {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html("授权失败", "❌", "#f85149", "授权失败"));
          }
        } else { res.writeHead(404); res.end(); }
      });
      srv.listen(CALLBACK_PORT, "127.0.0.1", () => {
        openBrowser(authUrl);
      });
      setTimeout(() => {
        if (!settled) { settled = true; srv.close(); reject(new Error("OAuth 超时（5 分钟）")); }
      }, 300000);
    });
  } catch (e) { throw e; }

  // 交换 token
  const formBody = Object.entries({
    grant_type: "authorization_code", client_id: CLIENT_ID, code,
    redirect_uri: redirectUri, code_verifier: verifier, scope: SCOPES,
  }).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

  const resp = await httpJson(TOKEN_URL, {
    method: "POST", body: formBody,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (resp.status >= 400) {
    const { extractErrorCode } = require("./http-client");
    const ec = extractErrorCode(resp.body);
    throw new Error("Token 交换失败: HTTP " + resp.status + (ec ? " " + ec : ""));
  }

  const data = JSON.parse(resp.body);
  const tokens = {
    id_token: String(data.id_token || ""),
    access_token: String(data.access_token || ""),
    refresh_token: data.refresh_token ? String(data.refresh_token) : null,
  };
  if (!tokens.access_token) throw new Error("响应缺少 access_token");

  return upsert(tokens);
}

function upsert(tokens) {
  const pl = jwtPayload(tokens.id_token);
  if (!pl) throw new Error("无法解析 id_token");

  const ad = pl["https://api.openai.com/auth"] || {};
  const email = String(pl.email || "");
  const aid = ad.account_id ? String(ad.account_id) : null;
  const uid = ad.user_id ? String(ad.user_id) : null;
  const plan = ad.chatgpt_plan_type ? String(ad.chatgpt_plan_type) : null;
  const subUntil = ad.chatgpt_subscription_active_until ? String(ad.chatgpt_subscription_active_until) : null;
  const defO = (ad.organizations || []).find((o) => o.is_default);
  const orgId = defO ? defO.id : null;
  const cid = buildId(email, aid, orgId);
  const now = ts();
  const ex = loadAcct(cid);

  const acct = {
    id: cid, email,
    plan_type: plan,
    subscription_active_until: subUntil,
    account_id: aid, user_id: uid, organization_id: orgId,
    auth_mode: "oauth",
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      account_id: aid,
    },
    token_generation: (ex ? ex.token_generation : 0) + 1,
    token_updated_at: now, token_source_mode: "managed",
    requires_reauth: false, reauth_reason: null,
    quota: ex ? ex.quota : null,
    quota_error: null,
    usage_updated_at: ex ? ex.usage_updated_at : null,
    subscription_query_last_success_at: ex ? ex.subscription_query_last_success_at : null,
    subscription_query_last_attempt_at: ex ? ex.subscription_query_last_attempt_at : null,
    subscription_query_next_retry_at: null,
    subscription_query_last_error: null,
    reset_credits: null,
    created_at: ex ? ex.created_at : now,
    last_used: now,
  };
  saveAcct(acct);

  const idx = loadIdx();
  const found = idx.accounts.find((a) => a.id === cid);
  if (!found) {
    idx.accounts.push({
      id: cid, email, plan_type: plan,
      subscription_active_until: subUntil,
      created_at: acct.created_at, last_used: acct.last_used,
    });
  } else {
    found.last_used = acct.last_used;
  }
  idx.current_account_id = cid;
  saveIdx(idx);

  return acct;
}

module.exports = { oauthLoginFlow, upsert };

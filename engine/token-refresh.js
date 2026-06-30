const { TOKEN_URL, CLIENT_ID } = require("./config");
const { ts, isTokenExpired, jwtExp } = require("./crypto-utils");
const { httpJson, extractErrorCode } = require("./http-client");
const { saveAcct, loadAcct, listAccts } = require("./storage");
const { writeAuthJson, writeProjection } = require("./switch");

function tokenRefreshError(status, code) {
  if (code === "unsupported_country_region_territory") {
    return "当前网络出口被 OpenAI 判定为不支持的地区，请确认应用已走可用代理后重试";
  }
  return "HTTP " + status + (code ? " " + code : "");
}

function tokenTimeLeft(acct) {
  const exp = acct.tokens?.access_token ? jwtExp(acct.tokens.access_token) : null;
  return exp ? exp - ts() : null;
}

function hasTokenRepairSignal(acct) {
  if (acct.requires_reauth) return true;
  const code = String(acct.quota_error?.code || "").toLowerCase();
  const message = String(acct.quota_error?.message || "").toLowerCase();
  return [
    "invalid_grant",
    "invalid_token",
    "token_revoked",
    "token_invalidated",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ].some((item) => code === item || message.includes(item));
}

async function refreshOneTok(acct, options = {}) {
  const force = typeof options === "boolean" ? options : !!options.force;
  if (!force && !needsRefresh(acct) && !hasTokenRepairSignal(acct)) {
    return { ok: true, skipped: true, gen: acct.token_generation || 0, timeLeft: tokenTimeLeft(acct) };
  }
  if (!acct.tokens.refresh_token) return { ok: false, error: "缺少 refresh_token", revoked: false };
  const body = JSON.stringify({
    client_id: CLIENT_ID, grant_type: "refresh_token",
    refresh_token: acct.tokens.refresh_token,
  });
  try {
    const resp = await httpJson(TOKEN_URL, {
      method: "POST", body,
      headers: { "Content-Type": "application/json" },
    });
    if (resp.status >= 400) {
      const code = extractErrorCode(resp.body);
      const revoked = code === "token_revoked" || code === "token_invalidated";
      return { ok: false, error: tokenRefreshError(resp.status, code), revoked, detail: resp.body.slice(0, 300) };
    }
    const data = JSON.parse(resp.body);
    const idTok = data.id_token || acct.tokens.id_token;
    const accTok = data.access_token || "";
    const refTok = data.refresh_token || acct.tokens.refresh_token;
    if (!accTok) return { ok: false, error: "响应无 access_token", revoked: false };

    acct.tokens = {
      id_token: String(idTok),
      access_token: String(accTok),
      refresh_token: refTok ? String(refTok) : null,
      account_id: acct.account_id,
    };
    acct.token_generation += 1;
    acct.token_updated_at = ts();
    acct.quota_error = null;
    acct.requires_reauth = false;
    acct.reauth_reason = null;
    saveAcct(acct);
    return { ok: true, skipped: false, gen: acct.token_generation };
  } catch (err) {
    return { ok: false, error: err.message, revoked: false };
  }
}

function needsRefresh(acct) {
  if (!acct.tokens.refresh_token) return false;
  return isTokenExpired(acct.tokens.access_token);
}

async function refreshAll(force) {
  const accts = listAccts();
  if (!accts.length) return { okCount: 0, revivedCount: 0, deadCount: 0, results: [] };

  let okN = 0, revived = 0, dead = 0;
  const results = [];

  for (const a of accts) {
    if (!force && !needsRefresh(a) && !hasTokenRepairSignal(a)) {
      okN++;
      results.push({ email: a.email, ok: true, skipped: true });
      continue;
    }
    const wasRepair = hasTokenRepairSignal(a);
    const r = await refreshOneTok(a, { force });
    results.push({ email: a.email, ok: r.ok, skipped: false, gen: r.gen, error: r.error });

    if (r.ok) {
      if (wasRepair) revived++;
      else okN++;
    } else if (r.revoked) {
      dead++;
      a.quota_error = { code: "token_revoked", message: r.detail, timestamp: ts() };
      a.requires_reauth = true;
      a.reauth_reason = "refresh_token 已被撤销";
      saveAcct(a);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // 保持当前账号 auth.json 最新
  const { loadIdx } = require("./storage");
  const idx = loadIdx();
  if (idx.current_account_id) {
    const cur = loadAcct(idx.current_account_id);
    if (cur) { writeAuthJson(cur); writeProjection(cur); }
  }

  return { okCount: okN, revivedCount: revived, deadCount: dead, results };
}

module.exports = { refreshOneTok, needsRefresh, refreshAll };

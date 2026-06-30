const { ACCOUNT_CHECK_URL, SUBSCRIPTIONS_URL, SUB_RETRY_SEC } = require("./config");
const { ts } = require("./crypto-utils");
const { parseTsStr } = require("./time-utils");
const { httpJson, buildCodexHeaders } = require("./http-client");
const { loadIdx, saveIdx, saveAcct } = require("./storage");

async function fetchSubscriptionStatus(acct) {
  const headers = buildCodexHeaders(acct);
  const tz = -(new Date().getTimezoneOffset());
  const url = ACCOUNT_CHECK_URL + "?timezone_offset_min=" + tz;
  const resp1 = await httpJson(url, { headers });

  let planType = null, subUntil = null, remoteAccountId = null;

  if (resp1.status < 400) {
    const data = JSON.parse(resp1.body);
    const records = [];
    if (data.accounts) {
      if (Array.isArray(data.accounts)) for (const item of data.accounts) records.push(item);
      else if (typeof data.accounts === "object") for (const [, v] of Object.entries(data.accounts)) records.push(v);
    }
    if (records.length === 0 && Array.isArray(data)) for (const item of data) records.push(item);

    if (records.length > 0) {
      const { extractChatgptAccountId } = require("./crypto-utils");
      const prefId = acct.account_id || extractChatgptAccountId(acct.tokens.access_token);
      let target = records.find((r) => {
        const o = r.account || r;
        return (o.account_id || o.id || o.chatgpt_account_id || o.workspace_id) === prefId;
      }) || records[0];
      const o = target.account || target;
      remoteAccountId = o.account_id || o.id || o.chatgpt_account_id || o.workspace_id || null;
      const ent = target.entitlement || {};
      planType = ent.subscription_plan || o.plan_type || o.planType || null;
      subUntil = ent.expires_at || o.expires_at || null;
    }
  }

  // Fallback: subscriptions
  if (!subUntil) {
    const { extractChatgptAccountId } = require("./crypto-utils");
    const aid = remoteAccountId || acct.account_id || extractChatgptAccountId(acct.tokens.access_token);
    if (aid) {
      try {
        const resp2 = await httpJson(SUBSCRIPTIONS_URL + "?account_id=" + encodeURIComponent(aid), { headers });
        if (resp2.status < 400) {
          const data2 = JSON.parse(resp2.body);
          if (!planType) planType = data2.subscription_plan || data2.plan_type || null;
          if (!subUntil) subUntil = data2.active_until || data2.expires_at || null;
        }
      } catch {}
    }
  }

  return { account_id: remoteAccountId, plan_type: planType, subscription_active_until: subUntil };
}

async function refreshSubscription(acct, force) {
  const nowTs = ts();
  if (!force && acct.subscription_active_until) {
    const expTs = parseTsStr(acct.subscription_active_until);
    if (expTs && expTs > nowTs) return false;
  }
  const snap = await fetchSubscriptionStatus(acct);
  let changed = false;
  if (snap.account_id && acct.account_id !== snap.account_id) { acct.account_id = snap.account_id; changed = true; }
  if (snap.plan_type && acct.plan_type !== snap.plan_type) { acct.plan_type = snap.plan_type; changed = true; }
  if (snap.subscription_active_until && acct.subscription_active_until !== snap.subscription_active_until) {
    acct.subscription_active_until = snap.subscription_active_until; changed = true;
  }
  acct.subscription_query_last_attempt_at = nowTs;
  if (acct.subscription_active_until) {
    const expTs = parseTsStr(acct.subscription_active_until);
    if (expTs && expTs > nowTs) {
      acct.subscription_query_last_success_at = nowTs;
      acct.subscription_query_next_retry_at = null;
      acct.subscription_query_last_error = null;
    } else {
      acct.subscription_query_next_retry_at = nowTs + SUB_RETRY_SEC;
      acct.subscription_query_last_error = "订阅接口未返回有效订阅时间";
    }
  }
  saveAcct(acct);
  if (changed) {
    const idx = loadIdx();
    const ai = idx.accounts.find((a) => a.id === acct.id);
    if (ai) { ai.plan_type = acct.plan_type; ai.subscription_active_until = acct.subscription_active_until; saveIdx(idx); }
  }
  return changed;
}

module.exports = { fetchSubscriptionStatus, refreshSubscription };

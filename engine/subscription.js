const { ACCOUNT_CHECK_URL, SUBSCRIPTIONS_URL, SUB_RETRY_SEC } = require("./config");
const { ts, extractChatgptAccountId } = require("./crypto-utils");
const { parseTsStr } = require("./time-utils");
const { httpJson, buildCodexHeaders, extractErrorCode } = require("./http-client");
const { loadIdx, saveIdx, saveAcct } = require("./storage");

function httpError(label, response) {
  const code = extractErrorCode(response.body);
  return new Error(`${label}: HTTP ${response.status}${code ? ` ${code}` : ""}`);
}

function subscriptionRecordAccountId(record) {
  const value = record?.account || record || {};
  const id = value.account_id || value.id || value.chatgpt_account_id || value.workspace_id || null;
  return id == null ? null : String(id);
}

function selectSubscriptionAccount(records, preferredId) {
  if (!records.length) return null;
  if (!preferredId) return records[0];
  const expected = String(preferredId);
  const target = records.find((record) => subscriptionRecordAccountId(record) === expected);
  if (target) return target;
  const error = new Error("Subscription response did not contain the expected account.");
  error.code = "subscription_account_mismatch";
  throw error;
}

async function fetchSubscriptionStatus(account) {
  const headers = buildCodexHeaders(account);
  const timezoneOffset = -(new Date().getTimezoneOffset());
  const accountResponse = await httpJson(
    `${ACCOUNT_CHECK_URL}?timezone_offset_min=${timezoneOffset}`,
    { headers },
  );
  if (accountResponse.status >= 400) throw httpError("Subscription account check failed", accountResponse);

  const payload = JSON.parse(accountResponse.body);
  const records = [];
  if (Array.isArray(payload)) records.push(...payload);
  else if (Array.isArray(payload.accounts)) records.push(...payload.accounts);
  else if (payload.accounts && typeof payload.accounts === "object") records.push(...Object.values(payload.accounts));

  const preferredId = account.account_id || extractChatgptAccountId(account.tokens.access_token);
  const target = selectSubscriptionAccount(records, preferredId);

  const value = target?.account || target || {};
  const entitlement = target?.entitlement || {};
  const remoteAccountId = value.account_id || value.id || value.chatgpt_account_id || value.workspace_id || preferredId || null;
  let planType = entitlement.subscription_plan || value.plan_type || value.planType || null;
  let subscriptionUntil = entitlement.expires_at || value.expires_at || null;

  if (!subscriptionUntil && remoteAccountId) {
    const subscriptionResponse = await httpJson(
      `${SUBSCRIPTIONS_URL}?account_id=${encodeURIComponent(remoteAccountId)}`,
      { headers },
    );
    if (subscriptionResponse.status >= 400) throw httpError("Subscription lookup failed", subscriptionResponse);
    const subscription = JSON.parse(subscriptionResponse.body);
    planType = planType || subscription.subscription_plan || subscription.plan_type || null;
    subscriptionUntil = subscription.active_until || subscription.expires_at || null;
  }

  return {
    account_id: remoteAccountId,
    plan_type: planType,
    subscription_active_until: subscriptionUntil,
  };
}

function shouldAttemptSubscriptionRefresh(account, force, now = ts()) {
  if (force) return true;
  if (Number(account.subscription_query_next_retry_at || 0) > now) return false;
  if (!account.subscription_active_until) return true;
  const expiry = parseTsStr(account.subscription_active_until);
  return !expiry || expiry <= now;
}

async function refreshSubscription(account, force = false) {
  const now = ts();
  if (!shouldAttemptSubscriptionRefresh(account, force, now)) return false;

  account.subscription_query_last_attempt_at = now;
  let snapshot;
  try {
    snapshot = await fetchSubscriptionStatus(account);
  } catch (error) {
    account.subscription_query_next_retry_at = now + SUB_RETRY_SEC;
    account.subscription_query_last_error = error.message || String(error);
    saveAcct(account);
    throw error;
  }

  let changed = false;
  if (snapshot.account_id && account.account_id !== snapshot.account_id) {
    account.account_id = snapshot.account_id;
    changed = true;
  }
  if (snapshot.plan_type && account.plan_type !== snapshot.plan_type) {
    account.plan_type = snapshot.plan_type;
    changed = true;
  }
  if (snapshot.subscription_active_until && account.subscription_active_until !== snapshot.subscription_active_until) {
    account.subscription_active_until = snapshot.subscription_active_until;
    changed = true;
  }

  const expiry = account.subscription_active_until ? parseTsStr(account.subscription_active_until) : null;
  if (expiry && expiry > now) {
    account.subscription_query_last_success_at = now;
    account.subscription_query_next_retry_at = null;
    account.subscription_query_last_error = null;
  } else {
    account.subscription_query_next_retry_at = now + SUB_RETRY_SEC;
    account.subscription_query_last_error = "Subscription endpoints did not return an active subscription.";
  }
  saveAcct(account);

  if (changed) {
    const index = loadIdx();
    const item = index.accounts.find((entry) => entry.id === account.id);
    if (item) {
      item.plan_type = account.plan_type;
      item.subscription_active_until = account.subscription_active_until;
      saveIdx(index);
    }
  }
  return changed;
}

module.exports = {
  fetchSubscriptionStatus,
  refreshSubscription,
  selectSubscriptionAccount,
  shouldAttemptSubscriptionRefresh,
};

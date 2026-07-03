const crypto = require("node:crypto");
const { RESET_CREDITS_URL, RESET_CONSUME_URL } = require("./config");
const { parseTsStr } = require("./time-utils");
const { httpJson, buildCodexHeaders, extractErrorCode } = require("./http-client");
const { saveAcct } = require("./storage");
const { ts } = require("./crypto-utils");

async function fetchResetCredits(acct) {
  const headers = buildCodexHeaders(acct);
  const resp = await httpJson(RESET_CREDITS_URL, { headers });
  if (resp.status >= 400) {
    const code = extractErrorCode(resp.body);
    throw new Error("HTTP " + resp.status + (code ? " " + code : "") + " " + resp.body.slice(0, 200));
  }
  const payload = JSON.parse(resp.body);
  return parseResetCreditsPayload(payload);
}

function parseResetCreditsPayload(payload) {
  const creditArr = payload.credits || (payload.data || {}).credits || [];
  const credits = creditArr
    .map((cr) => ({
      id: cr.id || cr.credit_id || cr.creditId || null,
      status: (cr.status || cr.state || "available").toLowerCase(),
      reset_type: cr.type || cr.reset_type || cr.resetType || null,
      granted_at: cr.granted_at ? parseTsStr(String(cr.granted_at)) : null,
      expires_at: cr.expires_at ? parseTsStr(String(cr.expires_at)) : null,
      redeemed_at: cr.redeemed_at || cr.used_at || cr.consumed_at ? parseTsStr(String(cr.redeemed_at || cr.used_at || cr.consumed_at)) : null,
    }))
    .filter((c) => {
      const st = c.status;
      return st !== "redeemed" && st !== "used" && st !== "consumed" && st !== "expired";
    });
  const explicitAvailable =
    payload.available_count ?? payload.availableCount ??
    (payload.data && (payload.data.available_count ?? payload.data.availableCount));
  const available = explicitAvailable == null
    ? credits.length
    : Math.max(0, Number(explicitAvailable) || 0);
  const nextExpiry = credits.length > 0 ? credits.map((c) => c.expires_at).filter(Boolean).sort()[0] : null;

  return { available_count: available, credits, next_expires_at: nextExpiry, updated_at: ts() };
}

async function consumeResetCredit(acct, dependencies = {}) {
  const request = dependencies.httpJson || httpJson;
  const refreshTask = dependencies.fetchResetCredits || fetchResetCredits;
  const persist = dependencies.saveAcct || saveAcct;
  const headers = buildCodexHeaders(acct);
  const knownAvailable = Number(acct.reset_credits?.available_count);
  if (!acct.reset_credit_pending_redeem_id && Number.isFinite(knownAvailable) && knownAvailable <= 0) {
    throw new Error("No reset credits are available for this account.");
  }

  const redeemId = acct.reset_credit_pending_redeem_id || crypto.randomUUID();
  acct.reset_credit_pending_redeem_id = redeemId;
  persist(acct);

  let resp;
  try {
    resp = await request(RESET_CONSUME_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ redeem_request_id: redeemId }),
    });
  } catch (error) {
    const message = error.message || String(error);
    acct.reset_credits_error = { message, timestamp: ts() };
    persist(acct);
    const unknown = new Error(`Reset credit request status is unknown: ${message}. Retrying will reuse the same request id.`);
    unknown.code = "reset_consume_status_unknown";
    throw unknown;
  }
  if (resp.status >= 400) {
    const code = extractErrorCode(resp.body);
    const detail = "HTTP " + resp.status + (code ? " " + code : "") + " " + resp.body.slice(0, 200);
    const statusUnknown = resp.status === 408 || resp.status === 409 || resp.status >= 500;
    if (statusUnknown) {
      acct.reset_credits_error = { message: detail, timestamp: ts() };
      persist(acct);
      const unknown = new Error(`Reset credit request status is unknown: ${detail}. Retrying will reuse the same request id.`);
      unknown.code = "reset_consume_status_unknown";
      throw unknown;
    }
    acct.reset_credit_pending_redeem_id = null;
    persist(acct);
    throw new Error(detail);
  }

  acct.reset_credit_pending_redeem_id = null;
  if (Number.isFinite(knownAvailable)) {
    acct.reset_credits = {
      ...(acct.reset_credits || {}),
      available_count: Math.max(0, knownAvailable - 1),
    };
  }
  persist(acct);

  try {
    const snap = await refreshTask(acct);
    acct.reset_credits = snap;
    acct.reset_credits_error = null;
    persist(acct);
    return {
      consumed: true,
      balance_refreshed: true,
      reset_credits: snap,
      refresh_error: null,
    };
  } catch (error) {
    acct.reset_credits_error = { message: error.message || String(error), timestamp: ts() };
    persist(acct);
    return {
      consumed: true,
      balance_refreshed: false,
      reset_credits: acct.reset_credits || null,
      refresh_error: error.message || String(error),
    };
  }
}

module.exports = { fetchResetCredits, consumeResetCredit, parseResetCreditsPayload };

const crypto = require("node:crypto");
const { RESET_CREDITS_URL, RESET_CONSUME_URL } = require("./config");
const { parseTsStr } = require("./time-utils");
const { httpJson, buildCodexHeaders, extractErrorCode } = require("./http-client");
const { saveAcct } = require("./storage");

async function fetchResetCredits(acct) {
  const headers = buildCodexHeaders(acct);
  const resp = await httpJson(RESET_CREDITS_URL, { headers });
  if (resp.status >= 400) {
    const code = extractErrorCode(resp.body);
    throw new Error("HTTP " + resp.status + (code ? " " + code : "") + " " + resp.body.slice(0, 200));
  }
  const payload = JSON.parse(resp.body);
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
  const available =
    payload.available_count || payload.availableCount ||
    (payload.data && (payload.data.available_count || payload.data.availableCount)) ||
    credits.length;
  const nextExpiry = credits.length > 0 ? credits.map((c) => c.expires_at).filter(Boolean).sort()[0] : null;

  return { available_count: available, credits, next_expires_at: nextExpiry };
}

async function consumeResetCredit(acct) {
  const headers = buildCodexHeaders(acct);
  const redeemId = crypto.randomUUID();
  const resp = await httpJson(RESET_CONSUME_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ redeem_request_id: redeemId }),
  });
  if (resp.status >= 400) {
    const code = extractErrorCode(resp.body);
    throw new Error("HTTP " + resp.status + (code ? " " + code : "") + " " + resp.body.slice(0, 200));
  }
  try {
    const snap = await fetchResetCredits(acct);
    acct.reset_credits = snap;
    saveAcct(acct);
  } catch {}
  return true;
}

module.exports = { fetchResetCredits, consumeResetCredit };

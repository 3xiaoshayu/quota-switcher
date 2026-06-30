const { b64url, sha256hex, codeChallenge, ts, tsIso, buildId, jwtPayload, jwtExp, isTokenExpired, extractChatgptAccountId } = require("./crypto-utils");
const { parseTsStr } = require("./time-utils");
const { httpJson, buildCodexHeaders, extractErrorCode, isTokenRevoked } = require("./http-client");
const { ensureDir, loadIdx, saveIdx, loadAcct, saveAcct, deleteAcct, listAccts, currentAcct } = require("./storage");
const { writeAuthJson, writeProjection, clearApiBaseUrl, killCodex, startCodex, doSwitch } = require("./switch");
const { oauthLoginFlow, upsert } = require("./oauth");
const { refreshOneTok, needsRefresh, refreshAll } = require("./token-refresh");
const { fetchQuota, refreshQuota, extractQuotaMetrics } = require("./quota");
const { fetchResetCredits, consumeResetCredit } = require("./reset-credits");
const { fetchSubscriptionStatus, refreshSubscription } = require("./subscription");
const { loadAutoSwitchCfg, saveAutoSwitchCfg, DEFAULT_AUTO_SWITCH_CFG } = require("./config-manager");
const { metricCrossedThreshold, buildSwitchCandidate, pickBestCandidate, resolveMonitoredIds, autoSwitchTick } = require("./auto-switch");
const { runDaemonWorker, getTickIntervalMs } = require("./daemon");

module.exports = {
  // crypto-utils
  b64url, sha256hex, codeChallenge, ts, tsIso, buildId, jwtPayload, jwtExp, isTokenExpired, extractChatgptAccountId,
  // time-utils
  parseTsStr,
  // http-client
  httpJson, buildCodexHeaders, extractErrorCode, isTokenRevoked,
  // storage
  ensureDir, loadIdx, saveIdx, loadAcct, saveAcct, deleteAcct, listAccts, currentAcct,
  // switch
  writeAuthJson, writeProjection, clearApiBaseUrl, killCodex, startCodex, doSwitch,
  // oauth
  oauthLoginFlow, upsert,
  // token-refresh
  refreshOneTok, needsRefresh, refreshAll,
  // quota
  fetchQuota, refreshQuota, extractQuotaMetrics,
  // reset-credits
  fetchResetCredits, consumeResetCredit,
  // subscription
  fetchSubscriptionStatus, refreshSubscription,
  // config-manager
  loadAutoSwitchCfg, saveAutoSwitchCfg, DEFAULT_AUTO_SWITCH_CFG,
  // auto-switch
  metricCrossedThreshold, buildSwitchCandidate, pickBestCandidate, resolveMonitoredIds, autoSwitchTick,
  // daemon
  runDaemonWorker, getTickIntervalMs,
};

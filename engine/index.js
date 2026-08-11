const { b64url, sha256hex, codeChallenge, ts, tsIso, buildId, jwtPayload, jwtExp, isTokenExpired, extractChatgptAccountId, extractChatgptOrganizationId } = require("./crypto-utils");
const { parseTsStr } = require("./time-utils");
const { httpJson, buildCodexHeaders, extractErrorCode } = require("./http-client");
const { setSecretCodec, protectData, unprotectData, ensureDir, normalizeAccountId, accountFilePath, loadIdx, saveIdx, loadAcct, saveAcct, deleteAcct, listAccts, currentAcct, getStorageDiagnostics, rebuildIndex } = require("./storage");
const { writeAuthJson, writeProjection, clearApiBaseUrl, killCodex, startCodex, doSwitch, launchOfficialCodex, setSwitchRuntimeForTests } = require("./switch");
const { oauthLoginFlow, restorePendingOAuth, cancelOAuth, completeOAuthManually, getOAuthStatus, upsert } = require("./oauth");
const { inspectAuthState, adoptOfficialAuth, reapplyManagedAuth, authFingerprint, identityMatchesAccount } = require("./auth-state");
const { initLogger, logInfo, logWarn, logError, getLogDir, sanitizeMessage } = require("./logger");
const { refreshOneTok, needsRefresh, refreshAll } = require("./token-refresh");
const { fetchQuota, fetchQuotaWithTokenRepair, isQuotaAuthError, refreshQuota, extractQuotaMetrics, normalizeQuota } = require("./quota");
const { loadAutoSwitchCfg, saveAutoSwitchCfg, DEFAULT_AUTO_SWITCH_CFG } = require("./config-manager");
const { withAccountLock, withAccountLocks } = require("./operation-locks");
const { metricCrossedThreshold, buildSwitchCandidate, pickBestCandidate, resolveMonitoredIds, autoSwitchTick } = require("./auto-switch");
const { runDaemonWorker, getTickIntervalMs, getTickIntervalMinutes } = require("./daemon");
const { getCodexInstallationStatus, assertOfficialCodexInstalled } = require("./codex-installation");

module.exports = {
  // crypto-utils
  b64url, sha256hex, codeChallenge, ts, tsIso, buildId, jwtPayload, jwtExp, isTokenExpired, extractChatgptAccountId, extractChatgptOrganizationId,
  // time-utils
  parseTsStr,
  // http-client
  httpJson, buildCodexHeaders, extractErrorCode,
  // storage
  setSecretCodec, protectData, unprotectData, ensureDir, normalizeAccountId, accountFilePath, loadIdx, saveIdx, loadAcct, saveAcct, deleteAcct, listAccts, currentAcct, getStorageDiagnostics, rebuildIndex,
  // switch
  writeAuthJson, writeProjection, clearApiBaseUrl, killCodex, startCodex, doSwitch, launchOfficialCodex, setSwitchRuntimeForTests,
  // oauth
  oauthLoginFlow, restorePendingOAuth, cancelOAuth, completeOAuthManually, getOAuthStatus, upsert,
  // auth state
  inspectAuthState, adoptOfficialAuth, reapplyManagedAuth, authFingerprint, identityMatchesAccount,
  // logger
  initLogger, logInfo, logWarn, logError, getLogDir, sanitizeMessage,
  // token-refresh
  refreshOneTok, needsRefresh, refreshAll,
  // quota
  fetchQuota, fetchQuotaWithTokenRepair, isQuotaAuthError, refreshQuota, extractQuotaMetrics, normalizeQuota,
  // config-manager
  loadAutoSwitchCfg, saveAutoSwitchCfg, DEFAULT_AUTO_SWITCH_CFG,
  // operation-locks
  withAccountLock, withAccountLocks,
  // auto-switch
  metricCrossedThreshold, buildSwitchCandidate, pickBestCandidate, resolveMonitoredIds, autoSwitchTick,
  // daemon
  runDaemonWorker, getTickIntervalMs, getTickIntervalMinutes,
  // codex installation
  getCodexInstallationStatus, assertOfficialCodexInstalled,
};

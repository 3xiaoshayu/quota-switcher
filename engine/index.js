const { b64url, sha256hex, codeChallenge, ts, tsIso, buildId, buildCursorId, jwtPayload, jwtExp, isTokenExpired, extractChatgptAccountId, extractChatgptOrganizationId, extractCursorWorkosUserId } = require("./crypto-utils");
const { parseTsStr } = require("./time-utils");
const { httpJson, buildCodexHeaders, extractErrorCode } = require("./http-client");
const { setSecretCodec, protectData, unprotectData, ensureDir, normalizeAccountId, accountFilePath, loadIdx, saveIdx, loadAcct, saveAcct, deleteAcct, listAccts, currentAcct, getStorageDiagnostics, rebuildIndex } = require("./storage");
const { writeAuthJson, writeProjection, clearApiBaseUrl, killCodex, startCodex, doSwitch, launchOfficialCodex, setSwitchRuntimeForTests } = require("./switch");
const { oauthLoginFlow, restorePendingOAuth, cancelOAuth, completeOAuthManually, getOAuthStatus, setOpenUrlHandler, upsert } = require("./oauth");
const { inspectAuthState, adoptOfficialAuth, reapplyManagedAuth, authFingerprint, identityMatchesAccount } = require("./auth-state");
const { initLogger, logInfo, logWarn, logError, getLogDir, sanitizeMessage } = require("./logger");
const { refreshOneTok, needsRefresh, refreshAll } = require("./token-refresh");
const { fetchQuota, fetchQuotaWithTokenRepair, isQuotaAuthError, refreshQuota, probeUsageOnly, canProbeUsageWithoutRefresh, needsBanProbe, extractQuotaMetrics, normalizeQuota } = require("./quota");
const { classifyProbe, isAccountBanned } = require("./account-probe");
const { loadAutoSwitchCfg, saveAutoSwitchCfg, DEFAULT_AUTO_SWITCH_CFG } = require("./config-manager");
const { withAccountLock, withAccountLocks } = require("./operation-locks");
const { metricCrossedThreshold, accountMustLeave, buildSwitchCandidate, pickBestCandidate, resolveMonitoredIds, autoSwitchTick } = require("./auto-switch");
const { runDaemonWorker, getTickIntervalMs, getTickIntervalMinutes } = require("./daemon");
const { getCodexInstallationStatus, getCodexInstallationStatusAsync, assertOfficialCodexInstalled, assertOfficialCodexInstalledAsync } = require("./codex-installation");
const { listCursorAccts, loadCursorAcct, saveCursorAcct, currentCursorAcct, deleteCursorAcct, loadCursorIdx } = require("./cursor-storage");
const { importLocalCursorAccount, upsertCursorAccount, accountFromCursorTokens, authFromLocalValues, syncCurrentCursorFromOfficial } = require("./cursor-local");
const { doCursorSwitch } = require("./cursor-switch");
const { refreshCursorQuota, parseCursorUsage, buildCursorUsageCookie } = require("./cursor-quota");
const { refreshCursorToken, refreshAllCursorTokens } = require("./cursor-token");
const { cursorLoginFlow, cancelCursorOAuth, discardPendingCursorOAuth, getCursorOAuthStatus, restorePendingCursorOAuth } = require("./cursor-oauth");
const { getCursorInstallationStatus, getCursorInstallationStatusAsync, assertOfficialCursorInstalled } = require("./cursor-install");
const { setCursorRuntimeForTests, setCursorOpenUrlHandler } = require("./cursor-runtime");
const { readCursorAuth, writeCursorAuth, hasPendingWal, waitForWalToClear } = require("./cursor-db");

module.exports = {
  // crypto-utils
  b64url, sha256hex, codeChallenge, ts, tsIso, buildId, buildCursorId, jwtPayload, jwtExp, isTokenExpired, extractChatgptAccountId, extractChatgptOrganizationId, extractCursorWorkosUserId,
  // time-utils
  parseTsStr,
  // http-client
  httpJson, buildCodexHeaders, extractErrorCode,
  // storage
  setSecretCodec, protectData, unprotectData, ensureDir, normalizeAccountId, accountFilePath, loadIdx, saveIdx, loadAcct, saveAcct, deleteAcct, listAccts, currentAcct, getStorageDiagnostics, rebuildIndex,
  // switch
  writeAuthJson, writeProjection, clearApiBaseUrl, killCodex, startCodex, doSwitch, launchOfficialCodex, setSwitchRuntimeForTests,
  // oauth
  oauthLoginFlow, restorePendingOAuth, cancelOAuth, completeOAuthManually, getOAuthStatus, setOpenUrlHandler, upsert,
  // auth state
  inspectAuthState, adoptOfficialAuth, reapplyManagedAuth, authFingerprint, identityMatchesAccount,
  // logger
  initLogger, logInfo, logWarn, logError, getLogDir, sanitizeMessage,
  // token-refresh
  refreshOneTok, needsRefresh, refreshAll,
  // quota
  fetchQuota, fetchQuotaWithTokenRepair, isQuotaAuthError, refreshQuota, probeUsageOnly, canProbeUsageWithoutRefresh, needsBanProbe, extractQuotaMetrics, normalizeQuota,
  classifyProbe, isAccountBanned,
  // config-manager
  loadAutoSwitchCfg, saveAutoSwitchCfg, DEFAULT_AUTO_SWITCH_CFG,
  // operation-locks
  withAccountLock, withAccountLocks,
  // auto-switch
  metricCrossedThreshold, accountMustLeave, buildSwitchCandidate, pickBestCandidate, resolveMonitoredIds, autoSwitchTick,
  // daemon
  runDaemonWorker, getTickIntervalMs, getTickIntervalMinutes,
  // codex installation
  getCodexInstallationStatus, getCodexInstallationStatusAsync, assertOfficialCodexInstalled, assertOfficialCodexInstalledAsync,
  listCursorAccts, loadCursorAcct, saveCursorAcct, currentCursorAcct, deleteCursorAcct, loadCursorIdx,
  importLocalCursorAccount, upsertCursorAccount, accountFromCursorTokens, authFromLocalValues, syncCurrentCursorFromOfficial,
  doCursorSwitch, refreshCursorQuota, parseCursorUsage, buildCursorUsageCookie, refreshCursorToken, refreshAllCursorTokens,
  cursorLoginFlow, cancelCursorOAuth, discardPendingCursorOAuth, getCursorOAuthStatus, restorePendingCursorOAuth,
  getCursorInstallationStatus, getCursorInstallationStatusAsync, assertOfficialCursorInstalled,
  setCursorRuntimeForTests, setCursorOpenUrlHandler, readCursorAuth, writeCursorAuth, hasPendingWal, waitForWalToClear,
};

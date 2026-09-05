const { b64url, sha256hex, codeChallenge, ts, tsIso, buildId, buildCursorId, buildAntigravityId, jwtPayload, jwtExp, isExpiryStale, isTokenExpired, extractChatgptAccountId, extractChatgptOrganizationId, extractCursorWorkosUserId } = require("./crypto-utils");
const { parseTsStr } = require("./time-utils");
const { httpJson, buildCodexHeaders, extractErrorCode, setHttpJsonTransport } = require("./http-client");
const { setSecretCodec, protectData, unprotectData, ensureDir, normalizeAccountId, accountFilePath, loadIdx, saveIdx, withIndexLock, loadAcct, saveAcct, deleteAcct, listAccts, currentAcct, getStorageDiagnostics, rebuildIndex, flushPendingAccountRewrites, resetPendingAccountRewritesForTests } = require("./storage");
const { writeAuthJson, writeProjection, clearApiBaseUrl, killCodex, startCodex, doSwitch, launchOfficialCodex, setSwitchRuntimeForTests } = require("./switch");
const { oauthLoginFlow, restorePendingOAuth, cancelOAuth, completeOAuthManually, getOAuthStatus, setOpenUrlHandler, setOAuthAccountSavedHandler, upsert, sameAccountIdentity, collapseDuplicateCodexAccounts } = require("./oauth");
const { inspectAuthState, isInspectBusyError, busyAuthState, canMirrorOfficialAuth, adoptOfficialAuth, reapplyManagedAuth, authFingerprint, identityMatchesAccount } = require("./auth-state");
const { initLogger, logInfo, logWarn, logError, getLogDir, sanitizeMessage } = require("./logger");
const { refreshOneTok, needsRefresh, refreshAll } = require("./token-refresh");
const { fetchQuota, fetchQuotaWithTokenRepair, isQuotaAuthError, refreshQuota, probeUsageOnly, canProbeUsageWithoutRefresh, needsBanProbe, extractQuotaMetrics, normalizeQuota } = require("./quota");
const { classifyProbe, isAccountBanned } = require("./account-probe");
const { loadDaemonCfg, saveDaemonCfg, normalizeDaemonCfg, DEFAULT_DAEMON_CFG } = require("./config-manager");
const { withAccountLock, withAccountLocks, withPathLock, mapLimit } = require("./operation-locks");
const { runDaemonWorker, getTickIntervalMs, getTickIntervalMinutes, resolutionHoldReason } = require("./daemon");
const { getCodexInstallationStatus, getCodexInstallationStatusAsync, assertOfficialCodexInstalled, assertOfficialCodexInstalledAsync } = require("./codex-installation");
const { listCursorAccts, loadCursorAcct, saveCursorAcct, currentCursorAcct, deleteCursorAcct, loadCursorIdx, setCurrentCursorAccountId } = require("./cursor-storage");
const { importLocalCursorAccount, upsertCursorAccount, accountFromCursorTokens, authFromLocalValues, syncCurrentCursorFromOfficial, collapseDuplicateCursorAccounts, resetOfficialSyncCacheForTests: resetCursorOfficialSyncCacheForTests } = require("./cursor-local");
const { doCursorSwitch } = require("./cursor-switch");
const { refreshCursorQuota, parseCursorUsage, buildCursorUsageCookie } = require("./cursor-quota");
const { refreshCursorToken, refreshAllCursorTokens } = require("./cursor-token");
const { cursorLoginFlow, cancelCursorOAuth, discardPendingCursorOAuth, getCursorOAuthStatus, restorePendingCursorOAuth } = require("./cursor-oauth");
const { getCursorInstallationStatus, getCursorInstallationStatusAsync, assertOfficialCursorInstalled } = require("./cursor-install");
const { setCursorRuntimeForTests, setCursorOpenUrlHandler } = require("./cursor-runtime");
const { readCursorAuth, writeCursorAuth, hasPendingWal, waitForWalToClear } = require("./cursor-db");
const { setSqliteNativeTimingForTests, setSqliteReadTransport } = require("./sqlite-native");
const { listAntigravityAccts, loadAntigravityAcct, saveAntigravityAcct, currentAntigravityAcct, deleteAntigravityAcct, loadAntigravityIdx, setCurrentAntigravityAccountId } = require("./antigravity-storage");
const { importLocalAntigravityAccount, upsertAntigravityAccount, accountFromAntigravityTokens, syncCurrentAntigravityFromOfficial, collapseDuplicateAntigravityAccounts, resetOfficialSyncCacheForTests: resetAntigravityOfficialSyncCacheForTests } = require("./antigravity-local");
const { doAntigravitySwitch } = require("./antigravity-switch");
const { refreshAntigravityQuota, parseAntigravityUsage } = require("./antigravity-quota");
const { refreshAntigravityToken, refreshAllAntigravityTokens } = require("./antigravity-token");
const { antigravityLoginFlow, cancelAntigravityOAuth, discardPendingAntigravityOAuth, getAntigravityOAuthStatus, restorePendingAntigravityOAuth } = require("./antigravity-oauth");
const { getAntigravityInstallationStatus, getAntigravityInstallationStatusAsync, assertOfficialAntigravityInstalled } = require("./antigravity-install");
const { setAntigravityRuntimeForTests, setAntigravityOpenUrlHandler } = require("./antigravity-runtime");
const { readAntigravityAuth, writeAntigravityAuth } = require("./antigravity-db");
const { inspectCodexFormat, inspectCursorFormat, inspectAntigravityFormat } = require("./upstream-drift");

module.exports = {
  // crypto-utils
  b64url, sha256hex, codeChallenge, ts, tsIso, buildId, buildCursorId, buildAntigravityId, jwtPayload, jwtExp, isExpiryStale, isTokenExpired, extractChatgptAccountId, extractChatgptOrganizationId, extractCursorWorkosUserId,
  // time-utils
  parseTsStr,
  // http-client
  httpJson, buildCodexHeaders, extractErrorCode, setHttpJsonTransport,
  // storage
  setSecretCodec, protectData, unprotectData, ensureDir, normalizeAccountId, accountFilePath, loadIdx, saveIdx, withIndexLock, loadAcct, saveAcct, deleteAcct, listAccts, currentAcct, getStorageDiagnostics, rebuildIndex, flushPendingAccountRewrites, resetPendingAccountRewritesForTests,
  // switch
  writeAuthJson, writeProjection, clearApiBaseUrl, killCodex, startCodex, doSwitch, launchOfficialCodex, setSwitchRuntimeForTests,
  // oauth
  oauthLoginFlow, restorePendingOAuth, cancelOAuth, completeOAuthManually, getOAuthStatus, setOpenUrlHandler, setOAuthAccountSavedHandler, upsert, sameAccountIdentity, collapseDuplicateCodexAccounts,
  // auth state
  inspectAuthState, isInspectBusyError, busyAuthState, canMirrorOfficialAuth, adoptOfficialAuth, reapplyManagedAuth, authFingerprint, identityMatchesAccount,
  // logger
  initLogger, logInfo, logWarn, logError, getLogDir, sanitizeMessage,
  // token-refresh
  refreshOneTok, needsRefresh, refreshAll,
  // quota
  fetchQuota, fetchQuotaWithTokenRepair, isQuotaAuthError, refreshQuota, probeUsageOnly, canProbeUsageWithoutRefresh, needsBanProbe, extractQuotaMetrics, normalizeQuota,
  classifyProbe, isAccountBanned,
  // config-manager
  loadDaemonCfg, saveDaemonCfg, normalizeDaemonCfg, DEFAULT_DAEMON_CFG,
  // operation-locks
  withAccountLock, withAccountLocks, withPathLock, mapLimit,
  // daemon
  runDaemonWorker, getTickIntervalMs, getTickIntervalMinutes, resolutionHoldReason,
  // codex installation
  getCodexInstallationStatus, getCodexInstallationStatusAsync, assertOfficialCodexInstalled, assertOfficialCodexInstalledAsync,
  listCursorAccts, loadCursorAcct, saveCursorAcct, currentCursorAcct, deleteCursorAcct, loadCursorIdx, setCurrentCursorAccountId,
  importLocalCursorAccount, upsertCursorAccount, accountFromCursorTokens, authFromLocalValues, syncCurrentCursorFromOfficial, collapseDuplicateCursorAccounts, resetCursorOfficialSyncCacheForTests,
  doCursorSwitch, refreshCursorQuota, parseCursorUsage, buildCursorUsageCookie, refreshCursorToken, refreshAllCursorTokens,
  cursorLoginFlow, cancelCursorOAuth, discardPendingCursorOAuth, getCursorOAuthStatus, restorePendingCursorOAuth,
  getCursorInstallationStatus, getCursorInstallationStatusAsync, assertOfficialCursorInstalled,
  setCursorRuntimeForTests, setCursorOpenUrlHandler, readCursorAuth, writeCursorAuth, hasPendingWal, waitForWalToClear,
  setSqliteNativeTimingForTests, setSqliteReadTransport,
  listAntigravityAccts, loadAntigravityAcct, saveAntigravityAcct, currentAntigravityAcct, deleteAntigravityAcct, loadAntigravityIdx, setCurrentAntigravityAccountId,
  importLocalAntigravityAccount, upsertAntigravityAccount, accountFromAntigravityTokens, syncCurrentAntigravityFromOfficial, collapseDuplicateAntigravityAccounts, resetAntigravityOfficialSyncCacheForTests,
  doAntigravitySwitch, refreshAntigravityQuota, parseAntigravityUsage, refreshAntigravityToken, refreshAllAntigravityTokens,
  antigravityLoginFlow, cancelAntigravityOAuth, discardPendingAntigravityOAuth, getAntigravityOAuthStatus, restorePendingAntigravityOAuth,
  getAntigravityInstallationStatus, getAntigravityInstallationStatusAsync, assertOfficialAntigravityInstalled,
  setAntigravityRuntimeForTests, setAntigravityOpenUrlHandler, readAntigravityAuth, writeAntigravityAuth,
  // upstream-drift: does the official on-disk login format still look like what we know?
  inspectCodexFormat, inspectCursorFormat, inspectAntigravityFormat,
};

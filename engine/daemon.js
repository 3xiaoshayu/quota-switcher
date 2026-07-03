const { REFRESH_MINUTES } = require("./config");
const { needsRefresh, refreshOneTok } = require("./token-refresh");
const { refreshQuota } = require("./quota");
const { fetchResetCredits } = require("./reset-credits");
const { loadAutoSwitchCfg, normalizeSyncIntervalMinutes } = require("./config-manager");
const { autoSwitchTick } = require("./auto-switch");
const { loadIdx, listAccts, saveAcct, loadAcct } = require("./storage");
const { writeAuthJson, writeProjection } = require("./switch");
const { inspectAuthState } = require("./auth-state");
const { withAccountLock } = require("./operation-locks");
const { logWarn } = require("./logger");

function failure(stage, account, error) {
  return {
    stage,
    accountId: account?.id || null,
    email: account?.email || null,
    code: error?.code || null,
    message: error?.message || String(error),
  };
}

async function runDaemonWorker(options = {}) {
  const startedAt = Date.now();
  const failures = [];
  const tokenRefreshes = [];
  let accountsUpdated = 0;
  let autoSwitchResult = null;
  let authState = null;
  const isCancelled = typeof options.isCancelled === "function" ? options.isCancelled : () => false;
  const stopped = () => ({
    startedAt,
    completedAt: Date.now(),
    accountsUpdated,
    tokenRefreshes,
    autoSwitchResult,
    failures,
    pausedReason: "stopped",
    authState,
  });

  if (isCancelled()) return stopped();
  authState = inspectAuthState();
  if (authState.requiresResolution) {
    return {
      startedAt,
      completedAt: Date.now(),
      accountsUpdated,
      tokenRefreshes,
      autoSwitchResult,
      failures,
      pausedReason: "auth_conflict",
      authState,
    };
  }

  const accounts = listAccts();
  for (const listed of accounts) {
    if (isCancelled()) return stopped();
    try {
      await withAccountLock(listed.id, async () => {
        if (isCancelled()) return;
        const account = loadAcct(listed.id);
        if (!account || !needsRefresh(account)) return;
        if (isCancelled()) return;
        const result = await refreshOneTok(account);
        if (isCancelled()) return;
        tokenRefreshes.push({
          accountId: account.id,
          email: account.email,
          ok: result.ok,
          revoked: result.revoked,
          gen: result.gen,
          error: result.error || null,
        });
        if (result.ok) accountsUpdated++;
        else failures.push(failure("token_refresh", account, new Error(result.error || "Token refresh failed")));
      });
    } catch (error) {
      failures.push(failure("token_refresh", listed, error));
    }
    if (isCancelled()) return stopped();
  }

  if (isCancelled()) return stopped();
  const index = loadIdx();
  if (index.current_account_id) {
    await withAccountLock(index.current_account_id, async () => {
      if (isCancelled()) return;
      const current = loadAcct(index.current_account_id);
      if (!current) {
        failures.push(failure("current_account", null, new Error("Managed current account could not be read")));
        return;
      }

      try {
        if (isCancelled()) return;
        await refreshQuota(current, { force: false });
        accountsUpdated++;
      } catch (error) {
        failures.push(failure("quota_refresh", current, error));
      }

      try {
        if (isCancelled()) return;
        const snapshot = await fetchResetCredits(current);
        if (isCancelled()) return;
        current.reset_credits = snapshot;
        current.reset_credits_error = null;
        saveAcct(current);
        accountsUpdated++;
      } catch (error) {
        current.reset_credits_error = { message: error.message || String(error), timestamp: Math.floor(Date.now() / 1000) };
        saveAcct(current);
        failures.push(failure("reset_credits", current, error));
      }

      if (isCancelled()) return;
      const latestIndex = loadIdx();
      const latestAuthState = inspectAuthState();
      if (latestIndex.current_account_id === current.id && !latestAuthState.requiresResolution) {
        try {
          if (isCancelled()) return;
          const authValue = writeAuthJson(current);
          if (isCancelled()) return;
          writeProjection(current, authValue);
        } catch (error) {
          failures.push(failure("auth_projection", current, error));
        }
      }
    });
  }

  if (isCancelled()) return stopped();
  const config = loadAutoSwitchCfg();
  if (config.enabled) {
    try {
      autoSwitchResult = await autoSwitchTick(config, { isCancelled });
      if (isCancelled() || autoSwitchResult?.reason === "cancelled") return stopped();
      if (autoSwitchResult?.reason === "current_quota_refresh_failed") {
        failures.push(failure("auto_switch", null, new Error(autoSwitchResult.error || autoSwitchResult.reason)));
      }
    } catch (error) {
      failures.push(failure("auto_switch", null, error));
    }
  }

  if (failures.length > 0) {
    logWarn(`Daemon worker completed with ${failures.length} failure(s)`);
  }
  return {
    startedAt,
    completedAt: Date.now(),
    accountsUpdated,
    tokenRefreshes,
    autoSwitchResult,
    failures,
    pausedReason: null,
    authState,
  };
}

function getTickIntervalMinutes() {
  try {
    return normalizeSyncIntervalMinutes(loadAutoSwitchCfg().sync_interval_minutes);
  } catch {
    return REFRESH_MINUTES;
  }
}

function getTickIntervalMs() {
  return getTickIntervalMinutes() * 60000;
}

module.exports = { runDaemonWorker, getTickIntervalMs, getTickIntervalMinutes };

const { REFRESH_MINUTES } = require("./config");
const tokenRefresh = require("./token-refresh");
const { refreshQuota, probeUsageOnly, needsBanProbe } = require("./quota");
const { loadAutoSwitchCfg, normalizeSyncIntervalMinutes } = require("./config-manager");
const { autoSwitchTick } = require("./auto-switch");
const { loadIdx, listAccts, loadAcct } = require("./storage");
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
  // inspectAuthState can write the current account file (official token
  // rotation sync); hold the account lock so it cannot interleave with an
  // in-flight refresh of the same account.
  const preIndex = loadIdx();
  try {
    authState = preIndex.current_account_id
      ? await withAccountLock(preIndex.current_account_id, async () => inspectAuthState({ migrateProjection: false }))
      : inspectAuthState({ migrateProjection: false });
  } catch (error) {
    failures.push(failure("auth_inspect", null, error));
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

  const accounts = listAccts({ secrets: false });
  for (const listed of accounts) {
    if (isCancelled()) return stopped();
    try {
      await withAccountLock(listed.id, async () => {
        if (isCancelled()) return;
        if (listed.banned) return;
        if (listed.requires_reauth && listed.has_refresh === false) return;
        if (!tokenRefresh.listedNeedsTokenRefresh(listed)) return;
        const account = loadAcct(listed.id);
        if (!account || account.banned || !tokenRefresh.needsRefresh(account)) return;
        if (isCancelled()) return;
        const result = await tokenRefresh.refreshOneTok(account);
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
        else if (result.reauthRequired) return;
        else failures.push(failure("token_refresh", account, new Error(result.error || "Token refresh failed")));
      });
    } catch (error) {
      failures.push(failure("token_refresh", listed, error));
    }
    if (isCancelled()) return stopped();
  }

  for (const listed of accounts) {
    if (isCancelled()) return stopped();
    try {
      await withAccountLock(listed.id, async () => {
        if (isCancelled()) return;
        if (!listed.requires_reauth && !listed.banned) return;
        if (listed.has_access === false) return;
        const account = loadAcct(listed.id);
        if (!account || !needsBanProbe(account)) return;
        try {
          await probeUsageOnly(account, { force: false });
          accountsUpdated++;
        } catch (error) {
          if (error?.code === "quota_retry_pending") return;
          const probeStatus = error?.probe?.status || account.probe?.status;
          if (
            error?.code === "usage_limited"
            || error?.code === "reauthorization_required"
            || error?.code === "account_banned"
            || probeStatus === "usage_limited"
            || probeStatus === "banned"
            || account.banned
          ) return;
          failures.push(failure("ban_probe", account, error));
        }
      });
    } catch (error) {
      failures.push(failure("ban_probe", listed, error));
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
      // Reauthorization is an explicit user action: refreshing quotas here
      // would only fail and overwrite the reauth marker's quota_error code.
      if (current.requires_reauth || current.banned) return;

      try {
        if (isCancelled()) return;
        await refreshQuota(current, { force: false });
        accountsUpdated++;
      } catch (error) {
        // Waiting out a retry backoff is expected throttling, not a failure.
        if (error?.code !== "quota_retry_pending") {
          failures.push(failure("quota_refresh", current, error));
        }
      }

      if (isCancelled()) return;
      const latestIndex = loadIdx();
      const latestAuthState = inspectAuthState({ migrateProjection: false });
      if (latestIndex.current_account_id === current.id && latestAuthState.status === "aligned") {
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
      autoSwitchResult = await autoSwitchTick(config, { isCancelled, authState });
      if (isCancelled() || autoSwitchResult?.reason === "cancelled") return stopped();
      if (autoSwitchResult?.reason === "current_quota_refresh_failed") {
        const retrying = /waiting for retry|quota_retry_pending/i.test(String(autoSwitchResult.error || ""));
        if (!retrying) {
          failures.push(failure("auto_switch", null, new Error(autoSwitchResult.error || autoSwitchResult.reason)));
        }
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

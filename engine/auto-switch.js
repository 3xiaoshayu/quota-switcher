const { ts } = require("./crypto-utils");
const { extractQuotaMetrics } = require("./quota");

function metricCrossedThreshold(metric, primaryTh, secondaryTh) {
  if (metric.key === "primary_window") return metric.percentage < primaryTh;
  if (metric.key === "secondary_window") return metric.percentage < secondaryTh;
  return false;
}

function accountMustLeave(acct) {
  return !!acct?.banned || !!acct?.requires_reauth || acct?.probe?.status === "usage_limited" || acct?.has_access === false;
}

const RECENT_SWITCH_MS = 45 * 1000;
let lastOfficialSwitchAt = 0;

function noteOfficialSwitch() {
  lastOfficialSwitchAt = Date.now();
}

function recentlySwitched(now = Date.now()) {
  return lastOfficialSwitchAt > 0 && (now - lastOfficialSwitchAt) < RECENT_SWITCH_MS;
}

function resolutionHoldReason(authState) {
  if (!authState?.requiresResolution) return null;
  if (authState.status === "missing_official_auth") return "missing_official_auth";
  if (authState.status === "unsupported_official_auth") return "unsupported_official_auth";
  if (authState.status === "unmanaged_official_auth") return "unmanaged_official_auth";
  return "auth_conflict";
}

function accountCannotReceiveSwitch(acct) {
  if (accountMustLeave(acct) || acct?.has_access === false) return true;
  if (acct?.tokens && !acct.tokens.access_token) return true;
  return false;
}

function buildSwitchCandidate(acct, primaryTh, secondaryTh) {
  if (accountCannotReceiveSwitch(acct) || acct.quota_error) return null;
  const metrics = extractQuotaMetrics(acct);
  if (metrics.length === 0) return null;
  const allAbove = metrics.every((m) => {
    if (m.key === "primary_window") return m.percentage > primaryTh;
    if (m.key === "secondary_window") return m.percentage > secondaryTh;
    return true;
  });
  if (!allAbove) return null;

  const margins = metrics.map((m) => {
    if (m.key === "primary_window") return m.percentage - primaryTh;
    if (m.key === "secondary_window") return m.percentage - secondaryTh;
    return Infinity;
  });
  const minMargin = Math.min(...margins);
  const minPct = Math.min(...metrics.map((m) => m.percentage));
  const avgPct = metrics.reduce((a, m) => a + m.percentage, 0) / metrics.length;
  return { account: acct, minMargin, minPercentage: minPct, averagePercentage: avgPct };
}

function pickBestCandidate(candidates) {
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (b.minMargin !== a.minMargin) return b.minMargin - a.minMargin;
    if (b.minPercentage !== a.minPercentage) return b.minPercentage - a.minPercentage;
    return b.averagePercentage - a.averagePercentage;
  });
  return candidates[0].account;
}

function resolveMonitoredIds(cfg, accts) {
  if (cfg.account_scope_mode !== "selected") return accts.map((a) => a.id);
  const selected = cfg.selected_account_ids || [];
  if (selected.length === 0) return [];
  const existing = new Set(accts.map((a) => a.id));
  return selected.filter((id) => existing.has(id));
}

async function autoSwitchTick(cfg, options = {}) {
  const { listAccts, loadIdx, loadAcct } = require("./storage");
  const { refreshQuota } = require("./quota");
  const { doSwitch } = require("./switch");
  const { withAccountLock, withAccountLocks } = require("./operation-locks");
  const { inspectAuthState, isInspectBusyError, busyAuthState } = require("./auth-state");
  const inspectAuthSafe = (fallback, accountId) => {
    try {
      return inspectAuthState({ migrateProjection: false });
    } catch (error) {
      if (isInspectBusyError(error)) return busyAuthState(accountId);
      return fallback || null;
    }
  };
  const isCancelled = typeof options.isCancelled === "function" ? options.isCancelled : () => false;
  let authState = options.authState || null;
  const cancelled = () => ({ switched: false, reason: "cancelled", authState });

  if (isCancelled()) return cancelled();
  // inspectAuthState can write the current account file (official token
  // rotation sync), so hold the account lock while it runs.
  if (!authState) {
    try {
      const preIdx = loadIdx();
      authState = preIdx.current_account_id
        ? await withAccountLock(preIdx.current_account_id, async () => inspectAuthState({ migrateProjection: false }))
        : inspectAuthState({ migrateProjection: false });
    } catch (error) {
      // A leftover lock on official auth.json is not a login conflict.
      // Reuse the existing check-failed reason so the UI does not treat this
      // as "官方登录不一致" and does not invent a new copy string.
      return {
        switched: false,
        reason: "current_quota_refresh_failed",
        error: isInspectBusyError(error)
          ? "Read authentication state timed out"
          : (error.message || String(error)),
        authState,
      };
    }
  }
  const holdReason = resolutionHoldReason(authState);
  if (holdReason) {
    return { switched: false, reason: holdReason, authState };
  }
  if (require("./oauth").getOAuthStatus()?.pending) {
    return { switched: false, reason: "oauth_pending", authState };
  }

  if (isCancelled()) return cancelled();
  const accts = listAccts({ secrets: false });
  if (accts.length === 0) return { switched: false, reason: "no_accounts", authState };

  const monitoredIds = resolveMonitoredIds(cfg, accts);
  if (monitoredIds.length === 0) return { switched: false, reason: "no_monitored", authState };

  const idx = loadIdx();
  const curId = idx.current_account_id;
  if (!curId) return { switched: false, reason: "current_not_found", authState };

  let cur = accts.find((a) => a.id === curId);
  if (!cur) return { switched: false, reason: "current_not_found", authState };
  if (recentlySwitched()) {
    return { switched: false, reason: "recently_switched", authState };
  }
  const mustLeave = accountMustLeave(cur);
  if (!mustLeave && !monitoredIds.includes(curId)) return { switched: false, reason: "current_not_monitored", authState };

  if (isCancelled()) return cancelled();
  // The daemon refreshes the current account right before this tick runs;
  // only request usage again when the cached quota is missing or stale, so
  // each tick does not hit the endpoint twice for the same account.
  const quotaIsFresh = (account) => !!account?.quota
    && !account.quota_error
    && !accountMustLeave(account)
    && (ts() - (account.usage_updated_at || 0) <= 600);
  if (!mustLeave && !quotaIsFresh(cur)) {
    let fresh = null;
    try {
      await withAccountLock(cur.id, async () => {
        if (isCancelled()) return;
        fresh = loadAcct(cur.id);
        if (!fresh) { cur = null; return; }
        if (isCancelled()) return;
        await refreshQuota(fresh, { force: false });
        if (isCancelled()) return;
        cur = fresh;
      });
    } catch (error) {
      // A failed refresh (e.g. retry backoff) with fresh-enough cached data
      // should not stall automatic switching for the whole backoff window.
      const cached = fresh || loadAcct(curId);
      if (accountMustLeave(cached)) {
        cur = cached;
      } else if (quotaIsFresh(cached) || (error?.code === "quota_retry_pending" && cached)) {
        cur = cached;
      } else {
        return {
          switched: false,
          reason: "current_quota_refresh_failed",
          error: error.message || String(error),
          authState,
        };
      }
    }
  }
  if (isCancelled()) return cancelled();
  if (!cur) return { switched: false, reason: "current_not_found", authState };
  const leaveCurrent = accountMustLeave(cur);
  const metrics = extractQuotaMetrics(cur);
  const primaryTh = cfg.primary_threshold, secondaryTh = cfg.secondary_threshold;
  const shouldSwitch = leaveCurrent || metrics.some((m) => metricCrossedThreshold(m, primaryTh, secondaryTh));
  if (!leaveCurrent && metrics.length === 0) return { switched: false, reason: "no_quota_data", authState };
  if (!shouldSwitch) return { switched: false, reason: "quota_sufficient", metrics, authState };

  const candidates = [];
  for (const listed of accts) {
    if (isCancelled()) return cancelled();
    if (listed.id === curId) continue;
    if (!monitoredIds.includes(listed.id)) continue;
    if (accountCannotReceiveSwitch(listed)) continue;
    let candidate = listed;
    if (!listed.quota || listed.quota_error || (ts() - (listed.usage_updated_at || 0) > 600)) {
      try {
        await withAccountLock(listed.id, async () => {
          if (isCancelled()) return;
          const fresh = loadAcct(listed.id);
          if (!fresh) { candidate = null; return; }
          if (isCancelled()) return;
          await refreshQuota(fresh, { force: false });
          if (isCancelled()) return;
          candidate = fresh;
        });
      } catch { continue; }
    }
    if (isCancelled()) return cancelled();
    if (!candidate) continue;
    if (accountCannotReceiveSwitch(candidate) || candidate.quota_error) continue;
    const cand = buildSwitchCandidate(candidate, primaryTh, secondaryTh);
    if (cand) candidates.push(cand);
  }

  if (candidates.length === 0) return { switched: false, reason: "no_candidates", metrics, authState };

  const best = pickBestCandidate(candidates);
  if (!best) return { switched: false, reason: "no_best_candidate", authState };

  if (isCancelled()) return cancelled();
  // Manual "check now" still inspects quota, but the global switch is the
  // only permission to actually change the official account.
  if (!cfg.enabled) {
    return { switched: false, reason: "disabled", metrics, authState };
  }

  return withAccountLocks(["__switch__", curId, best.id], async () => {
    if (isCancelled()) return cancelled();
    const latestIdx = loadIdx();
    if (latestIdx.current_account_id !== curId) {
      return { switched: false, reason: "current_changed", metrics, authState: inspectAuthSafe(authState, curId) };
    }
    const freshBest = loadAcct(best.id);
    const freshCur = loadAcct(curId) || cur;
    if (!freshBest || accountCannotReceiveSwitch(freshBest)) {
      return { switched: false, reason: "candidate_not_found", metrics, authState: inspectAuthSafe(authState, curId) };
    }
    if (isCancelled()) return cancelled();
    let latestAuth;
    try {
      latestAuth = inspectAuthState({ migrateProjection: false });
    } catch (error) {
      if (isInspectBusyError(error)) {
        return {
          switched: false,
          reason: "current_quota_refresh_failed",
          error: "Read authentication state timed out",
          metrics,
          authState: authState || busyAuthState(curId),
        };
      }
      throw error;
    }
    if (require("./oauth").getOAuthStatus()?.pending) {
      return { switched: false, reason: "oauth_pending", authState: latestAuth, metrics };
    }
    const latestHold = resolutionHoldReason(latestAuth);
    if (latestHold) {
      return { switched: false, reason: latestHold, authState: latestAuth, metrics };
    }
    try {
      const result = await doSwitch(freshBest);
      return { switched: true, from: freshCur, to: result.account, metrics, authState: result.authState || null };
    } catch (error) {
      if (error?.code === "codex_switch_verify_failed") {
        return {
          switched: false,
          reason: "switch_verify_failed",
          error: error.message,
          metrics,
          authState: inspectAuthSafe(latestAuth, curId),
        };
      }
      throw error;
    }
  });
}

module.exports = {
  metricCrossedThreshold, accountMustLeave, buildSwitchCandidate, pickBestCandidate,
  resolveMonitoredIds, autoSwitchTick, noteOfficialSwitch, recentlySwitched, resolutionHoldReason,
};

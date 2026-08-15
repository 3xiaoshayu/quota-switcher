const { ts } = require("./crypto-utils");
const { extractQuotaMetrics } = require("./quota");

function metricCrossedThreshold(metric, primaryTh, secondaryTh) {
  if (metric.key === "primary_window") return metric.percentage <= primaryTh;
  if (metric.key === "secondary_window") return metric.percentage <= secondaryTh;
  return false;
}

function accountMustLeave(acct) {
  return !!acct?.banned || !!acct?.requires_reauth || acct?.probe?.status === "usage_limited";
}

function buildSwitchCandidate(acct, primaryTh, secondaryTh) {
  if (accountMustLeave(acct) || acct.quota_error) return null;
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
  const { inspectAuthState } = require("./auth-state");
  const isCancelled = typeof options.isCancelled === "function" ? options.isCancelled : () => false;

  const cancelled = () => ({ switched: false, reason: "cancelled" });

  if (isCancelled()) return cancelled();
  // inspectAuthState can write the current account file (official token
  // rotation sync), so hold the account lock while it runs.
  const preIdx = loadIdx();
  const authState = preIdx.current_account_id
    ? await withAccountLock(preIdx.current_account_id, async () => inspectAuthState())
    : inspectAuthState();
  if (authState.requiresResolution) {
    return { switched: false, reason: "auth_conflict", authState };
  }

  if (isCancelled()) return cancelled();
  const accts = listAccts();
  if (accts.length === 0) return { switched: false, reason: "no_accounts" };

  const monitoredIds = resolveMonitoredIds(cfg, accts);
  if (monitoredIds.length === 0) return { switched: false, reason: "no_monitored" };

  const idx = loadIdx();
  const curId = idx.current_account_id;
  if (!curId) return { switched: false, reason: "current_not_found" };

  let cur = accts.find((a) => a.id === curId);
  if (!cur) return { switched: false, reason: "current_not_found" };
  const mustLeave = accountMustLeave(cur);
  if (!mustLeave && !monitoredIds.includes(curId)) return { switched: false, reason: "current_not_monitored" };

  if (isCancelled()) return cancelled();
  // The daemon refreshes the current account right before this tick runs;
  // only request usage again when the cached quota is missing or stale, so
  // each tick does not hit the endpoint twice for the same account.
  const quotaIsFresh = (account) => !!account?.quota
    && !account.quota_error
    && !accountMustLeave(account)
    && (ts() - (account.usage_updated_at || 0) <= 600);
  if (!mustLeave && !quotaIsFresh(cur)) {
    try {
      await withAccountLock(cur.id, async () => {
        if (isCancelled()) return;
        const fresh = loadAcct(cur.id);
        if (!fresh) { cur = null; return; }
        if (isCancelled()) return;
        await refreshQuota(fresh, { force: false });
        if (isCancelled()) return;
        cur = loadAcct(fresh.id) || fresh;
      });
    } catch (error) {
      // A failed refresh (e.g. retry backoff) with fresh-enough cached data
      // should not stall automatic switching for the whole backoff window.
      const cached = loadAcct(curId);
      if (accountMustLeave(cached)) {
        cur = cached;
      } else if (quotaIsFresh(cached)) {
        cur = cached;
      } else {
        return {
          switched: false,
          reason: "current_quota_refresh_failed",
          error: error.message || String(error),
        };
      }
    }
  }
  if (isCancelled()) return cancelled();
  if (!cur) return { switched: false, reason: "current_not_found" };
  const leaveCurrent = accountMustLeave(cur);
  const metrics = extractQuotaMetrics(cur);
  const primaryTh = cfg.primary_threshold, secondaryTh = cfg.secondary_threshold;
  const shouldSwitch = leaveCurrent || metrics.some((m) => metricCrossedThreshold(m, primaryTh, secondaryTh));
  if (!leaveCurrent && metrics.length === 0) return { switched: false, reason: "no_quota_data" };
  if (!shouldSwitch) return { switched: false, reason: "quota_sufficient", metrics };

  const candidates = [];
  for (const listed of accts) {
    if (isCancelled()) return cancelled();
    if (listed.id === curId) continue;
    if (!monitoredIds.includes(listed.id)) continue;
    let candidate = loadAcct(listed.id) || listed;
    if (accountMustLeave(candidate)) continue;
    if (!candidate.quota || candidate.quota_error || (ts() - (candidate.usage_updated_at || 0) > 600)) {
      try {
        await withAccountLock(candidate.id, async () => {
          if (isCancelled()) return;
          const fresh = loadAcct(candidate.id);
          if (!fresh) { candidate = null; return; }
          if (isCancelled()) return;
          await refreshQuota(fresh, { force: false });
          if (isCancelled()) return;
          candidate = loadAcct(fresh.id) || fresh;
        });
      } catch { continue; }
    }
    if (isCancelled()) return cancelled();
    if (!candidate) continue;
    if (accountMustLeave(candidate) || candidate.quota_error) continue;
    const cand = buildSwitchCandidate(candidate, primaryTh, secondaryTh);
    if (cand) candidates.push(cand);
  }

  if (candidates.length === 0) return { switched: false, reason: "no_candidates", metrics };

  const best = pickBestCandidate(candidates);
  if (!best) return { switched: false, reason: "no_best_candidate" };

  if (isCancelled()) return cancelled();
  // Manual "check now" still inspects quota, but the global switch is the
  // only permission to actually change the official account.
  if (!cfg.enabled) {
    return { switched: false, reason: "disabled", metrics };
  }

  return withAccountLocks(["__switch__", curId, best.id], async () => {
    if (isCancelled()) return cancelled();
    const latestIdx = loadIdx();
    if (latestIdx.current_account_id !== curId) {
      return { switched: false, reason: "current_changed", metrics };
    }
    const freshBest = loadAcct(best.id);
    const freshCur = loadAcct(curId) || cur;
    if (!freshBest) return { switched: false, reason: "candidate_not_found", metrics };
    if (isCancelled()) return cancelled();
    const result = await doSwitch(freshBest);
    return { switched: true, from: freshCur, to: result.account, metrics };
  });
}

module.exports = {
  metricCrossedThreshold, accountMustLeave, buildSwitchCandidate, pickBestCandidate,
  resolveMonitoredIds, autoSwitchTick,
};

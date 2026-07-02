const { ts } = require("./crypto-utils");
const { extractQuotaMetrics } = require("./quota");

function metricCrossedThreshold(metric, primaryTh, secondaryTh) {
  if (metric.key === "primary_window") return metric.percentage <= primaryTh;
  if (metric.key === "secondary_window") return metric.percentage <= secondaryTh;
  return false;
}

function buildSwitchCandidate(acct, primaryTh, secondaryTh) {
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

async function autoSwitchTick(cfg) {
  const { listAccts, loadIdx, loadAcct } = require("./storage");
  const { refreshQuota } = require("./quota");
  const { doSwitch } = require("./switch");
  const { withAccountLock, withAccountLocks } = require("./operation-locks");
  const { inspectAuthState } = require("./auth-state");

  const authState = inspectAuthState();
  if (authState.requiresResolution) {
    return { switched: false, reason: "auth_conflict", authState };
  }

  const accts = listAccts();
  if (accts.length === 0) return { switched: false, reason: "no_accounts" };

  const monitoredIds = resolveMonitoredIds(cfg, accts);
  if (monitoredIds.length === 0) return { switched: false, reason: "no_monitored" };

  const idx = loadIdx();
  const curId = idx.current_account_id;
  if (!curId || !monitoredIds.includes(curId)) return { switched: false, reason: "current_not_monitored" };

  let cur = accts.find((a) => a.id === curId);
  if (!cur) return { switched: false, reason: "current_not_found" };

  try {
    await withAccountLock(cur.id, async () => {
      const fresh = loadAcct(cur.id);
      if (!fresh) { cur = null; return; }
      await refreshQuota(fresh, { force: false });
      cur = loadAcct(fresh.id) || fresh;
    });
  } catch (error) {
    return {
      switched: false,
      reason: "current_quota_refresh_failed",
      error: error.message || String(error),
    };
  }
  if (!cur) return { switched: false, reason: "current_not_found" };
  const metrics = extractQuotaMetrics(cur);
  if (metrics.length === 0) return { switched: false, reason: "no_quota_data" };

  const primaryTh = cfg.primary_threshold, secondaryTh = cfg.secondary_threshold;
  const shouldSwitch = metrics.some((m) => metricCrossedThreshold(m, primaryTh, secondaryTh));
  if (!shouldSwitch) return { switched: false, reason: "quota_sufficient", metrics };

  const candidates = [];
  for (const listed of accts) {
    if (listed.id === curId) continue;
    if (!monitoredIds.includes(listed.id)) continue;
    let candidate = loadAcct(listed.id) || listed;
    if (!candidate.quota || (ts() - (candidate.usage_updated_at || 0) > 600)) {
      try {
        await withAccountLock(candidate.id, async () => {
          const fresh = loadAcct(candidate.id);
          if (!fresh) { candidate = null; return; }
          await refreshQuota(fresh, { force: false });
          candidate = loadAcct(fresh.id) || fresh;
        });
      } catch { continue; }
    }
    if (!candidate) continue;
    const cand = buildSwitchCandidate(candidate, primaryTh, secondaryTh);
    if (cand) candidates.push(cand);
  }

  if (candidates.length === 0) return { switched: false, reason: "no_candidates", metrics };

  const best = pickBestCandidate(candidates);
  if (!best) return { switched: false, reason: "no_best_candidate" };

  return withAccountLocks(["__switch__", curId, best.id], async () => {
    const latestIdx = loadIdx();
    if (latestIdx.current_account_id !== curId) {
      return { switched: false, reason: "current_changed", metrics };
    }
    const freshBest = loadAcct(best.id);
    const freshCur = loadAcct(curId) || cur;
    if (!freshBest) return { switched: false, reason: "candidate_not_found", metrics };
    const result = await doSwitch(freshBest);
    return { switched: true, from: freshCur, to: result.account, metrics };
  });
}

module.exports = {
  metricCrossedThreshold, buildSwitchCandidate, pickBestCandidate,
  resolveMonitoredIds, autoSwitchTick,
};

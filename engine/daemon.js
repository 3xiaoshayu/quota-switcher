const { REFRESH_MINUTES } = require("./config");
const { needsRefresh, refreshOneTok, refreshAll } = require("./token-refresh");
const { refreshQuota } = require("./quota");
const { fetchResetCredits } = require("./reset-credits");
const { loadAutoSwitchCfg, normalizeSyncIntervalMinutes } = require("./config-manager");
const { autoSwitchTick } = require("./auto-switch");
const { loadIdx, listAccts, saveAcct, loadAcct } = require("./storage");
const { writeAuthJson, writeProjection } = require("./switch");

// 守护工作循环 — 适配 Electron 进程内运行
// 返回 { accountsUpdated, tokenRefreshes, autoSwitchResult }
async function runDaemonWorker() {
  let accountsUpdated = 0;
  let tokenRefreshes = [];
  let autoSwitchResult = null;

  const accts = listAccts();

  // 1. 刷新所有 token
  for (const a of accts) {
    if (needsRefresh(a)) {
      const r = await refreshOneTok(a);
      tokenRefreshes.push({ email: a.email, ok: r.ok, revoked: r.revoked, gen: r.gen });
      accountsUpdated++;
    }
  }

  // 2. 刷新当前账号配额
  const idx = loadIdx();
  if (idx.current_account_id) {
    const cur = loadAcct(idx.current_account_id);
    if (cur) {
      try { await refreshQuota(cur); accountsUpdated++; } catch {}

      // 3. 检查 reset_credits
      try {
        const snap = await fetchResetCredits(cur);
        if (snap.available_count !== cur.reset_credits?.available_count) {
          cur.reset_credits = snap;
          saveAcct(cur);
          accountsUpdated++;
        }
      } catch {}

      // 4. 重写 auth.json
      writeAuthJson(cur);
      writeProjection(cur);
    }
  }

  // 5. 自动切号
  const cfg = loadAutoSwitchCfg();
  if (cfg.enabled) {
    try {
      autoSwitchResult = await autoSwitchTick(cfg);
    } catch {}
  }

  return { accountsUpdated, tokenRefreshes, autoSwitchResult };
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

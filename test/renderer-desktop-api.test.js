const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");

function compileTs(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
}

function loadUserMessages() {
  const sourcePath = path.join(projectRoot, "src", "renderer-react", "api", "user-messages.ts");
  const module = { exports: {} };
  vm.runInNewContext(compileTs(sourcePath), { module, exports: module.exports }, { filename: sourcePath });
  return module.exports;
}

function loadDesktopExports(bridge) {
  const sourcePath = path.join(projectRoot, "src", "renderer-react", "api", "desktop.ts");
  const module = { exports: {} };
  const userMessages = loadUserMessages();
  const sandbox = {
    module,
    exports: module.exports,
    require(id) {
      if (id === "./user-messages") return userMessages;
      throw new Error(`Unexpected require: ${id}`);
    },
    window: { codexAccountManager: bridge },
    console,
    Date,
    Intl,
    Math,
    Number,
    String,
    Error,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(compileTs(sourcePath), sandbox, { filename: sourcePath });
  return module.exports;
}

function loadDesktopApiWithBridge(bridge) {
  return loadDesktopExports(bridge).desktopApi;
}

function ok(data) {
  return Promise.resolve({ success: true, data });
}

function fail(error) {
  return Promise.resolve({ success: false, error });
}

function bridge(overrides = {}) {
  return {
    listAccounts: () => ok([{
      id: "one",
      email: "one@example.com",
      plan_type: "plus",
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: false,
        timeLeft: 3600,
      },
    }]),
    getCurrentAccount: () => ok(null),
    getDaemonStatus: () => ok({ running: false, syncIntervalMinutes: 10 }),
    getAutoSwitchConfig: () => ok({
      enabled: false,
      primary_threshold: 20,
      secondary_threshold: 30,
      account_scope_mode: "all",
      selected_account_ids: [],
      sync_interval_minutes: 10,
    }),
    getAppInfo: () => ok({ name: "Codex Account Manager", version: "test" }),
    getCodexStatus: () => ok({ installed: true }),
    getUpdateStatus: () => ok({ status: "idle" }),
    getAuthState: () => ok({ status: "aligned", requiresResolution: false }),
    getOAuthStatus: () => ok({ status: "idle", pending: false }),
    getStorageDiagnostics: () => ok([]),
    ...overrides,
  };
}

test("dashboard state survives optional desktop API failures", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    getAppInfo: () => fail("app info unavailable"),
    getCodexStatus: async () => { throw new Error("codex status crashed"); },
    getUpdateStatus: () => fail("update service unavailable"),
    getOAuthStatus: () => fail("oauth status unavailable"),
    getStorageDiagnostics: async () => { throw new Error("diagnostics crashed"); },
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.accounts[0].email, "one@example.com");
  assert.equal(snapshot.appInfo, null);
  assert.equal(snapshot.codexStatus, null);
  assert.equal(snapshot.updateStatus, null);
  assert.equal(snapshot.oauthStatus.status, "idle");
  assert.equal(snapshot.oauthStatus.pending, false);
  assert.equal(snapshot.oauthStatus.message, null);
  assert.equal(snapshot.storageDiagnostics.length, 0);
});

test("dashboard state still loads when authentication state never returns", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    getAuthState: () => new Promise((resolve) => {
      setTimeout(() => resolve(fail("late authentication state")), 4000);
    }),
    getCodexStatus: () => new Promise((resolve) => {
      setTimeout(() => resolve(fail("late Codex status")), 4000);
    }),
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.accounts[0].email, "one@example.com");
  assert.equal(snapshot.authState.status, "unknown");
  assert.equal(snapshot.authState.requiresResolution, false);
  assert.match(snapshot.authState.message, /正在确认官方登录/);
  assert.equal(snapshot.codexStatus, null);
});

test("dashboard state still fails when the core account list is unavailable", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => fail("account database unavailable"),
  }));

  await assert.rejects(
    () => desktopApi.loadDashboardState(),
    /account database unavailable/,
  );
});

test("dashboard state pauses background sync when authentication cannot be verified", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    getAuthState: () => fail("auth state unavailable"),
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.authState.status, "unknown");
  assert.equal(snapshot.authState.requiresResolution, true);
  assert.match(snapshot.authState.message, /auth state unavailable/i);
});

test("dashboard state replaces internal reauthorization details with actionable copy", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([{
      id: "revoked",
      email: "revoked@example.com",
      plan_type: "plus",
      requires_reauth: true,
      reauth_reason: "refresh_token needs re-authorization",
      quota_error: {
        code: "refresh_token_invalidated",
        message: "{\"error\":\"refresh_token_invalidated\"}",
      },
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: false,
        timeLeft: 3600,
      },
    }]),
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts[0].status, "SUSPENDED");
  assert.equal(
    snapshot.accounts[0].warning,
    "该账号需要重新授权后才能使用。",
  );
});

test("quota network failures become sync-failed with short Chinese copy", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([{
      id: "online",
      email: "online@example.com",
      plan_type: "plus",
      quota_error: {
        code: "network",
        message: "网络请求失败 (chatgpt.com)。详情：Electron: Error: net::ERR_CONNECTION_TIMED_OUT",
      },
      quota: {
        weekly_remaining_percentage: 95,
        weekly_window_present: true,
      },
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: false,
        timeLeft: 3600,
      },
    }]),
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts[0].status, "SYNC_FAILED");
  assert.equal(
    snapshot.accounts[0].warning,
    "额度暂时没刷到，登录还在。请稍后再试。",
  );
  assert.doesNotMatch(snapshot.accounts[0].quotaError || "", /ERR_CONNECTION/);
});

test("banned accounts beat reauthorization and keep the deactivation code", async () => {
  const { needsHandling, needsQuotaAutoSync } = loadDesktopExports(bridge());
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([{
      id: "dead",
      email: "dead@example.com",
      plan_type: "plus",
      banned: true,
      requires_reauth: true,
      reauth_reason: "refresh_token needs re-authorization",
      probe: {
        status: "banned",
        error_code: "account_deactivated",
        http_status: 401,
        checked_at: 1,
      },
      quota_error: {
        code: "account_deactivated",
        message: "HTTP 401 account_deactivated",
      },
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: false,
        timeLeft: 3600,
      },
    }]),
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts[0].status, "BANNED");
  assert.equal(
    snapshot.accounts[0].warning,
    "账号已封号，无法继续使用。",
  );
  assert.equal(needsHandling(snapshot.accounts[0]), false);
  assert.equal(snapshot.accounts[0].leftoverAccessUsable, true);
  assert.equal(needsQuotaAutoSync(snapshot.accounts[0]), true);
});

test("reauth accounts with a live leftover token can be ban-checked", async () => {
  const { needsQuotaAutoSync } = loadDesktopExports(bridge());
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([{
      id: "leftover",
      email: "leftover@example.com",
      requires_reauth: true,
      reauth_reason: "refresh_token needs re-authorization",
      quota_error: { code: "refresh_token_invalidated", message: "refresh_token_invalidated" },
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: false,
        timeLeft: 3600,
      },
    }]),
  }));
  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts[0].status, "SUSPENDED");
  assert.equal(snapshot.accounts[0].leftoverAccessUsable, true);
  assert.equal(needsQuotaAutoSync(snapshot.accounts[0]), true);

  const expiredApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([{
      id: "expired",
      email: "expired@example.com",
      requires_reauth: true,
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: true,
        timeLeft: -10,
      },
    }]),
  }));
  const expired = await expiredApi.loadDashboardState();
  assert.equal(expired.accounts[0].leftoverAccessUsable, false);
  assert.equal(needsQuotaAutoSync(expired.accounts[0]), false);
});

test("unusable tokens without a reauth flag still warn as reauthorization", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([{
      id: "dead-tokens",
      email: "dead-tokens@example.com",
      quota_error: { code: "http_500", message: "HTTP 500" },
      token_status: {
        accessAvailable: false,
        refreshAvailable: false,
        expired: true,
        timeLeft: -10,
      },
    }]),
  }));
  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts[0].status, "SUSPENDED");
  assert.equal(snapshot.accounts[0].warning, "该账号需要重新授权后才能使用。");
});

test("rejected leftover access tokens cannot refresh quotas or join auto-switch", async () => {
  const { canJoinAutoSwitch, canRefreshQuota, needsQuotaAutoSync, pruneAutoSwitchAccountIds } = loadDesktopExports(bridge());
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([{
      id: "spent",
      email: "spent@example.com",
      requires_reauth: true,
      probe: { status: "probe_failed", error_code: "token_invalidated", http_status: 401, checked_at: 1 },
      quota_error: { code: "refresh_token_invalidated", message: "refresh_token_invalidated" },
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: false,
        timeLeft: 3600,
      },
    }, {
      id: "ready",
      email: "ready@example.com",
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: false,
        timeLeft: 3600,
      },
    }]),
  }));
  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts[0].leftoverAccessUsable, false);
  assert.equal(snapshot.accounts[0].tokenValidity, "已失效");
  assert.equal(snapshot.accounts[0].tokenValidityPct, 0);
  assert.equal(canRefreshQuota(snapshot.accounts[0]), false);
  assert.equal(needsQuotaAutoSync(snapshot.accounts[0]), false);
  assert.equal(canJoinAutoSwitch(snapshot.accounts[0]), false);
  assert.equal(canJoinAutoSwitch(snapshot.accounts[1]), true);
  assert.deepEqual(
    pruneAutoSwitchAccountIds([snapshot.accounts[0].id, snapshot.accounts[1].id], snapshot.accounts),
    [snapshot.accounts[1].id],
  );
});

test("banned leftover-rejected tokens hide stale quota", async () => {
  const { hideStaleQuota, leftoverAccessRejected, quotaWindowSummary } = loadDesktopExports(bridge());
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([{
      id: "banned-spent",
      email: "banned-spent@example.com",
      banned: true,
      probe: { status: "probe_failed", error_code: "token_invalidated", http_status: 401, checked_at: 1 },
      quota: {
        hourly_remaining_percentage: 88,
        weekly_remaining_percentage: 22,
        hourly_window_present: true,
        weekly_window_present: true,
      },
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: false,
        timeLeft: 3600,
      },
    }]),
  }));
  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts[0].status, "BANNED");
  assert.equal(leftoverAccessRejected({
    probe: { status: "probe_failed", error_code: "token_invalidated", http_status: 401 },
  }), true);
  assert.equal(snapshot.accounts[0].leftoverAccessUsable, false);
  assert.equal(hideStaleQuota(snapshot.accounts[0]), true);
  assert.equal(quotaWindowSummary("fiveHour", snapshot.accounts[0]).text, "已封号");
  assert.equal(quotaWindowSummary("weekly", snapshot.accounts[0]).text, "已封号");
});

test("leftover access rejected codes stay aligned with the engine", () => {
  const engineProbe = require("../engine/account-probe");
  const { ACCESS_REJECTED_CODES, leftoverAccessRejected, summarizeRefreshAllResults, summarizeTokenCheckResults } = loadDesktopExports(bridge());
  assert.deepEqual([...ACCESS_REJECTED_CODES].sort(), [...engineProbe.ACCESS_REJECTED_CODES].sort());
  for (const code of ACCESS_REJECTED_CODES) {
    const probe = { status: "probe_failed", error_code: code, http_status: 401 };
    assert.equal(engineProbe.isLeftoverAccessRejected(probe), true);
    assert.equal(leftoverAccessRejected({ probe }), true);
  }
  assert.equal(leftoverAccessRejected({
    probe: { status: "banned", error_code: "account_deactivated", http_status: 401 },
  }), false);
  const summary = summarizeRefreshAllResults([
    { quota: { hourly_remaining_percentage: 40 } },
    { skipped: true, reason: "reauthorization_required" },
    { skipped: true, reason: "account_banned", banned: true },
    { error: "timeout" },
    { error: "这次没查清额度，请稍后重试。", reason: "cursor_session_missing" },
    { error: "HTTP 401", banned: true },
    { error: "Account requires reauthorization before quotas can be refreshed.", reason: "reauthorization_required" },
    { error: "The target account is banned and cannot refresh quotas", reason: "account_banned" },
  ]);
  assert.equal(summary.refreshed, 1);
  assert.equal(summary.reauthSkipped, 2);
  assert.equal(summary.bannedSkipped, 3);
  assert.equal(summary.failed, 2);
  const tokenSummary = summarizeTokenCheckResults([
    { ok: true, skipped: true },
    { ok: false, skipped: true, reauthRequired: true },
    { ok: false, skipped: true, banned: true },
    { ok: false, error: "timeout" },
  ]);
  assert.equal(tokenSummary.passed, 1);
  assert.equal(tokenSummary.reauthSkipped, 1);
  assert.equal(tokenSummary.bannedSkipped, 1);
  assert.equal(tokenSummary.failed, 1);
});

test("token status chips stay product-agnostic and summarize batch checks", () => {
  const { tokenStatusChip, formatTokenCheckMessage } = loadDesktopExports(bridge());
  const empty = tokenStatusChip("Codex", []);
  assert.equal(empty.ok, true);
  assert.equal(empty.text, "Codex 0 个账号");
  const healthy = tokenStatusChip("Cursor", [
    { status: "ACTIVE", tokenExpired: false, tokenValidity: "剩余 12 天" },
    { status: "READY", tokenExpired: false, tokenValidity: "剩余 3 天" },
  ]);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.text, "Cursor 2 个正常");
  const attention = tokenStatusChip("Codex", [
    { status: "ACTIVE", tokenExpired: false, tokenValidity: "剩余 12 天" },
    { status: "SUSPENDED", tokenExpired: false, tokenValidity: "已失效" },
    { status: "ACTIVE", tokenExpired: true, tokenValidity: "已过期" },
  ]);
  assert.equal(attention.ok, false);
  assert.equal(attention.text, "Codex 2 个需授权");
  assert.equal(formatTokenCheckMessage([]).tone, "info");
  assert.match(formatTokenCheckMessage([{ ok: true }, { ok: false, skipped: true }]).message, /需重新授权/);
  assert.equal(formatTokenCheckMessage([{ ok: true }, { ok: true, skipped: true }]).tone, "success");
  assert.match(formatTokenCheckMessage([{ ok: false }], { product: "cursor" }).message, /失败/);
  assert.doesNotMatch(formatTokenCheckMessage([{ ok: false }], { product: "cursor" }).message, /这次没查清/);
  assert.match(formatTokenCheckMessage([{ ok: false }], { product: "codex" }).message, /失败/);
});

test("settings token card lists every tokenBatch product", () => {
  const settings = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "components", "SettingsView.tsx"), "utf8");
  const products = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "data", "products.ts"), "utf8");
  const app = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "App.tsx"), "utf8");
  assert.match(settings, /tokenStatusChip/);
  assert.match(settings, /检查各产品账号登录是否仍可用/);
  assert.doesNotMatch(settings, /只检查 Codex|只针对 Codex|已管理账号/);
  assert.match(settings, /token-status-chips/);
  assert.match(settings, /updates-status-chips/);
  assert.match(products, /id: 'cursor'[\s\S]*tokenBatch: true/);
  assert.match(app, /refreshAllCursorTokens/);
  assert.match(app, /tokenAccountsByProduct/);
});

test("settings daemon card lists product jobs without following the sidebar", () => {
  const settings = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "components", "SettingsView.tsx"), "utf8");
  const sidebar = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "components", "Sidebar.tsx"), "utf8");
  assert.match(settings, /只做 Codex 续登录和自动切号/);
  assert.match(settings, /daemon-product-chips/);
  assert.match(settings, /续登录 · 切号/);
  assert.match(settings, /暂不参与/);
  assert.doesNotMatch(settings, /只管 Codex/);
  assert.match(settings, /daemonState\.status !== 'Running' && settings\.globalSwitch/);
  assert.doesNotMatch(settings, /settings\.globalSwitch && productById\(product\)\.features\.autoSwitch/);
  assert.doesNotMatch(sidebar, /Codex Daemon/);
  assert.match(sidebar, /Daemon 运行中/);
  assert.match(settings, /跟随 \{productById\(product\)\.label\}/);
  assert.match(settings, /line-clamp-2/);
  assert.doesNotMatch(settings, /max-w-xs truncate/);
  assert.match(settings, /!\/稍后会自动重试\|稍后会自动刷新\|正在确认官方登录\//);
});

test("usage limited and probe-failed stay out of the banned bucket", async () => {
  const { needsHandling, STATUS_TEXT } = loadDesktopExports(bridge());
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([
      {
        id: "limited",
        email: "limited@example.com",
        probe: { status: "usage_limited", error_code: "usage_limit_reached", http_status: 429, checked_at: 1 },
        quota_error: { code: "usage_limit_reached", message: "HTTP 429 usage_limit_reached" },
        token_status: { accessAvailable: true, refreshAvailable: true, expired: false, timeLeft: 3600 },
      },
      {
        id: "unclear",
        email: "unclear@example.com",
        probe: { status: "probe_failed", error_code: null, http_status: 401, checked_at: 1 },
        quota_error: { code: null, message: "HTTP 401" },
        token_status: { accessAvailable: true, refreshAvailable: true, expired: false, timeLeft: 3600 },
      },
    ]),
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts[0].status, "LIMITED");
  assert.equal(STATUS_TEXT.LIMITED, "额度限流");
  assert.equal(snapshot.accounts[0].warning, "额度已达上限或触发限流。");
  assert.equal(needsHandling(snapshot.accounts[0]), false);
  assert.equal(snapshot.accounts[1].status, "SYNC_FAILED");
  assert.equal(STATUS_TEXT.SYNC_FAILED, "同步失败");
  assert.equal(snapshot.accounts[1].warning, "额度同步失败，请稍后重试。");
  assert.equal(needsHandling(snapshot.accounts[1]), true);
});

test("dashboard maps OpenAI plan types to official names", async () => {
  const tokenStatus = {
    accessAvailable: true,
    refreshAvailable: true,
    expired: false,
    timeLeft: 3600,
  };
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([
      { id: "plus", email: "plus@example.com", plan_type: "plus", token_status: tokenStatus },
      { id: "pro", email: "pro@example.com", plan_type: "pro", token_status: tokenStatus },
      { id: "go", email: "go@example.com", plan_type: "go", token_status: tokenStatus },
      { id: "ent", email: "ent@example.com", plan_type: "enterprise", token_status: tokenStatus },
      { id: "free", email: "free@example.com", plan_type: "free", token_status: tokenStatus },
    ]),
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.deepEqual(
    snapshot.accounts.map((account) => account.plan),
    ["Plus", "Pro", "Go", "Enterprise", "Standard"],
  );
  const { planLabel } = loadDesktopExports(bridge());
  assert.equal(planLabel("Plus"), "Plus 套餐");
  assert.equal(planLabel("Pro"), "Pro 套餐");
  assert.equal(planLabel("Team Plan"), "Team 套餐");
  assert.equal(planLabel(""), "套餐");
});

test("quota auto-sync uses one minute for the current account and ten for others", () => {
  const {
    needsQuotaAutoSync,
    quotaAutoSyncStaleMs,
    CURRENT_QUOTA_AUTO_SYNC_STALE_MS,
    QUOTA_AUTO_SYNC_STALE_MS,
  } = loadDesktopExports(bridge());
  const now = Date.now();
  const base = {
    status: "ACTIVE",
    tokenExpired: false,
    tokenAccessAvailable: true,
    tokenRefreshAvailable: true,
    quotaError: null,
  };
  const currentStale = {
    ...base,
    isCurrent: true,
    quotaUpdatedAt: Math.floor((now - 90 * 1000) / 1000),
  };
  const currentFresh = {
    ...base,
    isCurrent: true,
    quotaUpdatedAt: Math.floor((now - 20 * 1000) / 1000),
  };
  const otherRecent = {
    ...base,
    isCurrent: false,
    quotaUpdatedAt: Math.floor((now - 90 * 1000) / 1000),
  };
  const otherStale = {
    ...base,
    isCurrent: false,
    quotaUpdatedAt: Math.floor((now - 11 * 60 * 1000) / 1000),
  };

  assert.equal(quotaAutoSyncStaleMs(currentStale, 10), CURRENT_QUOTA_AUTO_SYNC_STALE_MS);
  assert.equal(quotaAutoSyncStaleMs(otherRecent, 1), QUOTA_AUTO_SYNC_STALE_MS);
  assert.equal(needsQuotaAutoSync(currentStale, quotaAutoSyncStaleMs(currentStale, 10)), true);
  assert.equal(needsQuotaAutoSync(currentFresh, quotaAutoSyncStaleMs(currentFresh, 10)), false);
  assert.equal(needsQuotaAutoSync(otherRecent, quotaAutoSyncStaleMs(otherRecent, 1)), false);
  assert.equal(needsQuotaAutoSync(otherStale, quotaAutoSyncStaleMs(otherStale, 1)), true);
});

test("auto-switch banner uses quota thresholds and daemon state, not ACTIVE status", () => {
  const { isCurrentQuotaSufficient, autoSwitchStatusBanner } = loadDesktopExports(bridge());
  const low = {
    fiveHourQuotaRemaining: 10,
    fiveHourQuotaTotal: 100,
    fiveHourQuotaPresent: true,
    weeklyQuotaRemaining: 80,
    weeklyQuotaTotal: 100,
    weeklyQuotaPresent: true,
    status: "ACTIVE",
  };
  const okQuota = {
    fiveHourQuotaRemaining: 55,
    fiveHourQuotaTotal: 100,
    fiveHourQuotaPresent: true,
    weeklyQuotaRemaining: 80,
    weeklyQuotaTotal: 100,
    weeklyQuotaPresent: true,
    status: "WARNING",
  };
  assert.equal(isCurrentQuotaSufficient(low, 20, 30), false);
  assert.equal(isCurrentQuotaSufficient(okQuota, 20, 30), true);
  assert.equal(isCurrentQuotaSufficient(null, 20, 30), false);
  assert.equal(isCurrentQuotaSufficient({ ...okQuota, status: "BANNED" }, 20, 30), false);
  assert.equal(isCurrentQuotaSufficient({ ...okQuota, status: "LIMITED" }, 20, 30), false);

  const switchOff = autoSwitchStatusBanner({
    hasCurrentAccount: true,
    quotaSufficient: true,
    globalSwitch: false,
    daemonRunning: true,
  });
  assert.equal(switchOff.title, "自动切号未启用");
  assert.equal(switchOff.detail, "全局开关已关闭。启用开关并启动 Daemon 后，将在额度低于阈值时切换账号。");
  assert.equal(switchOff.tone, "neutral");

  const daemonStopped = autoSwitchStatusBanner({
    hasCurrentAccount: true,
    quotaSufficient: true,
    globalSwitch: true,
    daemonRunning: false,
  });
  assert.equal(daemonStopped.title, "自动切号未运行");
  assert.equal(daemonStopped.detail, "全局开关已启用，但 Daemon 已停止，不会自动切换账号。");
  assert.equal(daemonStopped.tone, "warn");

  const paused = autoSwitchStatusBanner({
    hasCurrentAccount: true,
    quotaSufficient: true,
    globalSwitch: true,
    daemonRunning: true,
    pausedReason: "官方 Codex 当前没有登录",
  });
  assert.equal(paused.title, "自动切号已暂停");
  assert.equal(paused.detail, "官方 Codex 当前没有登录。");
  assert.equal(paused.tone, "warn");

  const quotaOk = autoSwitchStatusBanner({
    hasCurrentAccount: true,
    quotaSufficient: true,
    globalSwitch: true,
    daemonRunning: true,
  });
  assert.equal(quotaOk.title, "额度充足，暂不切换");
  assert.equal(quotaOk.detail, "自动切号已启用。额度低于阈值后将自动切换账号。");
  assert.equal(quotaOk.tone, "ok");

  const quotaLow = autoSwitchStatusBanner({
    hasCurrentAccount: true,
    quotaSufficient: false,
    globalSwitch: true,
    daemonRunning: true,
  });
  assert.equal(quotaLow.title, "当前额度偏低");
  assert.equal(quotaLow.detail, "自动切号已启用，将在下次检查时尝试切换账号。");
  assert.equal(quotaLow.tone, "warn");

  const bannedCurrent = autoSwitchStatusBanner({
    hasCurrentAccount: true,
    quotaSufficient: false,
    globalSwitch: true,
    daemonRunning: true,
    currentStatus: "BANNED",
  });
  assert.equal(bannedCurrent.title, "当前账号已封号");
  assert.match(bannedCurrent.detail, /已封号/);
  assert.equal(bannedCurrent.tone, "warn");

  const reauthCurrent = autoSwitchStatusBanner({
    hasCurrentAccount: true,
    quotaSufficient: false,
    globalSwitch: true,
    daemonRunning: true,
    currentStatus: "SUSPENDED",
  });
  assert.equal(reauthCurrent.title, "当前账号需要重新授权");
  assert.match(reauthCurrent.detail, /无法继续使用/);
  assert.equal(reauthCurrent.tone, "warn");

  const limitedCurrent = autoSwitchStatusBanner({
    hasCurrentAccount: true,
    quotaSufficient: false,
    globalSwitch: true,
    daemonRunning: true,
    currentStatus: "LIMITED",
  });
  assert.equal(limitedCurrent.title, "当前账号额度限流");
  assert.match(limitedCurrent.detail, /将切换到其他可用账号/);
  assert.equal(limitedCurrent.tone, "warn");

  const syncFailedCurrent = autoSwitchStatusBanner({
    hasCurrentAccount: true,
    quotaSufficient: false,
    globalSwitch: true,
    daemonRunning: true,
    currentStatus: "SYNC_FAILED",
  });
  assert.equal(syncFailedCurrent.title, "当前账号同步失败");
  assert.match(syncFailedCurrent.detail, /查清后再判断是否切号/);
  assert.equal(syncFailedCurrent.tone, "warn");
});

test("quota bar color turns green at 55 and red below 25", () => {
  const { quotaBarColor } = loadDesktopExports(bridge());
  assert.equal(quotaBarColor(null), "bg-fill-3");
  assert.equal(quotaBarColor(55), "bg-ok");
  assert.equal(quotaBarColor(54), "bg-warn");
  assert.equal(quotaBarColor(25), "bg-warn");
  assert.equal(quotaBarColor(24), "bg-danger");
});

test("quota hero uses the tighter remaining window", () => {
  const { quotaHero, quotaStroke } = loadDesktopExports(bridge());
  const hero = quotaHero({
    fiveHourQuotaRemaining: 18,
    fiveHourQuotaPresent: true,
    weeklyQuotaRemaining: 97,
    weeklyQuotaPresent: true,
  });
  assert.equal(hero.key, "fiveHour");
  assert.equal(hero.percent, 18);
  assert.equal(hero.label, "5 小时");
  assert.equal(quotaStroke(18), "#ff453a");
  assert.equal(quotaStroke(97), "#30d158");
  assert.equal(quotaHero({
    fiveHourQuotaPresent: false,
    fiveHourQuotaRemaining: null,
    weeklyQuotaPresent: true,
    weeklyQuotaRemaining: 41,
  }).key, "weekly");
  const staleHero = quotaHero({
    status: "BANNED",
    leftoverAccessUsable: false,
    fiveHourQuotaRemaining: 94,
    fiveHourQuotaPresent: true,
    weeklyQuotaRemaining: 88,
    weeklyQuotaPresent: true,
  });
  assert.equal(staleHero.percent, null);
  assert.equal(staleHero.label, "已封号");
});

test("quota hero uses Cursor Auto and API labels", () => {
  const { quotaHero, lensQuotaWindows } = loadDesktopExports(bridge());
  const hero = quotaHero({
    id: "cursor_1",
    quotaKind: "cursor",
    cursorPlanRemaining: 12,
    cursorAutoRemaining: 90,
    cursorApiRemaining: 40,
  });
  assert.equal(hero.key, "api");
  assert.equal(hero.percent, 40);
  assert.equal(hero.label, "API");
  const windows = lensQuotaWindows({
    id: "cursor_1",
    quotaKind: "cursor",
    cursorPlanRemaining: 12,
    cursorAutoRemaining: 90,
    cursorApiRemaining: 40,
  });
  assert.equal(windows.innerLabel, "API");
  assert.equal(windows.outerLabel, "Auto");
  assert.equal(windows.inner, 40);
  assert.equal(windows.outer, 90);
  assert.equal(windows.innerReset, null);
  const failedWindows = lensQuotaWindows({
    id: "cursor_1",
    quotaKind: "cursor",
    status: "SYNC_FAILED",
    leftoverAccessUsable: true,
    cursorPlanRemaining: 59,
    cursorAutoRemaining: 81,
    cursorApiRemaining: 0,
  });
  assert.equal(failedWindows.inner, null);
  assert.equal(failedWindows.outer, null);
  assert.equal(quotaHero({
    id: "cursor_2",
    quotaKind: "cursor",
    status: "SUSPENDED",
    leftoverAccessUsable: false,
    cursorAutoRemaining: 70,
    cursorApiRemaining: 80,
  }).label, "需重新授权");
  assert.equal(quotaHero({
    id: "cursor_3",
    quotaKind: "cursor",
    status: "SYNC_FAILED",
  }).label, "这次没查清");
  assert.equal(quotaHero({
    status: "SYNC_FAILED",
  }).label, "同步失败");
});

test("startup float product prefers the sidebar product when it has a current account", () => {
  const { pickStartupFloatProduct } = loadDesktopExports(bridge());
  const current = { isCurrent: true };
  const other = { isCurrent: false };
  assert.equal(pickStartupFloatProduct("cursor", [current], [current]), "cursor");
  assert.equal(pickStartupFloatProduct("codex", [current], [current]), "codex");
  assert.equal(pickStartupFloatProduct("codex", [other], [current]), "cursor");
  assert.equal(pickStartupFloatProduct("cursor", [current], [other]), "codex");
  assert.equal(pickStartupFloatProduct("cursor", [other], [other]), null);
  assert.equal(pickStartupFloatProduct("codex", [], []), null);
  assert.equal(pickStartupFloatProduct("antigravity", [other], [other], [current]), "antigravity");
  assert.equal(pickStartupFloatProduct("codex", [other], [other], [current]), "antigravity");
});

test("last check caption avoids repeating 检查 when no run has happened", () => {
  const { lastCheckCaption, formatLogTime } = loadDesktopExports(bridge());
  assert.equal(lastCheckCaption(""), "暂无检查记录");
  assert.equal(lastCheckCaption("尚未检查"), "暂无检查记录");
  assert.equal(lastCheckCaption("08/14 22:15"), "最近检查：08/14 22:15");
  assert.equal(formatLogTime(new Date(2026, 7, 16, 21, 53, 15)), "8月16日 21:53:15");
});

test("scope quota lines explain missing windows instead of showing dashes", () => {
  const { quotaWindowSummary, quotaScopeCaption } = loadDesktopExports(bridge());
  const reauthAccount = {
    status: "SUSPENDED",
    fiveHourQuotaRemaining: 0,
    fiveHourQuotaTotal: 100,
    weeklyQuotaRemaining: 0,
    weeklyQuotaTotal: 100,
  };
  assert.equal(quotaWindowSummary("fiveHour", reauthAccount).text, "需重新授权后刷新");
  assert.equal(quotaWindowSummary("weekly", reauthAccount).text, "需重新授权后刷新");
  assert.equal(quotaScopeCaption(reauthAccount).shared, "需重新授权后刷新");
  assert.equal(quotaScopeCaption(reauthAccount).rows.length, 0);

  const bannedAccount = { ...reauthAccount, status: "BANNED" };
  assert.equal(quotaWindowSummary("fiveHour", bannedAccount).text, "已封号");
  assert.equal(quotaScopeCaption(bannedAccount).shared, "已封号");

  const cursorBanned = { ...bannedAccount, quotaKind: "cursor", id: "cursor_one" };
  assert.equal(quotaWindowSummary("fiveHour", cursorBanned).text, "需重新授权后刷新");
  assert.equal(quotaScopeCaption(cursorBanned).shared, "需重新授权后刷新");

  const cursorSyncFailed = {
    status: "SYNC_FAILED",
    quotaKind: "cursor",
    id: "cursor_one",
    leftoverAccessUsable: true,
    quotaError: "timeout",
    fiveHourQuotaRemaining: null,
    fiveHourQuotaTotal: 100,
    weeklyQuotaRemaining: null,
    weeklyQuotaTotal: 100,
  };
  assert.equal(quotaWindowSummary("fiveHour", cursorSyncFailed).text, "这次没查清");

  const leftoverSyncFailed = {
    status: "SYNC_FAILED",
    quotaKind: "cursor",
    id: "cursor_one",
    leftoverAccessUsable: true,
    quotaError: "timeout",
    fiveHourQuotaRemaining: 42,
    fiveHourQuotaTotal: 100,
    fiveHourQuotaPresent: true,
    weeklyQuotaRemaining: 76,
    weeklyQuotaTotal: 100,
    weeklyQuotaPresent: true,
    cursorAutoRemaining: 81,
    cursorApiRemaining: 0,
  };
  assert.equal(quotaWindowSummary("fiveHour", leftoverSyncFailed).text, "这次没查清");
  assert.equal(quotaWindowSummary("weekly", leftoverSyncFailed).text, "这次没查清");

  const leftoverLive = {
    status: "BANNED",
    leftoverAccessUsable: true,
    fiveHourQuotaRemaining: 88,
    fiveHourQuotaTotal: 100,
    fiveHourQuotaPresent: true,
    weeklyQuotaRemaining: 22,
    weeklyQuotaTotal: 100,
    weeklyQuotaPresent: true,
  };
  assert.equal(quotaWindowSummary("fiveHour", leftoverLive).text, "88%");
  assert.equal(quotaWindowSummary("weekly", leftoverLive).text, "22%");

  assert.equal(quotaWindowSummary("fiveHour", {
    status: "SYNC_FAILED",
    leftoverAccessUsable: true,
    quotaError: "timeout",
    fiveHourQuotaRemaining: null,
    fiveHourQuotaTotal: 100,
    weeklyQuotaRemaining: null,
    weeklyQuotaTotal: 100,
  }).text, "同步失败");

  const limitedAccount = { ...reauthAccount, status: "LIMITED" };
  assert.equal(quotaWindowSummary("weekly", limitedAccount).text, "额度限流");
  assert.equal(quotaScopeCaption(limitedAccount).shared, "额度限流");

  assert.equal(quotaWindowSummary("fiveHour", {
    status: "EXPIRED",
    weeklyBlocksFiveHour: true,
    fiveHourQuotaRemaining: 0,
    fiveHourQuotaTotal: 100,
    fiveHourQuotaPresent: true,
    weeklyQuotaRemaining: 0,
    weeklyQuotaTotal: 100,
    weeklyQuotaPresent: true,
  }).text, "周额度已用尽");

  const missingFiveHour = {
    status: "READY",
    fiveHourQuotaRemaining: null,
    fiveHourQuotaTotal: 100,
    fiveHourQuotaPresent: false,
    weeklyQuotaRemaining: 41,
    weeklyQuotaTotal: 100,
    weeklyQuotaPresent: true,
  };
  assert.equal(quotaWindowSummary("fiveHour", missingFiveHour).text, "暂无此项");
  assert.equal(quotaWindowSummary("weekly", missingFiveHour).text, "41%");
  assert.equal(quotaScopeCaption(missingFiveHour).shared, null);
  assert.equal(
    quotaScopeCaption(missingFiveHour).rows.map((row) => `${row.label}:${row.text}`).join("|"),
    "5 小时:暂无此项|周额度:41%",
  );

  const { averageRemainingCaption, isRedundantQuotaNotice } = loadDesktopExports(bridge());
  assert.equal(isRedundantQuotaNotice("该账号需要重新授权后才能使用。"), true);
  assert.equal(isRedundantQuotaNotice("额度已用尽。"), true);
  assert.equal(isRedundantQuotaNotice("额度暂时没刷到，登录还在。请稍后再试。"), false);
  assert.equal(averageRemainingCaption([
    { status: "ACTIVE", quotaKind: "cursor", id: "cursor_live", cursorPlanRemaining: 55, cursorAutoRemaining: 71, cursorApiRemaining: 0 },
    { status: "EXPIRED", quotaKind: "cursor", id: "cursor_dead", cursorPlanRemaining: 0, cursorAutoRemaining: 0, cursorApiRemaining: 0 },
  ], "cursor"), "63%");
  assert.equal(averageRemainingCaption([
    { status: "ACTIVE", fiveHourQuotaRemaining: 93, fiveHourQuotaTotal: 100, weeklyQuotaRemaining: 93, weeklyQuotaTotal: 100 },
    { status: "SUSPENDED", leftoverAccessUsable: false, fiveHourQuotaRemaining: 10, fiveHourQuotaTotal: 100, weeklyQuotaRemaining: 10, weeklyQuotaTotal: 100 },
  ]), "93%");
});

test("notification badge counts unread warnings and errors until the feed is opened", () => {
  const { countUnreadAlertLogs } = loadDesktopExports(bridge());
  const logs = [
    { id: "n1", type: "success" },
    { id: "n2", type: "warning" },
    { id: "n3", type: "info" },
    { id: "n4", type: "error" },
  ];

  assert.equal(countUnreadAlertLogs(logs, null), 2);
  assert.equal(countUnreadAlertLogs(logs, "n1"), 0);
  assert.equal(countUnreadAlertLogs(logs, "n2"), 0);
  assert.equal(countUnreadAlertLogs([{ id: "n0", type: "error" }, ...logs], "n1"), 1);
  assert.equal(countUnreadAlertLogs(logs, "missing"), 2);
});

test("user-facing messages stay in Chinese", () => {
  const sourcePath = path.join(projectRoot, "src", "renderer-react", "api", "user-messages.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports }, { filename: sourcePath });
  const { toUserMessage, logTypeLabel } = module.exports;

  assert.equal(
    toUserMessage("The target account requires reauthorization before it can be switched to"),
    "该账号需要重新授权后才能切换",
  );
  assert.equal(
    toUserMessage("Account requires reauthorization before tokens can be refreshed."),
    "该账号需要重新授权后才能刷新令牌",
  );
  assert.equal(toUserMessage("Official Codex authentication is missing."), "官方 Codex 当前没有登录");
  assert.equal(toUserMessage("No supported official Codex OAuth login was found"), "本机没有已登录的 Codex");
  assert.equal(
    toUserMessage("Quota authorization could not be repaired: HTTP 401 refresh_token_invalidated"),
    "额度授权无法修复，刷新令牌已失效，请重新授权",
  );
  assert.equal(toUserMessage("OAuth authorization timed out"), "授权超时，请重新点一次");
  assert.equal(toUserMessage("Waiting for browser authorization."), "请在浏览器完成授权");
  assert.equal(toUserMessage("OAuth authorization was cancelled"), "授权已取消");
  assert.equal(toUserMessage("The target account is banned and cannot be switched to"), "账号已封号，无法切换");
  assert.equal(toUserMessage("The target account is banned and cannot refresh quotas"), "账号已封号，无法刷新额度");
  assert.equal(toUserMessage("The target account is banned and token refresh is skipped"), "账号已封号，不再刷新令牌");
  assert.equal(toUserMessage("HTTP 401 account_deactivated"), "账号已封号，无法继续使用。");
  assert.equal(toUserMessage("HTTP 401 account_disabled"), "账号已封号，无法继续使用。");
  assert.equal(toUserMessage("HTTP 403 account_disabled"), "账号已封号，无法继续使用。");
  assert.equal(toUserMessage("HTTP 400 account_disabled"), "刷新令牌已失效，请重新授权");
  assert.equal(toUserMessage("account_disabled"), "刷新令牌已失效，请重新授权");
  assert.equal(
    toUserMessage("Token refresh failed: HTTP 400 account_disabled"),
    "刷新令牌已失效，请重新授权",
  );
  assert.equal(
    toUserMessage("Token refresh failed: HTTP 401 account_disabled"),
    "刷新令牌已失效，请重新授权",
  );
  assert.equal(toUserMessage("Token refresh failed: HTTP 500"), "令牌刷新失败");
  assert.equal(toUserMessage("HTTP 500"), "服务暂时不可用，请稍后刷新额度");
  assert.equal(toUserMessage("disabled"), "全局开关已关闭，不会切号");
  assert.equal(toUserMessage("已从管理器中删除账号 a@b.com。"), "已从管理器中删除账号 a@b.com。");
  assert.equal(toUserMessage("SomeUnknownEnglishFailureXYZ"), "操作失败，请稍后重试");
  assert.equal(toUserMessage("Token 已过期且刷新失败"), "令牌已过期且刷新失败，请重新授权");
  assert.equal(toUserMessage("Cursor usage request failed: HTTP 500"), "这次没查清 Cursor 额度，请稍后重试");
  assert.equal(toUserMessage("cursor_session_missing"), "这次没查清 Cursor 额度，请稍后重试");
  assert.equal(toUserMessage("Cursor session cookie could not be built"), "这次没查清 Cursor 额度，请稍后重试");
  assert.equal(toUserMessage("Cursor usage response was not JSON"), "这次没查清 Cursor 额度，请稍后重试");
  assert.equal(toUserMessage("invalid_usage_json"), "这次没查清 Cursor 额度，请稍后重试");
  assert.equal(toUserMessage("官方 Cursor 还在占用登录库，请关掉后再切"), "官方 Cursor 还在占用登录库，请关掉后再切");
  assert.equal(toUserMessage("cursor_vscdb_busy"), "官方 Cursor 还在占用登录库，请关掉后再切");
  assert.equal(toUserMessage("SQLITE_BUSY: database is locked"), "登录库正被占用，请关掉后再试");
  const { toCursorUserMessage } = module.exports;
  assert.equal(toCursorUserMessage("HTTP 401 account_disabled"), "Cursor 登录已失效，请重新授权");
  assert.equal(toCursorUserMessage("HTTP 401 account_deactivated"), "Cursor 登录已失效，请重新授权");
  assert.equal(
    toUserMessage("网络请求失败 (chatgpt.com)。详情：Electron: Error: Electron network failed after retry: Error: net::ERR_CONNECTION_TIMED_OUT | Node: ETIMEDOUT"),
    "额度暂时没刷到，登录还在。请稍后再试。",
  );
  assert.equal(
    toUserMessage("网络请求失败 (chatgpt.com)。本机 DNS 异常且没有可用的本地代理。"),
    "额度暂时没刷到，登录还在。请稍后再试。",
  );
  assert.equal(toUserMessage("Invalid string length"), "额度暂时没刷到，登录还在。请稍后再试。");
  assert.equal(toUserMessage("响应过大"), "额度暂时没刷到，登录还在。请稍后再试。");
  assert.equal(toUserMessage("Read authentication state timed out"), "正在确认官方登录，稍后会自动刷新");
  assert.equal(
    toUserMessage("Switch to another account before deleting the current account."),
    "请先切到其他账号，再删除当前账号",
  );
  assert.equal(toUserMessage("refresh_token needs re-authorization"), "刷新令牌已失效，请重新授权");
  assert.equal(logTypeLabel("error"), "错误");
  assert.equal(logTypeLabel("warning"), "警告");
  assert.equal(logTypeLabel("success"), "成功");
  assert.equal(logTypeLabel("info"), "信息");
});

test("duration and handling helpers stay in Chinese", () => {
  const { formatDuration, formatResetLine, needsHandling, cursorEmptyQuotaText, tokenRemainLabel } = loadDesktopExports(bridge());
  assert.equal(tokenRemainLabel(null), "有效期未知");
  assert.equal(tokenRemainLabel(3600), "剩余 1 小时");
  assert.equal(formatDuration(45), "1 分钟");
  assert.equal(formatDuration(3600), "1 小时");
  assert.equal(formatDuration(3659), "1 小时 1 分钟");
  assert.equal(formatDuration(86400 * 8 + 3600 * 3), "8 天 3 小时");
  assert.equal(formatDuration(-1), "已过期");
  const resetAt = Math.floor(Date.now() / 1000) + (4 * 86400) + (9 * 3600);
  assert.match(formatResetLine(resetAt), /^重置 /);
  assert.match(formatResetLine(resetAt), / · /);
  assert.equal(formatResetLine(Math.floor(Date.now() / 1000) - 60), "额度已重置");
  assert.equal(needsHandling({ status: "SUSPENDED" }), true);
  assert.equal(needsHandling({ status: "EXPIRED" }), false);
  assert.equal(needsHandling({ status: "SYNC_FAILED" }), true);
  assert.equal(needsHandling({ status: "BANNED" }), false);
  assert.equal(needsHandling({ status: "LIMITED" }), false);
  assert.equal(needsHandling({ status: "WARNING" }), false);
  assert.equal(needsHandling({ status: "LOW_QUOTA" }), false);
  assert.equal(needsHandling({ status: "ACTIVE" }), false);
  const { statusTextForAccount, statusDotForAccount, isBannedStatus, STATUS_DOT, STATUS_TEXT } = loadDesktopExports(bridge());
  assert.equal(needsHandling({ status: "WARNING", quotaKind: "cursor", id: "cursor_one" }), false);
  assert.equal(needsHandling({ status: "LOW_QUOTA", quotaKind: "cursor", id: "cursor_one" }), false);
  assert.equal(needsHandling({ status: "EXPIRED", quotaKind: "cursor", id: "cursor_one" }), false);
  assert.equal(needsHandling({ status: "BANNED", quotaKind: "cursor", id: "cursor_one" }), false);
  assert.equal(statusTextForAccount({ status: "WARNING", quotaKind: "cursor", id: "cursor_one" }), "正常");
  assert.equal(statusDotForAccount({ status: "WARNING", quotaKind: "cursor", id: "cursor_one" }), STATUS_DOT.ACTIVE);
  assert.equal(statusTextForAccount({ status: "SUSPENDED", quotaKind: "cursor", id: "cursor_one" }), "需重新授权");
  assert.equal(statusTextForAccount({ status: "READY", quotaKind: "cursor", id: "cursor_one" }), "就绪");
  assert.equal(statusTextForAccount({ status: "SYNC_FAILED", quotaKind: "cursor", id: "cursor_one" }), "这次没查清");
  assert.equal(statusTextForAccount({ status: "BANNED", quotaKind: "cursor", id: "cursor_one" }), "这次没查清");
  assert.equal(STATUS_TEXT.EXPIRED, "已用尽");
  assert.equal(statusTextForAccount({ status: "EXPIRED", quotaKind: "cursor", id: "cursor_one" }), "已用尽");
  assert.equal(statusTextForAccount({ status: "EXPIRED" }), "已用尽");
  assert.equal(isBannedStatus({ status: "BANNED", quotaKind: "cursor", id: "cursor_one" }), false);
  assert.equal(isBannedStatus({ status: "BANNED", id: "codex_one" }), true);
  assert.equal(cursorEmptyQuotaText({ status: "SUSPENDED" }), "需重新授权");
  assert.equal(cursorEmptyQuotaText({ status: "SYNC_FAILED", warning: "这次没查清额度，请稍后重试。" }), "这次没查清");
  assert.equal(cursorEmptyQuotaText({ status: "EXPIRED" }), "已用尽");
  assert.equal(cursorEmptyQuotaText({ status: "LIMITED" }), "额度限流");
  assert.equal(cursorEmptyQuotaText({ status: "ACTIVE" }), "暂无此项");
});

test("cursor account mapping never uses ban status and rounds leftover quota", () => {
  const { mapCursorAccountForUi } = loadDesktopExports(bridge());
  const depleted = mapCursorAccountForUi({
    id: "cursor_depleted",
    email: "depleted@example.com",
    banned: true,
    probe: { status: "usage_limited" },
    quota: {
      plan_remaining_percentage: 0.0633,
      auto_remaining_percentage: 0.04,
      api_remaining_percentage: 0,
    },
    token_status: { accessAvailable: true, refreshAvailable: true, expired: false, timeLeft: 3600 },
  }, { id: "cursor_depleted" });
  assert.equal(depleted.status, "EXPIRED");
  assert.equal(depleted.quotaKind, "cursor");
  const usageFailed = mapCursorAccountForUi({
    id: "cursor_usage_failed",
    email: "usage-failed@example.com",
    quota_error: { code: "probe_failed", message: "Cursor usage request failed: HTTP 429" },
    token_status: { accessAvailable: true, refreshAvailable: true, expired: false, timeLeft: 3600 },
  }, null);
  assert.equal(usageFailed.status, "SYNC_FAILED");
  assert.doesNotMatch(String(usageFailed.warning || ""), /usage request failed|HTTP 429/i);
  assert.match(String(usageFailed.warning || ""), /没查清/);
  const probeBanned = mapCursorAccountForUi({
    id: "cursor_probe_banned",
    email: "probe-banned@example.com",
    banned: false,
    probe: { status: "banned" },
    token_status: { accessAvailable: false, refreshAvailable: false, expired: true, timeLeft: 0 },
  }, null);
  assert.equal(probeBanned.status, "SUSPENDED");
  assert.equal(probeBanned.warning, "该账号需要重新授权后才能使用。");
  assert.doesNotMatch(String(probeBanned.warning || ""), /已封号/);
  assert.equal(depleted.cursorPlanRemaining, 0);
  assert.equal(depleted.cursorAutoRemaining, 0);
  assert.equal(depleted.cursorApiRemaining, 0);
  assert.equal(depleted.warning, "额度已用尽。");

  const mixed = mapCursorAccountForUi({
    id: "cursor_mixed",
    email: "mixed@example.com",
    quota: {
      plan_remaining_percentage: 50.4,
      auto_remaining_percentage: 0,
      api_remaining_percentage: 12.2,
    },
    token_status: { accessAvailable: true, refreshAvailable: true, expired: false, timeLeft: 3600 },
  }, null);
  assert.equal(mixed.status, "WARNING");
  assert.equal(mixed.cursorPlanRemaining, 50);
  assert.equal(mixed.cursorApiRemaining, 12);

  const team = mapCursorAccountForUi({
    id: "cursor_team",
    email: "team@example.com",
    plan_type: "enterprise",
    quota: { membership_type: "enterprise", plan_remaining_percentage: 75, auto_remaining_percentage: 97, api_remaining_percentage: 0 },
    token_status: { accessAvailable: true, refreshAvailable: true, expired: false, timeLeft: 3600 },
  }, null);
  assert.equal(team.plan, "Team");
  assert.equal(team.priority, "High");
  const namedTeam = mapCursorAccountForUi({
    id: "cursor_named_team",
    email: "named-team@example.com",
    plan_type: "team",
    token_status: { accessAvailable: true, refreshAvailable: true, expired: false, timeLeft: 3600 },
  }, null);
  assert.equal(namedTeam.plan, "Team");
  const bars = loadDesktopExports(bridge()).quotaBarsForAccount(team);
  assert.equal(bars.length, 3);
  assert.equal(bars[0].label, "套餐用量");
  assert.equal(bars[1].label, "Auto");
  assert.equal(bars[2].label, "API");
  const failedBars = loadDesktopExports(bridge()).quotaBarsForAccount({
    ...team,
    status: "SYNC_FAILED",
    leftoverAccessUsable: true,
  });
  assert.equal(failedBars[0].remaining, null);
  assert.equal(failedBars[1].remaining, null);
  assert.equal(failedBars[2].remaining, null);
  const staleBars = loadDesktopExports(bridge()).quotaBarsForAccount({
    ...team,
    status: "SUSPENDED",
    leftoverAccessUsable: false,
    cursorPlanRemaining: 72,
    cursorAutoRemaining: 81,
    cursorApiRemaining: 40,
  });
  assert.equal(staleBars[0].remaining, null);
  assert.equal(staleBars[1].remaining, null);
  assert.equal(staleBars[2].remaining, null);
});

test("token validity bar uses update or create time when jwt iat is missing", () => {
  const { mapCursorAccountForUi, mapAccountForUi } = loadDesktopExports(bridge());
  const now = Math.floor(Date.now() / 1000);
  const issued = now - (30 * 86400);
  const expiry = now + (30 * 86400);
  const timeLeft = 30 * 86400;
  const config = {
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 10,
  };

  const cursor = mapCursorAccountForUi({
    id: "cursor_token_bar",
    email: "bar@example.com",
    token_updated_at: issued,
    token_status: {
      accessAvailable: true,
      refreshAvailable: true,
      expired: false,
      issuedAt: null,
      expiryDate: expiry,
      timeLeft,
    },
  }, null);
  assert.match(cursor.tokenValidity, /^剩余 /);
  assert.ok(cursor.tokenValidityPct > 45 && cursor.tokenValidityPct < 55);

  const fromCreatedMs = mapCursorAccountForUi({
    id: "cursor_token_created",
    email: "created@example.com",
    created_at: issued * 1000,
    token_status: {
      accessAvailable: true,
      refreshAvailable: true,
      expired: false,
      issuedAt: null,
      expiryDate: expiry,
      timeLeft,
    },
  }, null);
  assert.ok(fromCreatedMs.tokenValidityPct > 45 && fromCreatedMs.tokenValidityPct < 55);

  const unknown = mapCursorAccountForUi({
    id: "cursor_token_unknown",
    email: "unknown@example.com",
    token_status: {
      accessAvailable: true,
      refreshAvailable: true,
      expired: false,
      issuedAt: null,
      expiryDate: expiry,
      timeLeft,
    },
  }, null);
  assert.equal(unknown.tokenValidityPct, null);

  const noTime = mapCursorAccountForUi({
    id: "cursor_token_notime",
    email: "notime@example.com",
    token_status: {
      accessAvailable: true,
      refreshAvailable: true,
      expired: false,
      timeLeft: null,
    },
  }, null);
  assert.equal(noTime.tokenValidity, "有效期未知");
  assert.equal(noTime.tokenValidityPct, null);

  const prefersIat = mapCursorAccountForUi({
    id: "cursor_token_iat",
    email: "iat@example.com",
    token_updated_at: now,
    token_status: {
      accessAvailable: true,
      refreshAvailable: true,
      expired: false,
      issuedAt: issued,
      expiryDate: expiry,
      timeLeft,
    },
  }, null);
  assert.ok(prefersIat.tokenValidityPct > 45 && prefersIat.tokenValidityPct < 55);

  const expired = mapCursorAccountForUi({
    id: "cursor_token_expired",
    email: "expired@example.com",
    token_updated_at: issued,
    token_status: {
      accessAvailable: false,
      refreshAvailable: false,
      expired: true,
      expiryDate: issued + 100,
      timeLeft: -10,
    },
  }, null);
  assert.equal(expired.tokenValidityPct, 0);

  const codex = mapAccountForUi({
    id: "codex_token_bar",
    email: "codex-bar@example.com",
    created_at: issued,
    token_status: {
      accessAvailable: true,
      refreshAvailable: true,
      expired: false,
      issuedAt: null,
      expiryDate: expiry,
      timeLeft,
    },
  }, null, config);
  assert.ok(codex.tokenValidityPct > 45 && codex.tokenValidityPct < 55);
});

test("antigravity quota cards and float use official family labels", () => {
  const {
    mapAntigravityAccountForUi,
    quotaBarsForAccount,
    lensQuotaWindows,
    quotaHero,
    hideStaleQuota,
  } = loadDesktopExports(bridge());
  const mapped = mapAntigravityAccountForUi({
    id: "antigravity_one",
    email: "ag@example.com",
    plan_type: "PRO",
    quota: {
      tier: "PRO",
      gemini_weekly_remaining: 64,
      gemini_five_hour_remaining: 80,
      third_party_weekly_remaining: 90,
      third_party_five_hour_remaining: 25,
    },
    token_status: {
      accessAvailable: true,
      refreshAvailable: true,
      expired: false,
      timeLeft: 1800,
    },
  }, null);
  assert.equal(mapped.plan, "Pro");
  assert.equal(mapped.priority, "High");
  assert.equal(mapped.status, "ACTIVE");
  assert.equal(mapped.quotaKind, "antigravity");
  const bars = quotaBarsForAccount(mapped);
  assert.equal(bars.length, 4);
  assert.equal(bars[0].label, "Gemini 周限");
  assert.equal(bars[1].label, "Gemini 5 小时");
  assert.equal(bars[2].label, "Claude 与 GPT 周限");
  assert.equal(bars[3].label, "Claude 与 GPT 5 小时");
  assert.equal(bars[0].remaining, 64);
  assert.equal(bars[1].remaining, 80);
  assert.equal(bars[2].remaining, 90);
  assert.equal(bars[3].remaining, 25);
  const windows = lensQuotaWindows(mapped);
  assert.equal(windows.outerLabel, "Gemini");
  assert.equal(windows.innerLabel, "Claude 与 GPT");
  assert.equal(windows.outer, 64);
  assert.equal(windows.inner, 25);
  assert.equal(quotaHero(mapped).label, "Claude 与 GPT 5 小时");
  const failed = lensQuotaWindows({
    id: "antigravity_one",
    quotaKind: "antigravity",
    status: "SYNC_FAILED",
    leftoverAccessUsable: true,
  });
  assert.equal(failed.outer, null);
  assert.equal(failed.outerLabel, "Gemini");
  assert.equal(failed.innerLabel, "Claude 与 GPT");
  const expired = mapAntigravityAccountForUi({
    id: "antigravity_expired",
    email: "ag@example.com",
    quota: {
      gemini_weekly_remaining: 100,
      gemini_five_hour_remaining: 100,
      third_party_weekly_remaining: 100,
      third_party_five_hour_remaining: 100,
    },
    token_status: {
      accessAvailable: false,
      refreshAvailable: true,
      expired: true,
      timeLeft: -10,
    },
  }, null);
  assert.equal(expired.tokenExpired, true);
  assert.equal(hideStaleQuota(expired), true);
  assert.equal(quotaBarsForAccount(expired).every((bar) => bar.remaining == null), true);
});

test("antigravity plans map to Free Pro Ultra without Standard", () => {
  const { mapAntigravityAccountForUi, planLabel } = loadDesktopExports(bridge());
  const free = mapAntigravityAccountForUi({
    id: "antigravity_free",
    email: "ag@example.com",
    plan_type: "free-tier",
    quota: { tier: "free-tier" },
  }, null);
  assert.equal(free.plan, "Free");
  assert.equal(free.priority, "Normal");
  assert.equal(planLabel(free.plan), "免费");
  assert.notEqual(planLabel(free.plan), "Standard 套餐");

  const pro = mapAntigravityAccountForUi({
    id: "antigravity_pro",
    email: "ag@example.com",
    plan_type: "PRO",
  }, null);
  assert.equal(pro.plan, "Pro");
  assert.equal(planLabel(pro.plan), "Pro 套餐");

  const ultra = mapAntigravityAccountForUi({
    id: "antigravity_ultra",
    email: "ag@example.com",
    plan_type: "ULTRA",
    quota: { tier: "ULTRA" },
  }, null);
  assert.equal(ultra.plan, "Ultra");
  assert.equal(ultra.priority, "High");
  assert.equal(planLabel(ultra.plan), "Ultra 套餐");

  const empty = mapAntigravityAccountForUi({
    id: "antigravity_empty_plan",
    email: "ag@example.com",
  }, null);
  assert.equal(empty.plan, "");
  assert.equal(planLabel(empty.plan), "套餐");
});

test("antigravity user messages never show 已封号 or Cursor quota copy", () => {
  const { toAntigravityUserMessage, toUserMessage } = loadUserMessages();
  assert.equal(toAntigravityUserMessage("HTTP 401 account_disabled"), "Google 登录已失效，请重新授权");
  assert.equal(toAntigravityUserMessage("invalid_usage_json"), "这次没查清 Antigravity 额度，请稍后重试");
  assert.equal(toAntigravityUserMessage("Antigravity usage request failed: HTTP 500"), "这次没查清 Antigravity 额度，请稍后重试");
  assert.equal(toAntigravityUserMessage("Official Antigravity IDE did not exit: 4242"), "官方 Antigravity IDE 没能退出，请手动关掉后再切");
  assert.equal(toAntigravityUserMessage("官方 Antigravity IDE 还在占用登录库，请关掉后再切"), "官方 Antigravity IDE 还在占用登录库，请关掉后再切");
  assert.equal(toAntigravityUserMessage("antigravity_vscdb_busy"), "官方 Antigravity IDE 还在占用登录库，请关掉后再切");
  assert.equal(toAntigravityUserMessage("Could not enumerate official Antigravity IDE processes: timeout"), "无法读取官方 Antigravity IDE 进程");
  assert.equal(toAntigravityUserMessage("Could not read the official Antigravity OAuth client"), "没有找到官方 Antigravity 的授权配置，网页授权暂时不可用。");
  assert.equal(toAntigravityUserMessage("antigravity_oauth_client_missing"), "没有找到官方 Antigravity 的授权配置，网页授权暂时不可用。");
  assert.equal(toAntigravityUserMessage("OAuth callback was missing a code"), "回调缺少授权码，请关闭页面后重新点一次网页授权");
  assert.equal(toAntigravityUserMessage("OAuth callback state did not match"), "这次授权和当前等待的对不上，请关闭页面后重新点一次网页授权");
  assert.equal(toUserMessage("Cursor usage request failed: HTTP 500"), "这次没查清 Cursor 额度，请稍后重试");
});

test("antigravity unknown email is shown as 未读取邮箱", () => {
  const { mapAntigravityAccountForUi } = loadDesktopExports(bridge());
  const mapped = mapAntigravityAccountForUi({
    id: "antigravity_unknown",
    email: "unknown",
    plan_type: "FREE",
    token_status: {
      accessAvailable: true,
      refreshAvailable: true,
      expired: false,
      timeLeft: 1800,
    },
  }, null);
  assert.equal(mapped.email, "未读取邮箱");
  assert.equal(mapped.name, "未读取邮箱");
  const empty = mapAntigravityAccountForUi({
    id: "antigravity_empty",
    email: "",
    plan_type: "PRO",
  }, null);
  assert.equal(empty.email, "未读取邮箱");
  assert.equal(empty.status, "READY");
  const failed = mapAntigravityAccountForUi({
    id: "antigravity_failed",
    email: "unknown",
    quota_error: { message: "Antigravity usage request failed: HTTP 500" },
  }, null);
  assert.equal(failed.status, "SYNC_FAILED");
  assert.equal(failed.warning, "这次没查清 Antigravity 额度，请稍后重试。");
  assert.doesNotMatch(failed.warning, /已封号/);
});

test("first-paint cursor and antigravity lists can skip official sync", async () => {
  const calls = [];
  const { desktopApi } = loadDesktopExports(bridge({
    listCursorAccounts: (options) => {
      calls.push(["cursor:list", options]);
      return ok([]);
    },
    getCurrentCursorAccount: (options) => {
      calls.push(["cursor:current", options]);
      return ok(null);
    },
    getCursorOAuthStatus: () => ok({ status: "idle", pending: false }),
    getCursorStatus: () => ok({ installed: true }),
    listAntigravityAccounts: (options) => {
      calls.push(["antigravity:list", options]);
      return ok([]);
    },
    getCurrentAntigravityAccount: (options) => {
      calls.push(["antigravity:current", options]);
      return ok(null);
    },
    getAntigravityOAuthStatus: () => ok({ status: "idle", pending: false }),
    getAntigravityStatus: () => ok({ installed: true }),
  }));
  await desktopApi.loadCursorState({ skipOfficialSync: true });
  await desktopApi.loadAntigravityState({ skipOfficialSync: true });
  assert.deepEqual(calls.find((item) => item[0] === "cursor:list")[1], { skipOfficialSync: true });
  assert.deepEqual(calls.find((item) => item[0] === "cursor:current")[1], { skipOfficialSync: true });
  assert.deepEqual(calls.find((item) => item[0] === "antigravity:list")[1], { skipOfficialSync: true });
  assert.deepEqual(calls.find((item) => item[0] === "antigravity:current")[1], { skipOfficialSync: true });
});

test("desktop snapshot replaces the dashboard fanout when the bridge provides it", async () => {
  const calls = [];
  const { desktopApi } = loadDesktopExports(bridge({
    getDesktopSnapshot: (options) => {
      calls.push(options);
      return ok({
        accounts: [{
          id: "one",
          email: "one@example.com",
          plan_type: "plus",
          token_status: {
            accessAvailable: true,
            refreshAvailable: true,
            expired: false,
            timeLeft: 3600,
          },
        }],
        currentAccount: null,
        cursorAccounts: [],
        currentCursorAccount: null,
        antigravityAccounts: [],
        currentAntigravityAccount: null,
        daemon: { running: false, syncIntervalMinutes: 1 },
        config: {
          enabled: false,
          primary_threshold: 20,
          secondary_threshold: 30,
          account_scope_mode: "all",
          selected_account_ids: [],
          sync_interval_minutes: 1,
        },
        oauthStatus: { status: "idle", pending: false },
        cursorOAuthStatus: { status: "idle", pending: false },
        antigravityOAuthStatus: { status: "idle", pending: false },
        authState: { status: "aligned", requiresResolution: false },
      });
    },
    listAccounts: () => {
      throw new Error("fanout listAccounts should not run");
    },
  }));
  const bundle = await desktopApi.loadDesktopSnapshot({ skipOfficialSync: true });
  assert.deepEqual(calls, [{ skipOfficialSync: true }]);
  assert.equal(bundle.dashboard.accounts[0].email, "one@example.com");
  assert.equal(bundle.cursor.accounts.length, 0);
  assert.equal(bundle.antigravity.accounts.length, 0);
});

test("renderer dashboard state lives in a useSyncExternalStore desktop store", () => {
  const store = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "state", "desktop-store.ts"), "utf8");
  const app = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "App.tsx"), "utf8");
  assert.match(store, /useSyncExternalStore/);
  assert.match(store, /codexAccounts/);
  assert.match(store, /cursorAccounts/);
  assert.match(store, /antigravityAccounts/);
  assert.match(store, /oauthStatus/);
  assert.match(store, /daemonState/);
  assert.doesNotMatch(store, /from ['\"]zustand['\"]/);
  assert.match(app, /useDesktopStore/);
  assert.match(app, /from '\.\/state\/desktop-store'/);
});

function loadProductAdapter() {
  const desktop = loadDesktopExports(bridge());
  const userMessages = loadUserMessages();
  const productsPath = path.join(projectRoot, "src", "renderer-react", "data", "products.ts");
  const productsModule = { exports: {} };
  vm.runInNewContext(compileTs(productsPath), {
    module: productsModule,
    exports: productsModule.exports,
    localStorage: { getItem() { return null; } },
  }, { filename: productsPath });
  const adapterPath = path.join(projectRoot, "src", "renderer-react", "api", "product-adapter.ts");
  const module = { exports: {} };
  vm.runInNewContext(compileTs(adapterPath), {
    module,
    exports: module.exports,
    require(id) {
      if (id === "./desktop") return desktop;
      if (id === "./user-messages") return userMessages;
      if (id === "../data/products") return productsModule.exports;
      if (id === "../types") return {};
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename: adapterPath });
  return { ...module.exports, ...desktop };
}

test("oauth and import copy distinguish updated existing accounts", () => {
  const { oauthFinishedCopy, importAccountCopy } = loadProductAdapter();
  assert.equal(oauthFinishedCopy({
    product: "antigravity",
    email: "same@example.com",
    updated: true,
  }), "已更新已有账号 same@example.com");
  assert.equal(oauthFinishedCopy({
    product: "cursor",
    email: "new@example.com",
  }), "已添加 new@example.com");
  assert.equal(oauthFinishedCopy({
    product: "codex",
    email: "old@example.com",
    isReauth: true,
  }), "已重新授权 old@example.com");
  assert.equal(importAccountCopy({
    product: "antigravity",
    email: "same@example.com",
    updated: true,
  }).message, "已更新已有账号 same@example.com");
  assert.equal(importAccountCopy({
    product: "cursor",
    email: "fresh@example.com",
  }).message, "已导入 fresh@example.com");
});

test("antigravity empty refresh maps to sync-failed not 暂无此项", () => {
  const { mapAntigravityAccountForUi, cursorEmptyQuotaText, accountHasVisibleQuota } = loadDesktopExports(bridge());
  const mapped = mapAntigravityAccountForUi({
    id: "antigravity_empty",
    email: "empty@example.com",
    quota: {},
    quota_error: { code: "probe_failed", message: "这次没查清额度，请稍后重试。" },
    token_status: {
      accessAvailable: true,
      refreshAvailable: true,
      expired: false,
      timeLeft: 2400,
    },
  }, null);
  assert.equal(mapped.status, "SYNC_FAILED");
  assert.equal(cursorEmptyQuotaText(mapped), "这次没查清");
  assert.equal(accountHasVisibleQuota(mapped), false);
});

test("antigravity preserved quota_error after upsert stays 这次没查清", () => {
  const { mapAntigravityAccountForUi, cursorEmptyQuotaText } = loadDesktopExports(bridge());
  const mapped = mapAntigravityAccountForUi({
    id: "antigravity_reimport",
    email: "keep@example.com",
    quota: null,
    quota_error: { code: "probe_failed", message: "这次没查清额度，请稍后重试。" },
    probe: { status: "probe_failed" },
    token_status: {
      accessAvailable: true,
      refreshAvailable: true,
      expired: false,
      timeLeft: 2400,
    },
  }, null);
  assert.equal(mapped.status, "SYNC_FAILED");
  assert.equal(cursorEmptyQuotaText(mapped), "这次没查清");
  assert.notEqual(cursorEmptyQuotaText(mapped), "暂无此项");
});

test("withCurrentFlag only moves the current badge", () => {
  const { withCurrentFlag } = loadDesktopExports(bridge());
  const next = withCurrentFlag([
    { id: "tam", email: "tam@example.com", isCurrent: true },
    { id: "chr", email: "chr@example.com", isCurrent: false },
  ], "chr");
  assert.equal(next[0].isCurrent, false);
  assert.equal(next[1].isCurrent, true);
  assert.equal(next[1].email, "chr@example.com");
});

test("cursor switch UI flips current without waiting on official sync", () => {
  const app = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "App.tsx"), "utf8");
  const handlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc-handlers.js"), "utf8");
  assert.match(app, /applyCurrentAccountBadge\(kind, id\)/);
  assert.match(app, /loadDashboardState\(false, \{ skipOfficialSync: true \}\)/);
  assert.match(app, /payload\?\.current\) applyCurrentAccountBadge\(payload\.product, payload\.account\?\.id\)/);
  assert.match(handlers, /emitAccountUpdated\("cursor", publicResult, \{ current: true \}\)/);
});

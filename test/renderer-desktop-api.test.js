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
    "该账号需要重新授权后才能刷新 Token。",
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
    "额度暂时没刷到，登录还在。请检查代理后再刷新，或稍后再试。",
  );
  assert.doesNotMatch(snapshot.accounts[0].quotaError || "", /ERR_CONNECTION/);
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
  assert.equal(planLabel("Plus"), "Plus Plan");
  assert.equal(planLabel("Pro"), "Pro Plan");
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
});

test("last check caption avoids repeating 检查 when no run has happened", () => {
  const { lastCheckCaption } = loadDesktopExports(bridge());
  assert.equal(lastCheckCaption(""), "暂无检查记录");
  assert.equal(lastCheckCaption("尚未检查"), "暂无检查记录");
  assert.equal(lastCheckCaption("08/14 22:15"), "最近检查：08/14 22:15");
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
  assert.equal(quotaWindowSummary("fiveHour", missingFiveHour).text, "上游暂未提供");
  assert.equal(quotaWindowSummary("weekly", missingFiveHour).text, "41%");
  assert.equal(quotaScopeCaption(missingFiveHour).shared, null);
  assert.equal(
    quotaScopeCaption(missingFiveHour).rows.map((row) => `${row.label}:${row.text}`).join("|"),
    "5 小时:上游暂未提供|周额度:41%",
  );
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
    "该账号需要重新授权后才能写入官方 Codex",
  );
  assert.equal(toUserMessage("Official Codex authentication is missing."), "官方 Codex 当前没有登录");
  assert.equal(
    toUserMessage("Quota authorization could not be repaired: HTTP 401 refresh_token_invalidated"),
    "额度授权无法修复，刷新令牌已失效，请重新授权",
  );
  assert.equal(toUserMessage("OAuth authorization timed out"), "授权超时，请重新点一次");
  assert.equal(toUserMessage("Waiting for browser authorization."), "请在浏览器完成授权");
  assert.equal(toUserMessage("OAuth authorization was cancelled"), "授权已取消");
  assert.equal(toUserMessage("disabled"), "全局开关已关闭，不会切号");
  assert.equal(toUserMessage("已从管理器中删除账号 a@b.com。"), "已从管理器中删除账号 a@b.com。");
  assert.equal(toUserMessage("SomeUnknownEnglishFailureXYZ"), "操作失败，请稍后重试");
  assert.equal(
    toUserMessage("网络请求失败 (chatgpt.com)。已尝试可用网络栈。如果正在使用代理/TUN，请确认它允许 Codex Account Manager 访问 OpenAI。详情：Electron: Error: Electron network failed after retry: Error: net::ERR_CONNECTION_TIMED_OUT | Node: ETIMEDOUT"),
    "额度暂时没刷到，登录还在。请检查代理后再刷新，或稍后再试。",
  );
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
  const { formatDuration, needsHandling } = loadDesktopExports(bridge());
  assert.equal(formatDuration(45), "1 分钟");
  assert.equal(formatDuration(3600), "1 小时");
  assert.equal(formatDuration(3659), "1 小时 1 分钟");
  assert.equal(formatDuration(86400 * 8 + 3600 * 3), "8 天 3 小时");
  assert.equal(formatDuration(-1), "已过期");
  assert.equal(needsHandling({ status: "SUSPENDED" }), true);
  assert.equal(needsHandling({ status: "EXPIRED" }), true);
  assert.equal(needsHandling({ status: "SYNC_FAILED" }), true);
  assert.equal(needsHandling({ status: "WARNING" }), false);
  assert.equal(needsHandling({ status: "LOW_QUOTA" }), false);
  assert.equal(needsHandling({ status: "ACTIVE" }), false);
});

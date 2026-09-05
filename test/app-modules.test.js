const assert = require("node:assert/strict");
// Modules load in a vm realm, so their arrays and objects have foreign
// prototypes; compare structure only.
const sameShape = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const appDir = path.join(projectRoot, "src", "renderer-react", "app");

function loadTs(file, requireMap = {}) {
  const sourcePath = path.join(appDir, file);
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(id) {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require: ${id}`);
    },
    Promise,
    Date,
    Math,
    String,
    console,
  }, { filename: sourcePath });
  return module.exports;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test("config saves run one after another and only the newest reloads", async () => {
  const { ConfigSaveQueue } = loadTs("config-save-queue.ts");
  const queue = new ConfigSaveQueue();
  const first = deferred();
  const second = deferred();
  const order = [];

  const firstResult = queue.enqueue(() => { order.push("first-start"); return first.promise; });
  const secondResult = queue.enqueue(() => { order.push("second-start"); return second.promise; });
  await flush();
  assert.equal(queue.pending, 2, "both saves count as in flight while queued");
  sameShape(order, ["first-start"], "the second save waits for the first");

  first.resolve();
  const firstOutcome = await firstResult;
  sameShape(firstOutcome, { ok: true, latest: false, error: null });
  assert.equal(queue.pending, 1);
  await flush();
  sameShape(order, ["first-start", "second-start"]);

  second.resolve();
  const secondOutcome = await secondResult;
  sameShape(secondOutcome, { ok: true, latest: true, error: null });
  assert.equal(queue.pending, 0, "pending drops before the caller reloads");
});

test("a failed save reports the error, stays latest, and does not block later saves", async () => {
  const { ConfigSaveQueue } = loadTs("config-save-queue.ts");
  const queue = new ConfigSaveQueue();
  const boom = new Error("disk full");
  const failed = await queue.enqueue(() => Promise.reject(boom));
  assert.equal(failed.ok, false);
  assert.equal(failed.latest, true);
  assert.equal(failed.error, boom);
  assert.equal(queue.pending, 0);

  const recovered = await queue.enqueue(() => Promise.resolve("saved"));
  sameShape(recovered, { ok: true, latest: true, error: null });
});

test("the activity feed is capped and toasts are removed by id", () => {
  const { prependLog, appendToast, removeToast, LOG_FEED_LIMIT, makeEntryId } = loadTs("notifications.ts");
  let logs = [];
  for (let i = 0; i < LOG_FEED_LIMIT + 25; i++) {
    logs = prependLog(logs, { id: `l${i}`, timestamp: "", message: `m${i}`, type: "info" });
  }
  assert.equal(logs.length, LOG_FEED_LIMIT);
  assert.equal(logs[0].id, `l${LOG_FEED_LIMIT + 24}`, "newest entry first");
  assert.equal(logs.at(-1).id, "l25", "oldest entries fall off");

  const toasts = appendToast(appendToast([], { id: "a", msg: "x", type: "info" }), { id: "b", msg: "y", type: "error" });
  sameShape(removeToast(toasts, "a").map((toast) => toast.id), ["b"]);
  sameShape(removeToast(toasts, "zzz").map((toast) => toast.id), ["a", "b"]);

  const one = makeEntryId("toast");
  const two = makeEntryId("toast");
  assert.match(one, /^toast_\d+_[a-z0-9]+$/);
  assert.notEqual(one, two);
});

test("settings derive install, channel, and update status from desktop state", () => {
  const { settingsFromDesktopState, latestStatusForUi, updateChannelForUi } = loadTs("dashboard-settings.ts", {
    "../data/mockData": { INITIAL_SETTINGS: { version: "0.0.0-mock" } },
  });
  assert.equal(updateChannelForUi({ channel: "dev" }), "Developer Channel");
  assert.equal(updateChannelForUi({ channel: "STABLE" }), "Stable Channel");
  assert.equal(updateChannelForUi(null), "Beta Channel");

  assert.equal(latestStatusForUi(null), "未知");
  assert.equal(latestStatusForUi({ status: "error", error: "" }), "检查更新失败");
  assert.equal(latestStatusForUi({ status: "downloaded" }), "可安装");
  assert.equal(latestStatusForUi({ status: "checking" }), "检查中");
  assert.equal(latestStatusForUi({ status: "disabled" }), "更新已禁用");
  assert.equal(latestStatusForUi({ status: "idle", message: "" }), "已是最新");

  const settings = settingsFromDesktopState(
    { version: "2.0.7" },
    { installed: true },
    { status: "idle", channel: "stable" },
    { installed: false, vscdbPresent: true },
    { installed: true, vscdbPresent: false },
  );
  sameShape(settings, {
    clientDetected: true,
    cursorDetected: false,
    cursorHasLocalLogin: true,
    antigravityDetected: true,
    antigravityHasLocalLogin: false,
    updateChannel: "Stable Channel",
    version: "2.0.7",
    latestStatus: "已是最新",
  });
  assert.equal(settingsFromDesktopState(null, null, null).version, "0.0.0-mock");
});

test("App no longer inlines the extracted pieces", () => {
  const app = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "App.tsx"), "utf8");
  assert.doesNotMatch(app, /function settingsFromDesktopState/);
  assert.doesNotMatch(app, /const toastTimers = useRef/);
  assert.doesNotMatch(app, /configSaveRevision|configSavesPending|configSaveQueue/);
  assert.doesNotMatch(app, /const applyDashboardState|const loadDashboardStateOnce|const queueQuotaAutoSync = /);
  assert.doesNotMatch(app, /const reportOAuthFinished|const markOAuthPending|pollOAuthStatus/);
  assert.doesNotMatch(app, /const handleRefreshAll = |const performAccountSwitch = |const saveDaemonConfig = /);
  assert.doesNotMatch(app, /desktopApi\.subscribe\(/);
  for (const hook of ["useNotifications", "useSharedRefs", "useDashboardLoader", "useOAuthFlow", "useDesktopEvents", "useAccountActions"]) {
    assert.match(app, new RegExp(`${hook}\\(\\{`), `${hook} must be wired in App`);
  }
  const lines = app.split(/\r?\n/).length;
  assert.ok(lines < 900, `App.tsx should stay a composition root, got ${lines} lines`);
});

// ---- snapshot rules -------------------------------------------------------

const desktopStub = {
  clampSyncIntervalMinutes: (value) => Math.min(60, Math.max(1, Math.round(Number(value) || 1))),
  daemonErrorCopy: (payload) => `failures:${payload.failures.map((item) => item.code || item.message).join("+")}`,
  formatDateTime: (value) => `at:${value}`,
  isManagedProductAccount: (account) => /^(cursor|antigravity)_/.test(String(account.id)),
  needsQuotaAutoSync: (account, staleMs) => account.stale === true && staleMs > 0,
  quotaAutoSyncStaleMs: (_account, minutes) => (minutes ?? 10) * 60_000,
};
const messagesStub = { toUserMessage: (raw) => (raw && typeof raw === "object" ? `code:${raw.code}` : `msg:${raw}`) };

function loadSnapshotModule() {
  return loadTs("snapshot.ts", {
    "../api/desktop": desktopStub,
    "../api/user-messages": messagesStub,
  });
}

test("a pending browser authorization survives a snapshot taken before the engine saw it", () => {
  const { mergeOAuthStatus } = loadSnapshotModule();
  const local = { status: "pending", pending: true };
  const idle = { status: "idle", pending: false };
  const completed = { status: "completed", pending: false };
  assert.equal(mergeOAuthStatus(local, idle), local, "idle from disk must not hide the pending status just shown");
  assert.equal(mergeOAuthStatus(local, completed), completed, "a settled status always wins");
  assert.equal(mergeOAuthStatus(null, idle), idle);
  assert.equal(mergeOAuthStatus({ status: "completed", pending: false }, idle), idle, "only a local pending is kept");
});

test("the landing product follows whichever authorization is pending", () => {
  const { landingProductFor } = loadSnapshotModule();
  const none = { codexPending: false, cursorPending: false, antigravityPending: false };
  assert.equal(landingProductFor(none, "cursor"), "cursor");
  assert.equal(landingProductFor({ ...none, codexPending: true }, "cursor"), "codex");
  assert.equal(landingProductFor({ ...none, codexPending: true, cursorPending: true }, "codex"), "cursor");
  assert.equal(landingProductFor({ codexPending: true, cursorPending: true, antigravityPending: true }, "codex"), "antigravity");
});

test("daemon state keeps the interval just chosen while its save is in flight", () => {
  const { daemonStateFromSnapshot } = loadSnapshotModule();
  const snapshot = {
    daemonRunning: true,
    daemonSyncInterval: 5,
    daemonLastRunAt: 1700000000000,
    daemonLastSuccessAt: 1700000000000,
    daemonLastError: "Daemon error",
    daemonPausedReason: "auth_conflict",
  };
  const settled = daemonStateFromSnapshot(snapshot, { saveInFlight: false, localConfig: { enabled: true, sync_interval_minutes: 30 } });
  sameShape(settled, {
    status: "Running",
    syncInterval: 5,
    lastChecked: "at:1700000000000",
    lastSuccessAt: 1700000000000,
    lastError: "msg:Daemon error",
    pausedReason: "msg:auth_conflict",
  });
  const inFlight = daemonStateFromSnapshot(snapshot, { saveInFlight: true, localConfig: { enabled: true, sync_interval_minutes: 30 } });
  assert.equal(inFlight.syncInterval, 30, "the snapshot's stale interval must not flash back during a save");
  // A coded last error translates by code; per-account failures win over the joined string.
  const coded = daemonStateFromSnapshot({ ...snapshot, daemonLastErrorCode: "account_index_invalid" }, { saveInFlight: false, localConfig: { enabled: true } });
  assert.equal(coded.lastError, "code:account_index_invalid");
  const perAccount = daemonStateFromSnapshot({
    ...snapshot,
    daemonLastFailures: [{ email: "a@b", code: "token_refresh_failed", message: "x" }, { email: null, message: "plain" }],
  }, { saveInFlight: false, localConfig: { enabled: true } });
  assert.equal(perAccount.lastError, "failures:token_refresh_failed+plain");
  const stopped = daemonStateFromSnapshot({ daemonRunning: false, daemonSyncInterval: 5 }, { saveInFlight: false, localConfig: { enabled: false } });
  assert.equal(stopped.status, "Stopped");
  assert.equal(stopped.lastChecked, "");
  assert.equal(stopped.lastError, null);
  assert.equal(stopped.pausedReason, null);
});

test("background quota sync skips busy accounts and, during a conflict, Codex accounts", () => {
  const { staleAccountsForAutoSync } = loadSnapshotModule();
  const accounts = [
    { id: "codex_a", stale: true },
    { id: "codex_b", stale: true },
    { id: "cursor_c", stale: true },
    { id: "antigravity_d", stale: false },
  ];
  const calm = staleAccountsForAutoSync(accounts, { authBlocked: false, inFlightIds: new Set(["codex_b"]), syncIntervalMinutes: 10 });
  sameShape(calm.map((account) => account.id), ["codex_a", "cursor_c"]);
  const conflict = staleAccountsForAutoSync(accounts, { authBlocked: true, inFlightIds: new Set(), syncIntervalMinutes: 10 });
  sameShape(conflict.map((account) => account.id), ["cursor_c"], "Codex quota reads wait for the official login to be resolved");
  assert.equal(staleAccountsForAutoSync(accounts, { authBlocked: false, inFlightIds: new Set(), syncIntervalMinutes: undefined }).length, 3, "a missing interval falls back to the default");
});

test("dashboard loads stay ordered and a superseded load hands back the fresher snapshot", async () => {
  const { LoadSequence } = loadSnapshotModule();
  const loads = new LoadSequence();

  const first = loads.begin();
  const second = loads.begin();
  assert.equal(loads.isCurrent(first), false, "an older load must not apply its snapshot");
  assert.equal(loads.isCurrent(second), true);

  // The first load lost the race (null); the caller should still receive the
  // second load's snapshot instead of "still updating".
  const secondRun = Promise.resolve({ from: "second" });
  loads.track(secondRun);
  const settledFirst = await loads.settle(Promise.resolve(null), first);
  sameShape(settledFirst, { from: "second" });

  // A current load returns its own result.
  const third = loads.begin();
  const thirdRun = Promise.resolve({ from: "third" });
  loads.track(thirdRun);
  sameShape(await loads.settle(thirdRun, third), { from: "third" });

  // When every newer load also failed there is nothing fresher to return.
  const fourth = loads.begin();
  loads.begin();
  const failedNewest = Promise.resolve(null);
  loads.track(failedNewest);
  assert.equal(await loads.settle(Promise.resolve(null), fourth), null);

  // Starting a browser authorization invalidates whatever is in flight.
  const fifth = loads.begin();
  loads.invalidate();
  assert.equal(loads.isCurrent(fifth), false);
});

// ---- float lens model -----------------------------------------------------

function loadLensModel(overrides = {}) {
  const managed = (account) => /^(cursor|antigravity)_/.test(String(account?.id || ""));
  return loadTs("float-lens-model.ts", {
    "../api/desktop": {
      antigravityQuotaFamilies: (account) => account.families || [],
      formatResetLine: (value) => (value ? `reset:${value}` : ""),
      hideStaleQuota: (account) => account?.status === "SUSPENDED" || account?.status === "BANNED",
      isManagedProductAccount: managed,
      lensQuotaWindows: (account) => account?.windows || { outer: null, inner: null, outerLabel: "周额度", innerLabel: "5 小时", outerReset: null, innerReset: null },
      planCaption: (account) => account.plan || "Free",
      quotaHero: (account) => ({ key: account?.heroKey || "weekly" }),
      statusTextForAccount: (account) => `status:${account.status}`,
      STATUS_TEXT: { BANNED: "已封号" },
      ...overrides,
    },
    "../api/product-adapter": {
      isManagedProduct: (product) => product === "cursor" || product === "antigravity",
      toProductUserMessage: (product, raw) => `${product}:${raw && typeof raw === "object" ? raw.code || raw.message : raw}`,
    },
  });
}

test("the lens picks the current account, keeps the viewed one, and reads windows defensively", () => {
  const model = loadLensModel();
  const accounts = [{ id: "codex_a" }, { id: "codex_b", isCurrent: true }, { id: "codex_c" }];
  assert.equal(model.pickViewedId(accounts, "codex_c"), "codex_c", "a still-listed viewed account stays viewed");
  assert.equal(model.pickViewedId(accounts, "codex_gone"), "codex_b", "otherwise the current account");
  assert.equal(model.pickViewedId([{ id: "codex_only" }], null), "codex_only");
  assert.equal(model.pickViewedId([], null), null);

  assert.equal(model.tighterRemaining(null, null), null, "missing windows never become zero");
  assert.equal(model.tighterRemaining(null, 40), 40);
  assert.equal(model.tighterRemaining(70, null), 70);
  assert.equal(model.tighterRemaining(70, 40), 40);

  const full = model.ringLength(10);
  assert.equal(model.arcOffset(10, null), full, "unknown percentage draws an empty ring");
  assert.equal(model.arcOffset(10, Number.NaN), full);
  assert.equal(model.arcOffset(10, 100), 0);
  assert.equal(model.arcOffset(10, 150), 0, "clamped above 100");
  assert.equal(model.arcOffset(10, -5), full, "clamped below 0");
  assert.ok(Math.abs(model.arcOffset(10, 25) - full * 0.75) < 1e-9);

  sameShape(model.splitEmail("someone@example.com"), { local: "someone", domain: "@example.com" });
  sameShape(model.splitEmail("no-at-sign"), { local: "no-at-sign", domain: "" });
  sameShape(model.splitEmail("trailing@"), { local: "trailing@", domain: "" });
  sameShape(model.splitEmail(null), { local: "", domain: "" });

  assert.equal(model.tokenRemainLine("剩余 3 天"), "登录还剩 3 天");
  assert.equal(model.tokenRemainLine("已过期"), "登录已过期");
  assert.equal(model.tokenRemainLine("有效期未知"), "登录有效期未知");
  assert.equal(model.tokenRemainLine(""), "");
});

test("the lens explains why refresh or switch is blocked without ever calling a Cursor account banned", () => {
  const model = loadLensModel();
  assert.equal(model.blockedRefreshText({ id: "codex_x", status: "BANNED" }), "账号已封号，无法刷新额度");
  assert.equal(model.blockedRefreshText({ id: "cursor_x", status: "BANNED" }), "该账号需要重新授权后才能刷新额度");
  assert.equal(model.blockedSwitchText({ id: "codex_x", status: "BANNED" }), "账号已封号，无法切换");
  assert.equal(model.blockedSwitchText({ id: "cursor_x", status: "SUSPENDED", tokenAccessAvailable: false }), "该账号没有可用登录令牌，无法切换");
  assert.equal(model.blockedSwitchText({ id: "cursor_x", status: "SUSPENDED" }), "该账号需要重新授权后才能切换");
  assert.equal(model.statusBadgeText({ id: "codex_x", status: "BANNED" }), "已封号");
  assert.equal(model.statusBadgeText({ id: "cursor_x", status: "BANNED" }), null, "Cursor never uses the Codex ban bucket");
  assert.equal(model.statusBadgeText({ id: "codex_x", status: "SYNC_FAILED" }), "status:SYNC_FAILED");
  assert.equal(model.statusBadgeText({ id: "codex_x", status: "ACTIVE" }), null);
  assert.equal(model.accountErrorText("cursor", { code: "cursor_vscdb_busy", message: "x" }), "cursor:cursor_vscdb_busy");
});

test("the lens view hides quota for unusable logins and pairs dials per product", () => {
  const model = loadLensModel();
  const codex = { id: "codex_a", status: "ACTIVE", email: "a@b.com", plan: "Plus", isCurrent: true, heroKey: "fiveHour",
    windows: { outer: 80, inner: 45, outerLabel: "周额度", innerLabel: "5 小时", outerReset: "w", innerReset: "h" } };
  const view = model.deriveLensView("codex", codex);
  assert.equal(view.showPair, false, "Codex is a single dial");
  assert.equal(view.isCurrent, true);
  assert.equal(view.outerValue, 80);
  assert.equal(view.innerValue, 45);
  assert.equal(view.showInner, true);
  assert.equal(view.caption, "reset:h", "the hero window's reset line is the caption");
  assert.equal(view.planBadge, "Plus");
  assert.equal(view.statusBadge, null);
  assert.equal(view.emptyKind, null);
  sameShape(view.emailParts, { local: "a", domain: "@b.com" });

  const suspended = model.deriveLensView("codex", { ...codex, status: "SUSPENDED" });
  assert.equal(suspended.hideQuota, true);
  assert.equal(suspended.outerValue, null);
  assert.equal(suspended.showOuter, false);
  assert.equal(suspended.caption, "", "no reset line for a login that must be renewed");
  assert.equal(suspended.emptyKind, "reauth");
  assert.equal(model.deriveLensView("codex", { ...codex, status: "BANNED" }).emptyKind, "banned");
  assert.equal(model.deriveLensView("cursor", { ...codex, id: "cursor_a", status: "BANNED" }).emptyKind, "reauth", "a banned Cursor account is treated as needing reauth");

  const failed = model.deriveLensView("codex", { ...codex, status: "SYNC_FAILED" });
  assert.equal(failed.hideFailedQuota, true);
  assert.equal(failed.outerValue, null, "a failed sync shows no stale numbers");
  assert.equal(failed.hideQuota, false, "but the login is still usable");

  const cursor = model.deriveLensView("cursor", { ...codex, id: "cursor_a", tokenValidity: "剩余 2 天",
    windows: { outer: 60, inner: 30, outerLabel: "套餐", innerLabel: "Auto", outerReset: null, innerReset: null } });
  assert.equal(cursor.showPair, true, "Cursor shows plan and Auto side by side");
  assert.equal(cursor.caption, "登录还剩 2 天", "managed products lead with the login lifetime");
  sameShape(cursor.pairDials.map((dial) => [dial.heroPercent, dial.heroLabel]), [[60, "套餐"], [30, "Auto"]]);
  assert.equal(model.deriveLensView("cursor", { ...codex, id: "cursor_a", status: "SUSPENDED" }).showPair, false);

  const antigravity = model.deriveLensView("antigravity", {
    id: "antigravity_a", status: "ACTIVE", email: "g@x.com",
    families: [
      { title: "Gemini", weekly: { remaining: 90 }, fiveHour: { remaining: 40 } },
      { title: "Claude 与 GPT", weekly: { remaining: null }, fiveHour: { remaining: 55 } },
    ],
  });
  assert.equal(antigravity.showPair, true);
  sameShape(antigravity.pairDials.map((dial) => [dial.heroLabel, dial.heroPercent, dial.weekly, dial.fiveHour]), [
    ["Gemini", 40, 90, 40],
    ["Claude 与 GPT", 55, null, 55],
  ]);
  assert.equal(model.deriveLensView("antigravity", null).showPair, false, "nothing viewed, nothing paired");
  const failedAntigravity = model.deriveLensView("antigravity", {
    id: "antigravity_a", status: "SYNC_FAILED", families: [{ title: "Gemini", weekly: { remaining: 90 }, fiveHour: { remaining: 40 } }],
  });
  sameShape(failedAntigravity.pairDials.map((dial) => dial.heroPercent), [null], "a failed sync blanks the family dials too");
});

// ---- oauth flow rules -----------------------------------------------------

function loadOAuthFlowModule() {
  return loadTs("oauth-flow.ts", {
    "../api/product-adapter": {
      oauthFinishedCopy: (input) => JSON.stringify(input),
    },
    "../api/user-messages": messagesStub,
  });
}

test("only one browser authorization runs at a time and stale completions are not re-reported", () => {
  const { anyOAuthPending, oauthStatusEndedThisFlow, oauthReportKey } = loadOAuthFlowModule();
  assert.equal(anyOAuthPending([null, { pending: false }, undefined]), false);
  assert.equal(anyOAuthPending([null, { pending: true, status: "pending" }]), true);

  assert.equal(oauthStatusEndedThisFlow({ status: "cancelled", pending: false }), true);
  assert.equal(oauthStatusEndedThisFlow({ status: "error", pending: false }), true);
  assert.equal(oauthStatusEndedThisFlow({ status: "completed", pending: false }), false, "a completed status after a rejected call belongs to an earlier flow");
  assert.equal(oauthStatusEndedThisFlow({ status: "pending", pending: true }), false);
  assert.equal(oauthStatusEndedThisFlow(null), false);

  const base = { status: "completed", pending: false, result: { accountId: "a1", email: "a@b" } };
  assert.equal(oauthReportKey("codex", base), oauthReportKey("codex", { ...base }));
  assert.notEqual(oauthReportKey("codex", base), oauthReportKey("cursor", base));
  assert.notEqual(oauthReportKey("codex", base), oauthReportKey("codex", { ...base, result: { ...base.result, mismatch: true } }));
  assert.notEqual(oauthReportKey("codex", base), oauthReportKey("codex", { ...base, targetAccountId: "a1" }));
});

test("a finished authorization is turned into the right notices and follow-ups", () => {
  const { planOAuthFinish, pendingOAuthStatus } = loadOAuthFlowModule();
  assert.equal(planOAuthFinish("codex", { status: "pending", pending: true }), null);
  assert.equal(planOAuthFinish("codex", { status: "idle", pending: false }), null);

  const cancelled = planOAuthFinish("cursor", { status: "cancelled", pending: false });
  sameShape(cancelled.notices, [{ level: "warning", message: "授权已取消。" }]);

  const failed = planOAuthFinish("codex", { status: "error", pending: false, message: "boom" });
  sameShape(failed.notices, [{ level: "warning", message: "msg:boom" }]);
  const expired = planOAuthFinish("codex", { status: "expired", pending: false });
  sameShape(expired.notices, [{ level: "warning", message: "msg:授权未完成。" }]);
  // A coded status hands the code and the message to the translator together.
  const coded = planOAuthFinish("codex", { status: "expired", pending: false, code: "oauth_expired", message: "The pending OAuth authorization expired." });
  sameShape(coded.notices, [{ level: "warning", message: "code:oauth_expired" }]);

  // A mismatch on Codex still badges the account the engine switched to.
  const mismatch = planOAuthFinish("codex", {
    status: "completed",
    pending: false,
    result: { accountId: "acc", email: "x@y", mismatch: true },
  });
  assert.equal(mismatch.badgeAccountId, "acc");
  assert.equal(mismatch.notices[0].level, "warning");
  assert.match(mismatch.notices[0].message, /"mismatch":true/);
  const mismatchNotSwitched = planOAuthFinish("codex", {
    status: "completed",
    pending: false,
    result: { accountId: "acc", mismatch: true, switched: false },
  });
  assert.equal(mismatchNotSwitched.badgeAccountId, null, "no badge when the engine did not switch");
  assert.equal(planOAuthFinish("cursor", { status: "completed", pending: false, result: { accountId: "c", mismatch: true } }).badgeAccountId, null);

  // A fresh Codex login badges; a re-authorization of an existing account does not.
  const fresh = planOAuthFinish("codex", { status: "completed", pending: false, result: { accountId: "new", email: "n@e", switched: true } });
  assert.equal(fresh.badgeAccountId, "new");
  assert.equal(fresh.notices[0].level, "success");
  assert.match(fresh.notices[0].message, /"switched":true/);
  const reauth = planOAuthFinish("codex", { status: "completed", pending: false, targetAccountId: "old", result: { accountId: "old" } });
  assert.equal(reauth.badgeAccountId, null);
  assert.match(reauth.notices[0].message, /"isReauth":true/);

  // A switch error after a successful login is an extra warning, not a failure.
  const switchError = planOAuthFinish("codex", { status: "completed", pending: false, result: { accountId: "s", switchError: "codex_switch_verify_failed" } });
  sameShape(switchError.notices.map((notice) => notice.level), ["success", "warning"]);
  assert.equal(switchError.notices[1].message, "msg:codex_switch_verify_failed");

  // Antigravity fetches the new account's quota right away; others do not.
  assert.equal(planOAuthFinish("antigravity", { status: "completed", pending: false, result: { accountId: "ag" } }).refreshAntigravityAccountId, "ag");
  assert.equal(fresh.refreshAntigravityAccountId, null);

  const authState = { status: "aligned" };
  assert.equal(planOAuthFinish("codex", { status: "completed", pending: false, result: { accountId: "a", authState } }).authState, authState);

  const pending = pendingOAuthStatus("target");
  assert.equal(pending.pending, true);
  assert.equal(pending.status, "pending");
  assert.equal(pending.targetAccountId, "target");
  assert.equal(pending.callbackPort, 1455);
});

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
  assert.match(app, /useNotifications\(\{/);
  assert.match(app, /new ConfigSaveQueue/);
});

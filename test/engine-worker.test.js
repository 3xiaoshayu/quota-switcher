const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { handleWorkerJob } = require("../src/main/engine-worker");
const {
  startEngineWorker,
  stopEngineWorker,
  isEngineWorkerAlive,
  httpJson,
  readVscdbItems,
  setRpcTimeoutMsForTests,
  setEngineWorkerForTests,
  rpcTimeoutForHttpJson,
} = require("../src/main/engine-worker-host");
const { readVscdbItemRows, setSqliteReadTransport } = require("../engine/sqlite-native");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("engine worker stays off DPAPI, account files, and switch transactions", () => {
  const worker = fs.readFileSync(path.join(__dirname, "../src/main/engine-worker.js"), "utf8");
  const host = fs.readFileSync(path.join(__dirname, "../src/main/engine-worker-host.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  assert.match(main, /safeStorage\.encryptString/);
  assert.match(main, /startEngineWorker/);
  assert.match(main, /setHttpJsonTransport/);
  assert.match(main, /setSqliteReadTransport/);
  assert.match(main, /stopEngineWorker/);
  assert.match(host, /utilityProcess/);
  assert.match(host, /engine_worker_down/);
  assert.match(host, /httpJsonLocal/);
  assert.match(host, /scheduleWorkerRestart/);
  assert.match(host, /shouldScheduleWorkerRestart/);
  assert.doesNotMatch(worker, /safeStorage/);
  assert.doesNotMatch(worker, /setSecretCodec/);
  assert.doesNotMatch(worker, /doSwitch/);
  assert.doesNotMatch(worker, /doCursorSwitch/);
  assert.doesNotMatch(worker, /doAntigravitySwitch/);
  assert.doesNotMatch(worker, /require\(.*storage/);
  assert.doesNotMatch(worker, /account-file-store/);
});

test("engine worker restart policy recovers a limited number of crashes", () => {
  const { MAX_RESTARTS, shouldScheduleWorkerRestart } = require("../src/main/engine-worker-host");
  assert.equal(shouldScheduleWorkerRestart({ stopping: false, alive: false, restartCount: 0, restartPending: false }), true);
  assert.equal(shouldScheduleWorkerRestart({ stopping: true, alive: false, restartCount: 0, restartPending: false }), false);
  assert.equal(shouldScheduleWorkerRestart({ stopping: false, alive: true, restartCount: 0, restartPending: false }), false);
  assert.equal(shouldScheduleWorkerRestart({ stopping: false, alive: false, restartCount: 0, restartPending: true }), false);
  assert.equal(shouldScheduleWorkerRestart({ stopping: false, alive: false, restartCount: MAX_RESTARTS, restartPending: false }), false);
});

test("Node tests cannot fork the Electron utilityProcess and stay in-process", () => {
  assert.equal(startEngineWorker(), false);
  assert.equal(isEngineWorkerAlive(), false);
  stopEngineWorker();
  assert.equal(isEngineWorkerAlive(), false);
});

test("engine worker HTTP jobs talk to Node http, not Chromium fetch", async (t) => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  proxy.resolveLiveProxy = async () => ({ source: "direct", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  t.after(() => {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
  });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, ok: true }));
  });
  const port = await listen(server);
  try {
    const result = await handleWorkerJob("httpJson", {
      url: `http://127.0.0.1:${port}/quota`,
      opts: { timeout: 3000, idempotent: true },
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /"ok":true/);
  } finally {
    await closeServer(server);
  }
});

test("engine worker SQLite jobs are read-only item lookups", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-worker-sqlite-"));
  const dbPath = path.join(dir, "state.vscdb");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/cachedEmail", "worker@example.com");
  db.close();
  try {
    const rows = await handleWorkerJob("readVscdbItems", {
      dbPath,
      keys: ["cursorAuth/cachedEmail", "missing"],
    });
    assert.equal(Buffer.from(rows["cursorAuth/cachedEmail"], "base64").toString("utf8"), "worker@example.com");
    assert.equal(rows.missing, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown engine worker operations fail closed", async () => {
  await assert.rejects(
    () => handleWorkerJob("encryptTokens", { tokens: "secret" }),
    (error) => {
      assert.equal(error.code, "engine_worker_unknown_op");
      return true;
    },
  );
});

test("quota HTTP does not wait the full worker RPC budget for a stuck child", () => {
  setRpcTimeoutMsForTests(90_000);
  try {
    assert.equal(rpcTimeoutForHttpJson({ timeout: 25_000 }), 58_000);
    assert.ok(rpcTimeoutForHttpJson({ timeout: 25_000 }) < 90_000);
    assert.ok(rpcTimeoutForHttpJson({ timeout: 50 }) < 2_000);
  } finally {
    setRpcTimeoutMsForTests();
  }
});

test("engine worker RPC timeout kills the stuck child and falls back in-process", async (t) => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  proxy.resolveLiveProxy = async () => ({ source: "direct", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ via: "local-after-timeout" }));
  });
  const port = await listen(server);
  let killed = 0;
  setRpcTimeoutMsForTests(30);
  setEngineWorkerForTests({
    child: {
      postMessage() {},
      kill() { killed += 1; },
    },
  });
  t.after(() => {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
    setRpcTimeoutMsForTests();
    setEngineWorkerForTests();
    stopEngineWorker();
  });
  try {
    const result = await httpJson(`http://127.0.0.1:${port}/`, { timeout: 3000 });
    assert.equal(result.status, 200);
    assert.match(result.body, /local-after-timeout/);
    assert.equal(killed, 1);
    assert.equal(isEngineWorkerAlive(), false);
  } finally {
    await closeServer(server);
  }
});

test("engine worker RPC timeout does not replay a non-idempotent token POST", async (t) => {
  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST") posts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "replayed" }));
  });
  const port = await listen(server);
  let killed = 0;
  setRpcTimeoutMsForTests(30);
  setEngineWorkerForTests({
    child: {
      postMessage() {},
      kill() { killed += 1; },
    },
  });
  t.after(() => {
    setRpcTimeoutMsForTests();
    setEngineWorkerForTests();
    stopEngineWorker();
  });
  try {
    await assert.rejects(
      () => httpJson(`http://127.0.0.1:${port}/token`, {
        method: "POST",
        body: "grant_type=refresh_token",
        timeout: 3000,
        idempotent: false,
      }),
      (error) => error.code === "engine_worker_down",
    );
    assert.equal(posts, 0);
    assert.equal(killed, 1);
  } finally {
    await closeServer(server);
  }
});

test("worker host HTTP falls back in-process when the child is down", async (t) => {
  const proxy = require("../engine/proxy-resolve");
  const originalResolve = proxy.resolveLiveProxy;
  const originalPoison = proxy.hostLooksPoisoned;
  const originalApply = proxy.applySignatureToRuntime;
  const originalInvalidate = proxy.invalidateLiveProxy;
  proxy.resolveLiveProxy = async () => ({ source: "direct", proxyUrl: "", probed: false });
  proxy.hostLooksPoisoned = async () => false;
  proxy.applySignatureToRuntime = async (signature) => signature;
  proxy.invalidateLiveProxy = () => {};
  t.after(() => {
    proxy.resolveLiveProxy = originalResolve;
    proxy.hostLooksPoisoned = originalPoison;
    proxy.applySignatureToRuntime = originalApply;
    proxy.invalidateLiveProxy = originalInvalidate;
  });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ via: "local" }));
  });
  const port = await listen(server);
  try {
    assert.equal(isEngineWorkerAlive(), false);
    const result = await httpJson(`http://127.0.0.1:${port}/`, { timeout: 3000 });
    assert.equal(result.status, 200);
    assert.match(result.body, /local/);
  } finally {
    await closeServer(server);
  }
});

test("SQLite read transport falls back when the engine worker is down", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-worker-sqlite-fallback-"));
  const dbPath = path.join(dir, "state.vscdb");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/cachedEmail", "fallback@example.com");
  db.close();
  let calls = 0;
  setSqliteReadTransport(async () => {
    calls += 1;
    const error = new Error("worker down");
    error.code = "engine_worker_down";
    throw error;
  });
  try {
    const rows = await readVscdbItemRows(dbPath, ["cursorAuth/cachedEmail"]);
    assert.equal(calls, 1);
    assert.equal(Buffer.from(rows["cursorAuth/cachedEmail"], "base64").toString("utf8"), "fallback@example.com");
    const missing = await readVscdbItems(path.join(dir, "missing.vscdb"), ["cursorAuth/cachedEmail"]);
    assert.equal(missing, null);
  } finally {
    setSqliteReadTransport(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

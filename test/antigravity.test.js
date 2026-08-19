const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

function clearEngineModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(projectRoot, "engine"))) delete require.cache[key];
  }
}

function freshEngine(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-manager-test-"));
  process.env.CODEX_MANAGER_DATA_DIR = path.join(root, "data");
  process.env.CODEX_MANAGER_CODEX_DIR = path.join(root, "codex");
  process.env.CODEX_MANAGER_CALLBACK_PORT = String(24000 + Math.floor(Math.random() * 10000));
  clearEngineModules();
  const engine = require("../engine");
  const codec = {
    name: "test-codec",
    encrypt: (value) => Buffer.from(value, "utf8").toString("base64"),
    decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
  };
  engine.setSecretCodec(codec);
  t.after(() => {
    try { engine.cancelOAuth(); } catch {}
    try { engine.cancelCursorOAuth(); } catch {}
    try { engine.cancelAntigravityOAuth(); } catch {}
    engine.setSwitchRuntimeForTests();
    engine.setCursorRuntimeForTests();
    engine.setAntigravityRuntimeForTests();
    engine.setSqliteNativeTimingForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { engine, root };
}

function itemText(dbPath, key) {
  const { asText, getItem, withVscdbSync } = require("../engine/sqlite-native");
  return withVscdbSync(dbPath, { readOnly: true }, (db) => {
    const value = getItem(db, key);
    return value == null ? null : asText(value);
  });
}

function putItem(dbPath, key, value) {
  const { setItem, withVscdbSync } = require("../engine/sqlite-native");
  withVscdbSync(dbPath, {}, (db) => {
    setItem(db, key, value);
  });
}

function holdExclusive(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const locker = new DatabaseSync(dbPath, { timeout: 0 });
  locker.exec("BEGIN EXCLUSIVE");
  return locker;
}

function readEngineLogs(root) {
  const logDir = path.join(root, "data", "logs");
  if (!fs.existsSync(logDir)) return "";
  return fs.readdirSync(logDir)
    .filter((name) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .map((name) => fs.readFileSync(path.join(logDir, name), "utf8"))
    .join("\n");
}

function applyImmediateLockTimeout(engine) {
  engine.setSqliteNativeTimingForTests({
    waitWritableTimeoutMs: 0,
    waitWritableOpenTimeoutMs: 0,
    switchTimeoutMs: 50,
    writeTimeoutMs: 50,
    busyRetries: 0,
    readBusyRetries: 0,
  });
}

function installVscdbIoSpies(t, dbPath) {
  const needle = path.normalize(dbPath);
  const originalRead = fs.readFileSync;
  const originalCopy = fs.copyFileSync;
  const originalCopyAsync = fs.promises.copyFile;
  const hits = { read: 0, copy: 0 };
  const matches = (target) => path.normalize(String(target || "")) === needle;
  fs.readFileSync = function(target, ...rest) {
    if (matches(target)) hits.read += 1;
    return originalRead.call(this, target, ...rest);
  };
  fs.copyFileSync = function(src, dest, ...rest) {
    if (matches(src) || matches(dest)) hits.copy += 1;
    return originalCopy.call(this, src, dest, ...rest);
  };
  fs.promises.copyFile = async function(src, dest, ...rest) {
    if (matches(src) || matches(dest)) hits.copy += 1;
    return originalCopyAsync.call(this, src, dest, ...rest);
  };
  t.after(() => {
    fs.readFileSync = originalRead;
    fs.copyFileSync = originalCopy;
    fs.promises.copyFile = originalCopyAsync;
  });
  return hits;
}

test("antigravity protobuf token topic round-trips access and refresh", () => {
  const proto = require("../engine/antigravity-proto");
  const topic = proto.encodeOauthTokenTopic({
    access_token: "ya29.access",
    refresh_token: "1//refresh",
    token_type: "Bearer",
    expiry_timestamp: 1_700_000_000,
  });
  const decoded = proto.decodeOauthTokenTopic(topic);
  assert.equal(decoded.access_token, "ya29.access");
  assert.equal(decoded.refresh_token, "1//refresh");
  assert.equal(decoded.token_type, "Bearer");
  assert.equal(decoded.expiry_timestamp, 1_700_000_000);
  const encoded = proto.encodeItemTableValue(topic);
  const again = proto.decodeOauthTokenTopic(proto.decodeItemTableValue(encoded));
  assert.equal(again.refresh_token, "1//refresh");
});

test("antigravity prefers Antigravity IDE user data when state.vscdb exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ag-paths-"));
  const previous = process.env.APPDATA;
  process.env.APPDATA = root;
  clearEngineModules();
  try {
    const ideDb = path.join(root, "Antigravity IDE", "User", "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(ideDb), { recursive: true });
    fs.writeFileSync(ideDb, "db");
    fs.mkdirSync(path.join(root, "Antigravity"), { recursive: true });
    const runtime = require("../engine/antigravity-runtime");
    assert.equal(runtime.preferUserDataDir(), path.join(root, "Antigravity IDE"));
    assert.equal(runtime.defaultVscdbPath(), ideDb);
  } finally {
    if (previous == null) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
    clearEngineModules();
  }
});

test("antigravity accounts stay out of Codex and Cursor lists", async (t) => {
  const { engine } = freshEngine(t);
  const result = await engine.upsertAntigravityAccount({
    email: "ag@example.com",
    auth_id: "fp1",
    access_token: "ya29.one",
    refresh_token: "1//one",
  });
  assert.equal(result.account.id.startsWith("antigravity_"), true);
  assert.equal(engine.listAccts().length, 0);
  assert.equal(engine.listCursorAccts().length, 0);
  assert.equal(engine.listAntigravityAccts().length, 1);
  assert.equal(engine.loadAcct(result.account.id), null);
});

test("antigravity import dedupes by email and refresh fingerprint", async (t) => {
  const { engine } = freshEngine(t);
  const first = await engine.upsertAntigravityAccount({
    email: "same@example.com",
    access_token: "ya29.old",
    refresh_token: "1//same-refresh",
  });
  const second = await engine.upsertAntigravityAccount({
    email: "same@example.com",
    access_token: "ya29.new",
    refresh_token: "1//same-refresh",
  });
  assert.equal(second.account.id, first.account.id);
  assert.equal(engine.listAntigravityAccts().length, 1);
  assert.equal(engine.loadAntigravityAcct(first.account.id).tokens.access_token, "ya29.new");
});

test("antigravity local import reads vscdb token and marks current", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.local",
    refresh_token: "1//local",
    token_type: "Bearer",
    expiry_timestamp: 1_800_000_000,
  });
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    execFile: async () => ({ stdout: "" }),
    oauthClient: () => ({ clientId: "test-client", clientSecret: "test-secret" }),
    httpJson: async (url) => {
      if (String(url).includes("userinfo")) {
        return { status: 200, body: JSON.stringify({ email: "local-ag@example.com" }) };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  const imported = await engine.importLocalAntigravityAccount();
  assert.equal(imported.found, true);
  assert.equal(imported.account.email, "local-ag@example.com");
  assert.equal(imported.account.banned, false);
  assert.equal(engine.currentAntigravityAcct().id, imported.account.id);
});

test("antigravity switch writes only the oauth token item key", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "ag-state.vscdb");
  const exePath = path.join(root, "Antigravity IDE.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.old",
    refresh_token: "1//old",
    expiry_timestamp: 10,
  });
  const created = await engine.upsertAntigravityAccount({
    email: "next-ag@example.com",
    access_token: "ya29.next",
    refresh_token: "1//next",
    expiry_timestamp: 99,
  });
  let listed = [{ name: "Antigravity IDE.exe", pid: 5151, executablePath: exePath }];
  const launched = [];
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    exePath: () => exePath,
    listProcesses: async () => listed,
    gracefulClose: async () => {
      listed = [];
      return true;
    },
    forceClose: async () => true,
    launch: (target) => {
      launched.push(target);
      return true;
    },
    sleep: async () => {},
  });
  const switched = await engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id));
  assert.equal(switched.launched, true);
  assert.deepEqual(launched, [exePath]);
  const stored = await engine.readAntigravityAuth(dbPath, { copyFirst: false });
  assert.equal(stored.access_token, "ya29.next");
  assert.equal(stored.refresh_token, "1//next");
  const { OAUTH_ITEM_KEY } = require("../engine/antigravity-db");
  const { listKeys, withVscdbSync } = require("../engine/sqlite-native");
  const keys = withVscdbSync(dbPath, { readOnly: true }, (db) => listKeys(db));
  assert.deepEqual(keys, [OAUTH_ITEM_KEY]);
  assert.equal(engine.currentAntigravityAcct().id, created.account.id);
});

test("antigravity quota parser reads official gemini and 3p windows", (t) => {
  const { engine } = freshEngine(t);
  const quota = engine.parseAntigravityUsage({
    currentTier: { id: "PRO", name: "Pro", creditsRemaining: 40, creditsLimit: 100 },
  }, {}, {
    groups: [{
      buckets: [
        { bucketId: "gemini-weekly", remainingFraction: 0.64, resetTime: "2026-08-25T00:00:00Z" },
        { bucketId: "gemini-5h", remainingFraction: 0.8, resetTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
        { bucketId: "3p-weekly", remainingFraction: 0.9, resetTime: "2026-08-25T00:00:00Z" },
        { bucketId: "3p-5h", remainingFraction: 0.25, resetTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
      ],
    }],
  });
  assert.equal(quota.tier, "PRO");
  assert.equal(quota.credits_remaining, 40);
  assert.equal(quota.credits_remaining_percentage, 40);
  assert.equal(quota.gemini_weekly_remaining, 64);
  assert.equal(quota.gemini_five_hour_remaining, 80);
  assert.equal(quota.third_party_weekly_remaining, 90);
  assert.equal(quota.third_party_five_hour_remaining, 25);
  assert.equal(quota.primary_remaining_percentage, 64);
  assert.equal(quota.secondary_remaining_percentage, 25);
});

test("antigravity quota refresh does not grow NO_PROXY", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertAntigravityAccount({
    email: "quota@example.com",
    access_token: "ya29.quota",
    refresh_token: "1//quota",
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
  });
  const before = process.env.NO_PROXY || "";
  engine.setAntigravityRuntimeForTests({
    oauthClient: () => ({ clientId: "id", clientSecret: "secret" }),
    httpJson: async (url) => {
      if (String(url).includes("loadCodeAssist")) {
        return { status: 200, body: JSON.stringify({ currentTier: { id: "FREE", creditsRemaining: 9, creditsLimit: 10 } }) };
      }
      if (String(url).includes("fetchAvailableModels")) {
        return { status: 200, body: JSON.stringify({ models: [] }) };
      }
      return { status: 200, body: "{}" };
    },
  });
  await engine.refreshAntigravityQuota(engine.loadAntigravityAcct(created.account.id), { force: true });
  await engine.refreshAntigravityQuota(engine.loadAntigravityAcct(created.account.id), { force: true });
  assert.equal(process.env.NO_PROXY || "", before);
  const latest = engine.loadAntigravityAcct(created.account.id);
  assert.equal(latest.quota.tier, "FREE");
  assert.equal(latest.banned, false);
  assert.equal(latest.quota_error, null);
});

test("antigravity sync marks current from official refresh fingerprint", async (t) => {
  const { engine, root } = freshEngine(t);
  const first = await engine.upsertAntigravityAccount({
    email: "one@example.com",
    access_token: "ya29.one",
    refresh_token: "1//one",
  });
  const second = await engine.upsertAntigravityAccount({
    email: "two@example.com",
    access_token: "ya29.two",
    refresh_token: "1//two",
  });
  const dbPath = path.join(root, "sync-state.vscdb");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.two",
    refresh_token: "1//two",
    expiry_timestamp: 99,
  });
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    execFile: async () => ({ stdout: "" }),
  });
  assert.equal(engine.currentAntigravityAcct().id, first.account.id);
  const current = await engine.syncCurrentAntigravityFromOfficial();
  assert.equal(current.id, second.account.id);
  assert.notEqual(current.id, first.account.id);
});

test("antigravity import keeps existing email when official store has no mailbox", async (t) => {
  const { engine, root } = freshEngine(t);
  const created = await engine.upsertAntigravityAccount({
    email: "keep@example.com",
    access_token: "ya29.keep",
    refresh_token: "1//keep",
  });
  const dbPath = path.join(root, "keep-state.vscdb");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.keep",
    refresh_token: "1//keep",
    expiry_timestamp: 99,
  });
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    execFile: async () => ({ stdout: "" }),
    httpJson: async () => {
      throw new Error("userinfo unavailable");
    },
  });
  const imported = await engine.importLocalAntigravityAccount();
  assert.equal(imported.found, true);
  assert.equal(imported.account.id, created.account.id);
  assert.equal(imported.account.email, "keep@example.com");
  assert.equal(engine.listAntigravityAccts().length, 1);
});

test("antigravity official sync follows vscdb even when WAL is pending", async (t) => {
  const { engine, root } = freshEngine(t);
  const first = await engine.upsertAntigravityAccount({
    email: "keep@example.com",
    access_token: "ya29.keep",
    refresh_token: "1//keep",
  });
  const other = await engine.upsertAntigravityAccount({
    email: "other@example.com",
    access_token: "ya29.other",
    refresh_token: "1//other",
  });
  const dbPath = path.join(root, "wal-sync.vscdb");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.keep",
    refresh_token: "1//keep",
  });
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    execFile: async () => ({ stdout: "" }),
  });
  assert.equal((await engine.syncCurrentAntigravityFromOfficial()).id, first.account.id);
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.other",
    refresh_token: "1//other",
  });
  const { DatabaseSync } = require("node:sqlite");
  const holder = new DatabaseSync(dbPath);
  holder.exec("PRAGMA journal_mode=WAL");
  holder.exec("PRAGMA wal_autocheckpoint=0");
  holder.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run("keep/extra", "x");
  const current = await engine.syncCurrentAntigravityFromOfficial({ force: true });
  assert.equal(current.id, other.account.id);
  holder.close();
});

test("antigravity local import marks stalePossible when WAL is pending", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "stale.vscdb");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.stale",
    refresh_token: "1//stale",
  });
  const { DatabaseSync } = require("node:sqlite");
  const holder = new DatabaseSync(dbPath);
  holder.exec("PRAGMA journal_mode=WAL");
  holder.exec("PRAGMA wal_autocheckpoint=0");
  holder.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run("keep/extra", "x");
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    execFile: async () => ({ stdout: "" }),
    httpJson: async (url) => {
      if (String(url).includes("userinfo")) {
        return { status: 200, body: JSON.stringify({ email: "stale@example.com" }) };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  const imported = await engine.importLocalAntigravityAccount();
  assert.equal(imported.found, true);
  assert.equal(engine.hasPendingWal(dbPath), true);
  assert.equal(imported.stalePossible, true);
  holder.close();
});

test("antigravity auth write keeps unrelated vscdb rows and does not copy the file", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "ag-state.vscdb");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.old",
    refresh_token: "1//old",
  });
  putItem(dbPath, "keep/extra", "stay");
  const hits = installVscdbIoSpies(t, dbPath);
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.next",
    refresh_token: "1//next",
  });
  const stored = await engine.readAntigravityAuth(dbPath, { copyFirst: false });
  assert.equal(stored.access_token, "ya29.next");
  assert.equal(itemText(dbPath, "keep/extra"), "stay");
  assert.equal(hits.read, 0);
  assert.equal(hits.copy, 0);
});

test("antigravity switch writes the oauth row even when a leftover WAL file is present", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "ag-wal.vscdb");
  const exePath = path.join(root, "Antigravity IDE.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.old",
    refresh_token: "1//old",
  });
  putItem(dbPath, "keep/extra", "stay");
  const { DatabaseSync } = require("node:sqlite");
  const walHolder = new DatabaseSync(dbPath);
  walHolder.exec("PRAGMA journal_mode=WAL");
  walHolder.exec("PRAGMA wal_autocheckpoint=0");
  walHolder.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run("keep/wal", "pending");
  walHolder.close();
  const created = await engine.upsertAntigravityAccount({
    email: "wal@example.com",
    access_token: "ya29.wal",
    refresh_token: "1//wal",
  });
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    exePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });
  await engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id));
  const stored = await engine.readAntigravityAuth(dbPath, { copyFirst: false });
  assert.equal(stored.access_token, "ya29.wal");
  assert.equal(itemText(dbPath, "keep/extra"), "stay");
});

test("antigravity switch refuses a locked vscdb and relaunches without rolling back", async (t) => {
  const { engine, root } = freshEngine(t);
  applyImmediateLockTimeout(engine);
  const dbPath = path.join(root, "ag-busy.vscdb");
  const exePath = path.join(root, "Antigravity IDE.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.old",
    refresh_token: "1//old",
  });
  const locker = holdExclusive(dbPath);
  t.after(() => {
    try { locker.exec("ROLLBACK"); } catch {}
    try { locker.close(); } catch {}
  });
  const created = await engine.upsertAntigravityAccount({
    email: "busy@example.com",
    access_token: "ya29.busy",
    refresh_token: "1//busy",
  });
  const launched = [];
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    exePath: () => exePath,
    listProcesses: async () => [],
    launch: (target) => launched.push(target),
    sleep: async () => {},
  });
  await assert.rejects(
    () => engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id)),
    /占用登录库/,
  );
  try { locker.exec("ROLLBACK"); } catch {}
  try { locker.close(); } catch {}
  const stored = await engine.readAntigravityAuth(dbPath, { copyFirst: false });
  assert.equal(stored.access_token, "ya29.old");
  assert.deepEqual(launched, [exePath]);
  assert.match(readEngineLogs(root), /Antigravity switch failed/);
  assert.match(readEngineLogs(root), /antigravity_vscdb_busy|占用登录库/);
});

test("antigravity switch waits for a brief vscdb lock then writes", async (t) => {
  const { engine, root } = freshEngine(t);
  engine.setSqliteNativeTimingForTests({
    waitWritableTimeoutMs: 2000,
    waitWritablePollMs: 40,
    waitWritableOpenTimeoutMs: 0,
  });
  const dbPath = path.join(root, "ag-wait.vscdb");
  const exePath = path.join(root, "Antigravity IDE.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.old",
    refresh_token: "1//old",
  });
  const locker = holdExclusive(dbPath);
  t.after(() => {
    try { locker.exec("ROLLBACK"); } catch {}
    try { locker.close(); } catch {}
  });
  const created = await engine.upsertAntigravityAccount({
    email: "wait@example.com",
    access_token: "ya29.wait",
    refresh_token: "1//wait",
  });
  const launched = [];
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    exePath: () => exePath,
    listProcesses: async () => [],
    launch: (target) => launched.push(target),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  setTimeout(() => {
    try { locker.exec("ROLLBACK"); } catch {}
    try { locker.close(); } catch {}
  }, 120);
  await engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id));
  const stored = await engine.readAntigravityAuth(dbPath, { copyFirst: false });
  assert.equal(stored.access_token, "ya29.wait");
  assert.deepEqual(launched, [exePath]);
});

test("antigravity quota parser ignores catalog model names and caps gemini 5h", (t) => {
  const { engine } = freshEngine(t);
  const farReset = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
  const quota = engine.parseAntigravityUsage({
    currentTier: { id: "PRO", creditsRemaining: 8, creditsLimit: 10 },
  }, {
    models: [
      { displayName: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0.5 } },
      { displayName: "tab_jump_flash_lite_preview", quotaInfo: { remainingPercent: 10 } },
      { name: "gemini:5h", quotaInfo: { remainingFraction: 0.2, resetTime: farReset } },
      { name: "gemini:weekly", quotaInfo: { remainingFraction: 0.7 } },
    ],
  });
  assert.equal(quota.gemini_weekly_remaining, 70);
  assert.equal(quota.gemini_five_hour_remaining, 100);
  assert.equal(quota.gemini_five_hour_reset_time, null);
  assert.equal(quota.primary_model, null);
  assert.equal(quota.secondary_model, null);
});

test("antigravity default exe path does not query running processes", () => {
  const cp = require("node:child_process");
  const runtime = require("../engine/antigravity-runtime");
  const original = cp.execFileSync;
  let spawned = false;
  cp.execFileSync = (...args) => {
    spawned = true;
    return original(...args);
  };
  try {
    assert.equal(runtime.defaultExePath(), runtime.firstExistingExe());
    assert.equal(spawned, false);
  } finally {
    cp.execFileSync = original;
  }
});

test("antigravity process matcher accepts official Hub and ignores random exe", () => {
  clearEngineModules();
  const runtime = require("../engine/antigravity-runtime");
  assert.equal(runtime.isAntigravityProcess({
    name: "Antigravity IDE.exe",
    executablePath: "C:\\Users\\a\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe",
  }), true);
  assert.equal(runtime.isAntigravityProcess({
    name: "Antigravity.exe",
    executablePath: "C:\\Users\\a\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe",
  }), true);
  assert.equal(runtime.isAntigravityProcess({
    name: "Antigravity.exe",
    executablePath: "C:\\Users\\a\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe",
  }), true);
  assert.equal(runtime.isAntigravityProcess({
    name: "Antigravity.exe",
    executablePath: "C:\\Users\\a\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity.exe",
  }), true);
  assert.equal(runtime.isAntigravityProcess({
    name: "electron.exe",
    executablePath: "C:\\Users\\a\\AppData\\Local\\Programs\\Antigravity IDE\\resources\\electron.exe",
  }), true);
  assert.equal(runtime.isAntigravityProcess({
    name: "electron.exe",
    executablePath: "C:\\Users\\a\\AppData\\Local\\Programs\\Antigravity\\resources\\electron.exe",
  }), true);
  assert.equal(runtime.isAntigravityProcess({
    name: "Antigravity.exe",
    executablePath: "D:\\tools\\Antigravity.exe",
  }), false);
  assert.equal(runtime.isAntigravityProcess({
    name: "Antigravity IDE.exe",
    executablePath: "E:\\cloude code deskep\\codex-deskep\\node_modules\\electron\\Antigravity IDE.exe",
  }), false);
  assert.ok(runtime.defaultExeCandidates().some((item) => path.basename(item) === "Antigravity.exe"));
  assert.ok(runtime.defaultExeCandidates().some((item) => path.basename(item) === "Antigravity IDE.exe"));
});

test("antigravity first upsert becomes current and mismatch does not steal it", async (t) => {
  const { engine } = freshEngine(t);
  assert.equal(engine.currentAntigravityAcct(), null);
  const first = await engine.upsertAntigravityAccount({
    email: "first@example.com",
    access_token: "ya29.first",
    refresh_token: "1//first",
  });
  assert.equal(engine.currentAntigravityAcct().id, first.account.id);
  const second = await engine.upsertAntigravityAccount({
    email: "second@example.com",
    access_token: "ya29.second",
    refresh_token: "1//second",
  });
  assert.notEqual(second.account.id, first.account.id);
  assert.equal(engine.currentAntigravityAcct().id, first.account.id);
  const mismatch = await engine.upsertAntigravityAccount({
    email: "other@example.com",
    access_token: "ya29.other",
    refresh_token: "1//other",
  }, { targetAccountId: first.account.id });
  assert.equal(mismatch.mismatch, true);
  assert.equal(engine.currentAntigravityAcct().id, first.account.id);
});

test("antigravity quota parser reads allowedTiers and availableCredits", (t) => {
  const { engine } = freshEngine(t);
  const quota = engine.parseAntigravityUsage({
    allowedTiers: [
      { id: "free-tier", name: "Free", isDefault: true, availableCredits: [{ creditAmount: "40" }] },
      { id: "standard-tier", name: "Standard" },
    ],
    availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "40" }],
  }, {
    models: {
      "gemini-weekly": { displayName: "Gemini Weekly", quotaInfo: { remainingFraction: 0.5 } },
      "3p-5h": { displayName: "Claude 5h", quotaInfo: { remainingPercent: 10 } },
    },
  });
  assert.equal(quota.tier, null);
  assert.equal(quota.credits_remaining, 40);
  assert.equal(quota.gemini_weekly_remaining, 50);
  assert.equal(quota.third_party_five_hour_remaining, 10);
});

test("antigravity quota parser prefers paidTier over default allowedTiers", (t) => {
  const { engine } = freshEngine(t);
  const quota = engine.parseAntigravityUsage({
    paidTier: { id: "PRO", availableCredits: [{ creditAmount: "80" }] },
    currentTier: { id: "free-tier" },
    allowedTiers: [
      { id: "free-tier", name: "Free", isDefault: true, availableCredits: [{ creditAmount: "40" }] },
      { id: "PRO", name: "Pro" },
    ],
  }, {
    models: {
      "gemini-weekly": { displayName: "Gemini Weekly", quotaInfo: { remainingFraction: 0.5 } },
    },
  });
  assert.equal(quota.tier, "PRO");
  assert.equal(quota.credits_remaining, 80);
});

test("official oauth client extractor reads the first nearby google pair", () => {
  const { extractOfficialOauthClient } = require("../engine/antigravity-oauth-client");
  const extracted = extractOfficialOauthClient(`
    module.exports.oauthClient = {
      client_id: "1071006060591-example.apps.googleusercontent.com",
      client_secret: "GOCSPX-exampleSecret",
    };
  `);
  assert.equal(extracted.clientId, "1071006060591-example.apps.googleusercontent.com");
  assert.equal(extracted.clientSecret, "GOCSPX-exampleSecret");
});

test("official oauth client falls back to the published official client", () => {
  const {
    readOfficialOauthClient,
    setOfficialOauthClientForTests,
    PUBLISHED_OFFICIAL_OAUTH_CLIENT,
  } = require("../engine/antigravity-oauth-client");
  setOfficialOauthClientForTests(null);
  const client = readOfficialOauthClient(null);
  assert.equal(client.clientId, PUBLISHED_OFFICIAL_OAUTH_CLIENT.clientId);
  assert.equal(client.source, "published-official");
  setOfficialOauthClientForTests(null);
});

test("antigravity oauth url uses localhost and omits PKCE", () => {
  const { buildAuthUrl, antigravityRedirectUri } = require("../engine/antigravity-oauth");
  assert.equal(antigravityRedirectUri(51121), "http://localhost:51121/oauth-callback");
  const url = buildAuthUrl({
    callbackPort: 51121,
    state: "abc",
  }, { clientId: "test-client" });
  assert.match(url, /redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback/);
  assert.doesNotMatch(url, /code_challenge/);
  assert.doesNotMatch(url, /include_granted_scopes/);
});

test("antigravity oauth callback keeps Google code when iss is unencoded", () => {
  const { parseAntigravityCallbackRequest } = require("../engine/antigravity-oauth");
  const parsed = parseAntigravityCallbackRequest(
    "/oauth-callback?state=g9MK5WTLdxOZBoY5FGI-KA&iss=https://accounts.google.com&code=4/0ATsMZqAVOjzcaISRRhPetVQsv2QGQjeotC2ChzLZAoQNBDC6pyg5VbxzC_g19xxx",
  );
  assert.equal(parsed.pathname, "/oauth-callback");
  assert.equal(parsed.state, "g9MK5WTLdxOZBoY5FGI-KA");
  assert.equal(parsed.code, "4/0ATsMZqAVOjzcaISRRhPetVQsv2QGQjeotC2ChzLZAoQNBDC6pyg5VbxzC_g19xxx");
  const empty = parseAntigravityCallbackRequest("/oauth-callback");
  assert.equal(empty.code, null);
  const root = parseAntigravityCallbackRequest("/");
  assert.equal(root.pathname, "/");
  assert.equal(root.code, null);
});

test("antigravity oauth listener ignores empty probes then accepts the Google code", async () => {
  const { createCallbackListener } = require("../engine/antigravity-oauth");
  const port = 18000 + Math.floor(Math.random() * 1000);
  const listener = createCallbackListener({ callbackPort: port, state: "abc" });
  await listener.ready;
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/oauth-callback`);
    assert.equal(probe.status, 404);
    const real = await fetch(`http://127.0.0.1:${port}/oauth-callback?state=abc&iss=https://accounts.google.com&code=4/0ATsxxx`);
    assert.equal(real.status, 200);
    assert.match(await real.text(), /授权完成/);
    assert.equal(await listener.codePromise, "4/0ATsxxx");
  } finally {
    listener.server.close();
  }
});

test("antigravity credential parser reads nested hub token json", () => {
  const { parseCredentialBlob } = require("../engine/antigravity-credential");
  const parsed = parseCredentialBlob(JSON.stringify({
    token: {
      access_token: "ya29.nested",
      refresh_token: "1//nested",
      expiry: "2026-08-18T12:00:00.000Z",
    },
    auth_method: "oauth",
  }));
  assert.equal(parsed.refresh_token, "1//nested");
  assert.equal(parsed.access_token, "ya29.nested");
  assert.equal(parsed.expiry_timestamp, Date.parse("2026-08-18T12:00:00.000Z") / 1000);
});

test("antigravity local import prefers system credential over leftover vscdb", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "leftover.vscdb");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.vscdb",
    refresh_token: "1//vscdb",
    expiry_timestamp: 10,
  });
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64, 3));
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    execFile: async () => ({
      stdout: JSON.stringify({
        token: {
          access_token: "ya29.cred",
          refresh_token: "1//cred",
          expiry: "2026-08-18T12:00:00.000Z",
        },
      }),
    }),
    httpJson: async (url) => {
      if (String(url).includes("userinfo")) {
        return { status: 200, body: JSON.stringify({ email: "cred@example.com" }) };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  const imported = await engine.importLocalAntigravityAccount();
  assert.equal(imported.found, true);
  assert.equal(imported.stalePossible, false);
  assert.equal(imported.account.email, "cred@example.com");
  assert.equal(imported.account.tokens.refresh_token, "1//cred");
  assert.equal(imported.account.tokens.access_token, "ya29.cred");
});

test("antigravity same email different refresh stays one account", async (t) => {
  const { engine } = freshEngine(t);
  const first = await engine.upsertAntigravityAccount({
    email: "same@example.com",
    access_token: "ya29.old",
    refresh_token: "1//old-refresh",
  });
  const second = await engine.upsertAntigravityAccount({
    email: "same@example.com",
    access_token: "ya29.new",
    refresh_token: "1//new-refresh",
  });
  assert.equal(second.account.id, first.account.id);
  assert.equal(second.updated, true);
  assert.equal(engine.listAntigravityAccts().length, 1);
  assert.equal(engine.loadAntigravityAcct(first.account.id).tokens.refresh_token, "1//new-refresh");
});

test("antigravity collapse folds same-email files and keeps current", async (t) => {
  const { engine } = freshEngine(t);
  const first = await engine.upsertAntigravityAccount({
    email: "fold@example.com",
    access_token: "ya29.one",
    refresh_token: "1//one",
  });
  engine.setCurrentAntigravityAccountId(first.account.id);
  const extra = {
    ...first.account,
    id: engine.buildAntigravityId("fold@example.com", "other-fp"),
    auth_id: "other-fp",
    created_at: first.account.created_at + 10,
    tokens: {
      ...first.account.tokens,
      auth_id: "other-fp",
      refresh_token: "1//other",
    },
  };
  engine.saveAntigravityAcct(extra);
  assert.equal(engine.listAntigravityAccts().length, 2);
  engine.collapseDuplicateAntigravityAccounts();
  const remaining = engine.listAntigravityAccts();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, first.account.id);
  assert.equal(engine.currentAntigravityAcct().id, first.account.id);
});

test("antigravity empty quota refresh is a sync failure", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertAntigravityAccount({
    email: "empty@example.com",
    access_token: "ya29.empty",
    refresh_token: "1//empty",
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
  });
  engine.setAntigravityRuntimeForTests({
    oauthClient: () => ({ clientId: "id", clientSecret: "secret" }),
    httpJson: async () => ({ status: 200, body: "{}" }),
  });
  await assert.rejects(
    () => engine.refreshAntigravityQuota(engine.loadAntigravityAcct(created.account.id), { force: true }),
    /没查清/,
  );
  const latest = engine.loadAntigravityAcct(created.account.id);
  assert.equal(latest.quota_error.code, "probe_failed");
  assert.equal(latest.probe.status, "probe_failed");
});

test("antigravity unknown email does not bridge two mailboxes", () => {
  const { groupByIdentity } = require("../engine/account-identity");
  const { sameAntigravityIdentity } = require("../engine/antigravity-local");
  const accounts = [
    { id: "a", email: "alpha@example.com", auth_id: "shared-fp" },
    { id: "b", email: "unknown", auth_id: "shared-fp" },
    { id: "c", email: "beta@example.com", auth_id: "shared-fp" },
  ];
  const groups = groupByIdentity(accounts, sameAntigravityIdentity);
  const groupOf = (email) => groups.find((group) => group.some((item) => item.email === email));
  assert.notEqual(groupOf("alpha@example.com"), groupOf("beta@example.com"));
  assert.equal(groupOf("alpha@example.com").some((item) => item.email === "beta@example.com"), false);
  const emails = new Set(groups.flatMap((group) => group.map((item) => item.email).filter((email) => email.includes("@"))));
  assert.deepEqual([...emails].sort(), ["alpha@example.com", "beta@example.com"]);
});

test("antigravity unknown fingerprints do not merge", async (t) => {
  const { engine } = freshEngine(t);
  const seed = await engine.upsertAntigravityAccount({
    email: "seed@example.com",
    access_token: "ya29.seed",
    refresh_token: "1//seed",
  });
  engine.saveAntigravityAcct({
    ...seed.account,
    id: engine.buildAntigravityId("unknown", "u1"),
    email: "unknown",
    auth_id: "unknown",
    tokens: { ...seed.account.tokens, auth_id: "unknown", refresh_token: "1//u1" },
  });
  engine.saveAntigravityAcct({
    ...seed.account,
    id: engine.buildAntigravityId("unknown", "u2"),
    email: "unknown",
    auth_id: "unknown",
    tokens: { ...seed.account.tokens, auth_id: "unknown", refresh_token: "1//u2" },
  });
  engine.deleteAntigravityAcct(seed.account.id, { allowCurrent: true });
  engine.collapseDuplicateAntigravityAccounts();
  assert.equal(engine.listAntigravityAccts().length, 2);
});

test("antigravity sync matches existing email after refresh rotates", async (t) => {
  const { engine, root } = freshEngine(t);
  const kept = await engine.upsertAntigravityAccount({
    email: "keep@example.com",
    access_token: "ya29.old",
    refresh_token: "1//old-refresh",
  });
  const other = await engine.upsertAntigravityAccount({
    email: "other@example.com",
    access_token: "ya29.other",
    refresh_token: "1//other",
  });
  engine.setCurrentAntigravityAccountId(other.account.id);
  const dbPath = path.join(root, "rotate-state.vscdb");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.rotated",
    refresh_token: "1//rotated-refresh",
    expiry_timestamp: 99,
  });
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    execFile: async () => ({ stdout: "" }),
    httpJson: async (url) => {
      if (String(url).includes("userinfo")) {
        return { status: 200, body: JSON.stringify({ email: "keep@example.com" }) };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  const current = await engine.syncCurrentAntigravityFromOfficial();
  assert.equal(current.id, kept.account.id);
  assert.equal(engine.listAntigravityAccts().length, 2);
});

test("antigravity upsert keeps quota_error when no new windows arrive", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertAntigravityAccount({
    email: "keep-error@example.com",
    access_token: "ya29.old",
    refresh_token: "1//old",
  });
  const stored = engine.loadAntigravityAcct(created.account.id);
  stored.quota_error = { code: "probe_failed", message: "这次没查清额度，请稍后重试。" };
  stored.probe = { status: "probe_failed" };
  engine.saveAntigravityAcct(stored);
  const updated = await engine.upsertAntigravityAccount({
    email: "keep-error@example.com",
    access_token: "ya29.new",
    refresh_token: "1//new",
  });
  assert.equal(updated.updated, true);
  assert.equal(updated.account.quota_error.code, "probe_failed");
  assert.equal(updated.account.probe.status, "probe_failed");
  assert.equal(engine.loadAntigravityAcct(created.account.id).quota_error.code, "probe_failed");
});

test("antigravity official sync reads sqlite in place and shares one pass", async (t) => {
  const { engine, root } = freshEngine(t);
  const kept = await engine.upsertAntigravityAccount({
    email: "keep@example.com",
    access_token: "ya29.keep",
    refresh_token: "1//keep",
  });
  const dbPath = path.join(root, "ttl.vscdb");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.keep",
    refresh_token: "1//keep",
    expiry_timestamp: 99,
  });
  let pathReads = 0;
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => {
      pathReads += 1;
      return dbPath;
    },
    execFile: async () => ({ stdout: "" }),
    httpJson: async (url) => {
      if (String(url).includes("userinfo")) {
        return { status: 200, body: JSON.stringify({ email: "keep@example.com" }) };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  const hits = installVscdbIoSpies(t, dbPath);
  await Promise.all([
    engine.syncCurrentAntigravityFromOfficial(),
    engine.syncCurrentAntigravityFromOfficial(),
  ]);
  await engine.syncCurrentAntigravityFromOfficial();
  assert.equal(pathReads, 1);
  assert.equal(hits.read, 0);
  assert.equal(hits.copy, 0);
  assert.equal(engine.currentAntigravityAcct().id, kept.account.id);
});

test("antigravity list skipOfficialSync does not read official vscdb", async (t) => {
  const { engine } = freshEngine(t);
  await engine.upsertAntigravityAccount({
    email: "skip@example.com",
    access_token: "ya29.skip",
    refresh_token: "1//skip",
  });
  let vscdbReads = 0;
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => {
      vscdbReads += 1;
      return path.join("missing", "state.vscdb");
    },
    execFile: async () => ({ stdout: "" }),
  });
  const handlers = new Map();
  const electron = {
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
    BrowserWindow: { getAllWindows: () => [] },
    app: { getVersion: () => "0.1.0-beta.29", isPackaged: false },
    shell: { async openExternal() {}, async openPath() { return ""; } },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const listed = await handlers.get("antigravity:list")({}, { skipOfficialSync: true });
  assert.equal(listed.success, true);
  assert.equal(vscdbReads, 0);
});

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

function countDecrypts(engine) {
  let count = 0;
  engine.setSecretCodec({
    name: "test-codec",
    encrypt: (value) => Buffer.from(value, "utf8").toString("base64"),
    decrypt: (value) => {
      count += 1;
      return Buffer.from(value, "base64").toString("utf8");
    },
  });
  return {
    get count() { return count; },
    reset() { count = 0; },
  };
}

test("antigravity waitForWalToClear returns immediately when no WAL exists", async (t) => {
  const { root } = freshEngine(t);
  const { waitForWalToClear } = require("../engine/antigravity-db");
  const dbPath = path.join(root, "no-wal.vscdb");
  fs.writeFileSync(dbPath, "x");
  let sleeps = 0;
  const cleared = await waitForWalToClear(dbPath, 2000, async () => {
    sleeps += 1;
  });
  assert.equal(cleared, true);
  assert.equal(sleeps, 0);
});

test("antigravity waitForWalToClear waits until a leftover WAL file is gone", async (t) => {
  const { root } = freshEngine(t);
  const { waitForWalToClear } = require("../engine/antigravity-db");
  const dbPath = path.join(root, "pending-wal.vscdb");
  fs.writeFileSync(dbPath, "x");
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64, 1));
  let sleeps = 0;
  const cleared = await waitForWalToClear(dbPath, 2000, async () => {
    sleeps += 1;
    if (sleeps === 2) fs.unlinkSync(`${dbPath}-wal`);
  });
  assert.equal(cleared, true);
  assert.equal(sleeps, 2);
});

test("antigravity waitForWalToClear retries a transient WAL stat lock", async (t) => {
  const { root } = freshEngine(t);
  const { waitForWalToClear } = require("../engine/antigravity-db");
  const dbPath = path.join(root, "locked-wal.vscdb");
  fs.writeFileSync(dbPath, "x");
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64, 1));
  const walPath = `${dbPath}-wal`;
  const originalStat = fs.statSync;
  let failures = 0;
  fs.statSync = (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(walPath) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalStat(file, ...args);
  };
  t.after(() => { fs.statSync = originalStat; });
  let sleeps = 0;
  const cleared = await waitForWalToClear(dbPath, 2000, async () => {
    sleeps += 1;
    if (sleeps === 1 && fs.existsSync(walPath)) fs.unlinkSync(walPath);
  });
  assert.equal(failures, 2);
  assert.equal(sleeps, 1);
  assert.equal(cleared, true);
  assert.equal(fs.existsSync(walPath), false);
});

test("antigravity lists without secrets skip decrypt when token metadata is present", async (t) => {
  const { engine } = freshEngine(t);
  await engine.upsertAntigravityAccount({
    email: "meta@example.com",
    access_token: "ya29.meta",
    refresh_token: "1//meta",
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const listed = engine.listAntigravityAccts({ secrets: false });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].email, "meta@example.com");
  assert.equal(listed[0].tokens, null);
  assert.equal(decrypts.count, 0);
});

test("concurrent Antigravity upserts of the same identity keep one account", async (t) => {
  const { engine } = freshEngine(t);
  const [first, second] = await Promise.all([
    engine.upsertAntigravityAccount({
      email: "same-ag@example.com",
      access_token: "ya29.same-a",
      refresh_token: "1//same-a",
    }),
    engine.upsertAntigravityAccount({
      email: "same-ag@example.com",
      access_token: "ya29.same-b",
      refresh_token: "1//same-b",
    }),
  ]);
  assert.equal(engine.listAntigravityAccts().length, 1);
  assert.equal(first.account.id, second.account.id);
});

test("Antigravity upsert identity scan does not decrypt the rest of the vault", async (t) => {
  const { engine } = freshEngine(t);
  const keep = await engine.upsertAntigravityAccount({
    email: "keep-upsert@example.com",
    access_token: "ya29.keep-upsert",
    refresh_token: "1//keep-upsert",
  });
  await engine.upsertAntigravityAccount({
    email: "spare-upsert-a@example.com",
    access_token: "ya29.spare-a",
    refresh_token: "1//spare-a",
  });
  await engine.upsertAntigravityAccount({
    email: "spare-upsert-b@example.com",
    access_token: "ya29.spare-b",
    refresh_token: "1//spare-b",
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const created = await engine.upsertAntigravityAccount({
    email: "fresh-upsert@example.com",
    access_token: "ya29.fresh-upsert",
    refresh_token: "1//fresh-upsert",
  });
  assert.equal(created.updated, false);
  assert.notEqual(created.account.id, keep.account.id);
  assert.ok(decrypts.count <= 6);
  decrypts.reset();
  const again = await engine.upsertAntigravityAccount({
    email: "keep-upsert@example.com",
    access_token: "ya29.keep-upsert-again",
    refresh_token: "1//keep-upsert-again",
  });
  assert.equal(again.updated, true);
  assert.equal(again.account.id, keep.account.id);
  assert.ok(decrypts.count <= 6);
});

test("antigravity official sync matches identity without decrypting other accounts", async (t) => {
  const { engine, root } = freshEngine(t);
  const keep = await engine.upsertAntigravityAccount({
    email: "keep-sync@example.com",
    access_token: "ya29.keep-sync",
    refresh_token: "1//keep-sync",
  });
  await engine.upsertAntigravityAccount({
    email: "spare-sync@example.com",
    access_token: "ya29.spare-sync",
    refresh_token: "1//spare-sync",
  });
  const dbPath = path.join(root, "sync-secrets.vscdb");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.keep-sync",
    refresh_token: "1//keep-sync",
  });
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    execFile: async () => ({ stdout: "" }),
    httpJson: async () => ({ status: 404, body: "{}" }),
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const current = await engine.syncCurrentAntigravityFromOfficial({ force: true });
  assert.equal(current.id, keep.account.id);
  assert.ok(decrypts.count >= 1);
  assert.ok(decrypts.count < 4);
});

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
  const previousLocal = process.env.LOCALAPPDATA;
  process.env.APPDATA = root;
  process.env.LOCALAPPDATA = path.join(root, "Local");
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
    if (previousLocal == null) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocal;
    fs.rmSync(root, { recursive: true, force: true });
    clearEngineModules();
  }
});

test("antigravity prefers Hub user data when Hub exe is installed even if leftover IDE vscdb exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ag-hub-paths-"));
  const previous = process.env.APPDATA;
  const previousLocal = process.env.LOCALAPPDATA;
  process.env.APPDATA = path.join(root, "Roaming");
  process.env.LOCALAPPDATA = path.join(root, "Local");
  clearEngineModules();
  try {
    const ideDb = path.join(root, "Roaming", "Antigravity IDE", "User", "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(ideDb), { recursive: true });
    fs.writeFileSync(ideDb, "db");
    const hubExe = path.join(root, "Local", "Programs", "antigravity", "Antigravity.exe");
    fs.mkdirSync(path.dirname(hubExe), { recursive: true });
    fs.writeFileSync(hubExe, "fake");
    const runtime = require("../engine/antigravity-runtime");
    assert.equal(runtime.firstExistingExe(), hubExe);
    assert.equal(runtime.preferUserDataDir(), path.join(root, "Roaming", "Antigravity"));
    assert.equal(runtime.usesWindowsSystemCredential(hubExe), true);
    assert.equal(runtime.usesWindowsSystemCredential(path.join(root, "Antigravity IDE.exe")), false);
  } finally {
    if (previous == null) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
    if (previousLocal == null) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocal;
    fs.rmSync(root, { recursive: true, force: true });
    clearEngineModules();
  }
});

test("antigravity still prefers Hub user data when existsSync reports Hub files missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ag-hub-lie-"));
  const previous = process.env.APPDATA;
  const previousLocal = process.env.LOCALAPPDATA;
  process.env.APPDATA = path.join(root, "Roaming");
  process.env.LOCALAPPDATA = path.join(root, "Local");
  clearEngineModules();
  const originalExists = fs.existsSync;
  try {
    const ideDb = path.join(root, "Roaming", "Antigravity IDE", "User", "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(ideDb), { recursive: true });
    fs.writeFileSync(ideDb, "db");
    const hubExe = path.join(root, "Local", "Programs", "antigravity", "Antigravity.exe");
    fs.mkdirSync(path.dirname(hubExe), { recursive: true });
    fs.writeFileSync(hubExe, "fake");
    fs.existsSync = (file) => {
      if (path.resolve(String(file)) === path.resolve(hubExe)) return false;
      return originalExists(file);
    };
    const runtime = require("../engine/antigravity-runtime");
    assert.equal(runtime.firstExistingExe(), hubExe);
    assert.equal(runtime.preferUserDataDir(), path.join(root, "Roaming", "Antigravity"));
  } finally {
    fs.existsSync = originalExists;
    if (previous == null) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
    if (previousLocal == null) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocal;
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

test("a corrupt Antigravity index still restores from backup", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertAntigravityAccount({
    email: "idx-ag-bak@example.com",
    access_token: "ya29.idx-ag-bak",
    refresh_token: "1//idx-ag-bak",
  });
  engine.setCurrentAntigravityAccountId(created.account.id);
  const config = require("../engine/config");
  fs.writeFileSync(`${config.ANTIGRAVITY_IDX_PATH}.bak`, fs.readFileSync(config.ANTIGRAVITY_IDX_PATH, "utf8"), "utf8");
  fs.writeFileSync(config.ANTIGRAVITY_IDX_PATH, "{ corrupted", "utf8");
  const loaded = engine.loadAntigravityIdx();
  assert.equal(loaded.current_antigravity_account_id, created.account.id);
  assert.ok(loaded.accounts.some((item) => item.id === created.account.id));
  assert.equal(JSON.parse(fs.readFileSync(config.ANTIGRAVITY_IDX_PATH, "utf8")).current_antigravity_account_id, created.account.id);
});

test("a corrupt Antigravity index does not resurrect a deleted account from backup", async (t) => {
  const { engine } = freshEngine(t);
  const first = await engine.upsertAntigravityAccount({
    email: "idx-ag-ghost-a@example.com",
    access_token: "ya29.idx-ag-ghost-a",
    refresh_token: "1//idx-ag-ghost-a",
  });
  const second = await engine.upsertAntigravityAccount({
    email: "idx-ag-ghost-b@example.com",
    access_token: "ya29.idx-ag-ghost-b",
    refresh_token: "1//idx-ag-ghost-b",
  });
  engine.setCurrentAntigravityAccountId(second.account.id);
  const config = require("../engine/config");
  fs.writeFileSync(`${config.ANTIGRAVITY_IDX_PATH}.bak`, fs.readFileSync(config.ANTIGRAVITY_IDX_PATH, "utf8"), "utf8");
  engine.deleteAntigravityAcct(second.account.id, { allowCurrent: true });
  fs.writeFileSync(config.ANTIGRAVITY_IDX_PATH, "{ corrupted", "utf8");
  const loaded = engine.loadAntigravityIdx();
  assert.equal(loaded.accounts.some((item) => item.id === second.account.id), false);
  assert.ok(loaded.accounts.some((item) => item.id === first.account.id));
  assert.notEqual(loaded.current_antigravity_account_id, second.account.id);
  assert.equal(engine.loadAntigravityAcct(second.account.id), null);
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
  let listed = [{ name: "Antigravity IDE.exe", pid: 2147483646, executablePath: exePath }];
  let listCalls = 0;
  const launched = [];
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    exePath: () => exePath,
    listProcesses: async () => {
      listCalls += 1;
      return listed;
    },
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
  assert.ok(listCalls <= 2, `listProcesses called ${listCalls} times`);
  assert.match(readEngineLogs(root), /Antigravity switch timings kill=\d+ms write=\d+ms/);
  const stored = await engine.readAntigravityAuth(dbPath, { copyFirst: false });
  assert.equal(stored.access_token, "ya29.next");
  assert.equal(stored.refresh_token, "1//next");
  const { OAUTH_ITEM_KEY } = require("../engine/antigravity-db");
  const { listKeys, withVscdbSync } = require("../engine/sqlite-native");
  const keys = withVscdbSync(dbPath, { readOnly: true }, (db) => listKeys(db));
  assert.deepEqual(keys, [OAUTH_ITEM_KEY]);
  assert.equal(engine.currentAntigravityAcct().id, created.account.id);
});

test("antigravity switch rolls back when the written login does not match the target", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "ag-state.vscdb");
  const exePath = path.join(root, "Antigravity IDE.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.keep",
    refresh_token: "1//keep",
    expiry_timestamp: 10,
  });
  const created = await engine.upsertAntigravityAccount({
    email: "ag-verify@example.com",
    access_token: "ya29.ag-verify",
    refresh_token: "1//ag-verify",
    expiry_timestamp: 99,
  });
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    exePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });
  const agDb = require("../engine/antigravity-db");
  const originalRead = agDb.readAntigravityAuth;
  agDb.readAntigravityAuth = async () => ({ access_token: "ya29.wrong" });
  t.after(() => { agDb.readAntigravityAuth = originalRead; });
  await assert.rejects(
    () => engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id)),
    /核对失败/,
  );
  agDb.readAntigravityAuth = originalRead;
  const stored = await engine.readAntigravityAuth(dbPath);
  assert.equal(stored.access_token, "ya29.keep");
  assert.equal(engine.currentAntigravityAcct().id, created.account.id);
});

test("antigravity switch does not roll back when leftover lock blocks post-write read", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "ag-state.vscdb");
  const exePath = path.join(root, "Antigravity IDE.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeAntigravityAuth(dbPath, {
    access_token: "ya29.keep",
    refresh_token: "1//keep",
    expiry_timestamp: 10,
  });
  const created = await engine.upsertAntigravityAccount({
    email: "ag-busy-keep@example.com",
    access_token: "ya29.ag-busy-keep",
    refresh_token: "1//ag-busy-keep",
    expiry_timestamp: 99,
  });
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    exePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });
  const agDb = require("../engine/antigravity-db");
  const originalRead = agDb.readAntigravityAuth;
  agDb.readAntigravityAuth = async () => {
    const error = new Error("SQLITE_BUSY: database is locked");
    error.code = "SQLITE_BUSY";
    throw error;
  };
  t.after(() => { agDb.readAntigravityAuth = originalRead; });
  const switched = await engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id));
  agDb.readAntigravityAuth = originalRead;
  assert.equal(switched.account.id, created.account.id);
  const stored = await engine.readAntigravityAuth(dbPath);
  assert.equal(stored.access_token, "ya29.ag-busy-keep");
  assert.equal(engine.currentAntigravityAcct().id, created.account.id);
});

test("antigravity switch returns the in-memory account without a final decrypt", async (t) => {
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
    email: "mem-switch@example.com",
    access_token: "ya29.mem-switch",
    refresh_token: "1//mem-switch",
    expiry_timestamp: 99,
  });
  await engine.upsertAntigravityAccount({
    email: "mem-spare@example.com",
    access_token: "ya29.mem-spare",
    refresh_token: "1//mem-spare",
    expiry_timestamp: 99,
  });
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => dbPath,
    exePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });
  const account = engine.loadAntigravityAcct(created.account.id);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const switched = await engine.doAntigravitySwitch(account);
  assert.equal(decrypts.count, 0);
  assert.equal(switched.account.id, created.account.id);
  assert.equal(switched.account.email, "mem-switch@example.com");
  assert.ok(switched.account.tokens?.access_token);
  assert.ok(switched.account.last_used);
  assert.equal(engine.currentAntigravityAcct().id, created.account.id);
  const stored = await engine.readAntigravityAuth(dbPath, { copyFirst: false });
  assert.equal(stored.access_token, "ya29.mem-switch");
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

test("antigravity quota parser reads nested summary groups and remaining objects", (t) => {
  const { engine } = freshEngine(t);
  const quota = engine.parseAntigravityUsage({
    currentTier: { id: "free-tier" },
  }, {}, {
    quotaSummary: {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "weekly", remaining: { remainingFraction: 0.4 }, resetTime: "2026-08-26T00:00:00Z" },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            { displayName: "Weekly limit", remainingFraction: 0.2, resetTime: "2026-08-26T00:00:00Z" },
          ],
        },
      ],
    },
  });
  assert.equal(quota.tier, "free-tier");
  assert.equal(quota.gemini_weekly_remaining, 40);
  assert.equal(quota.third_party_weekly_remaining, 20);
  assert.equal(quota.gemini_five_hour_remaining, null);
  assert.equal(quota.third_party_five_hour_remaining, null);
});

test("antigravity availability models at 100% do not invent family windows", (t) => {
  const { engine } = freshEngine(t);
  const quota = engine.parseAntigravityUsage({
    allowedTiers: [{ id: "free-tier", name: "Free", isDefault: true }],
  }, {
    models: [
      { displayName: "Gemini 3.5 Flash (Low)", quotaInfo: { remainingFraction: 1, resetTime: "2026-08-25T06:35:12Z" } },
      { displayName: "Claude Opus 4.6 (Thinking)", quotaInfo: { remainingFraction: 1 } },
    ],
  }, {});
  assert.equal(quota.tier, "free-tier");
  assert.equal(quota.gemini_weekly_remaining, null);
  assert.equal(quota.gemini_five_hour_remaining, null);
  assert.equal(quota.third_party_weekly_remaining, null);
  assert.equal(quota.third_party_five_hour_remaining, null);
  assert.equal(quota.models.length >= 2, true);
});

test("antigravity free-tier refresh without quota windows is not a probe failure", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertAntigravityAccount({
    email: "free@example.com",
    access_token: "ya29.free",
    refresh_token: "1//free",
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
  });
  engine.setAntigravityRuntimeForTests({
    oauthClient: () => ({ clientId: "id", clientSecret: "secret" }),
    httpJson: async (url) => {
      if (String(url).includes("loadCodeAssist")) {
        return {
          status: 200,
          body: JSON.stringify({
            allowedTiers: [{ id: "free-tier", name: "Free", isDefault: true }],
          }),
        };
      }
      if (String(url).includes("fetchAvailableModels")) {
        return {
          status: 200,
          body: JSON.stringify({
            models: [
              { displayName: "Gemini 3.5 Flash (Low)", quotaInfo: { remainingFraction: 1 } },
            ],
          }),
        };
      }
      return { status: 200, body: "{}" };
    },
  });
  await engine.refreshAntigravityQuota(engine.loadAntigravityAcct(created.account.id), { force: true });
  const latest = engine.loadAntigravityAcct(created.account.id);
  assert.equal(latest.quota.tier, "free-tier");
  assert.equal(latest.plan_type, "free-tier");
  assert.equal(latest.quota_error, null);
  assert.equal(latest.probe.status, "active");
  assert.equal(latest.quota.gemini_weekly_remaining, null);
});

test("antigravity unpaid standard-tier refresh without windows is not a probe failure", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertAntigravityAccount({
    email: "unpaid@example.com",
    access_token: "ya29.unpaid",
    refresh_token: "1//unpaid",
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
  });
  engine.setAntigravityRuntimeForTests({
    oauthClient: () => ({ clientId: "id", clientSecret: "secret" }),
    httpJson: async (url) => {
      if (String(url).includes("loadCodeAssist")) {
        return {
          status: 200,
          body: JSON.stringify({
            allowedTiers: [
              { id: "standard-tier", name: "Standard", isDefault: true },
              { id: "g1-pro-tier", name: "Pro" },
            ],
          }),
        };
      }
      return { status: 200, body: "{}" };
    },
  });
  await engine.refreshAntigravityQuota(engine.loadAntigravityAcct(created.account.id), { force: true });
  const latest = engine.loadAntigravityAcct(created.account.id);
  assert.equal(latest.quota.tier, "standard-tier");
  assert.equal(latest.plan_type, "standard-tier");
  assert.equal(latest.quota_error, null);
  assert.equal(latest.probe.status, "active");
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

test("antigravity quota parser ignores catalog model names and drops far 5h resets", (t) => {
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
  assert.equal(quota.gemini_five_hour_remaining, null);
  assert.equal(quota.gemini_five_hour_reset_time, null);
  assert.equal(quota.primary_model, null);
  assert.equal(quota.secondary_model, null);
});

test("antigravity catalog high/low model ids do not invent 5h windows", (t) => {
  const { engine } = freshEngine(t);
  const weeklyReset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const nearFiveHour = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const quota = engine.parseAntigravityUsage({
    currentTier: { id: "free-tier" },
  }, {
    models: [
      { name: "gemini-3.1-pro-high", displayName: "Gemini 3.1 Pro (High)", quotaInfo: { remainingFraction: 1, resetTime: weeklyReset } },
      { name: "gemini-3.5-flash-low", displayName: "Gemini 3.5 Flash (Low)", quotaInfo: { remainingFraction: 1, resetTime: weeklyReset } },
      { name: "gemini-3.6-flash-high", quotaInfo: { remainingFraction: 1, resetTime: weeklyReset } },
    ],
  }, {
    groups: [{
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", remainingFraction: 1, resetTime: weeklyReset },
      ],
    }, {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", remainingFraction: 1, resetTime: weeklyReset },
      ],
    }],
  });
  assert.equal(quota.gemini_weekly_remaining, 100);
  assert.equal(quota.gemini_weekly_reset_time, weeklyReset);
  assert.equal(quota.third_party_weekly_remaining, 100);
  assert.equal(quota.gemini_five_hour_remaining, null);
  assert.equal(quota.third_party_five_hour_remaining, null);

  const pro = engine.parseAntigravityUsage({
    currentTier: { id: "g1-pro-tier" },
  }, {}, {
    groups: [{
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", remainingFraction: 1, resetTime: weeklyReset },
        { bucketId: "gemini-5h", remainingFraction: 0.8, resetTime: nearFiveHour },
      ],
    }],
  });
  assert.equal(pro.gemini_five_hour_remaining, 80);
  assert.equal(pro.gemini_five_hour_reset_time, nearFiveHour);
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
  assert.equal(quota.tier, "free-tier");
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

test("official oauth client extractor splits concatenated Hub secrets and prefers AuthProvider", () => {
  const { extractOfficialOauthClient } = require("../engine/antigravity-oauth-client");
  const extracted = extractOfficialOauthClient([
    "https://auth.cloud.google/authorize",
    "GOCSPX-oldHubSecretValueXXXX",
    "GOCSPX-newHubSecretValueXXXX",
    "https://oauth2.googleapis.com/token",
    "padding-".repeat(80),
    "884354919052-newhubclientidabc.apps.googleusercontent.com",
    "[AuthProvider] SetUserTier",
    "1071006060591-oldhubclientidabc.apps.googleusercontent.com",
    "unrelated-".repeat(40),
    "[AuthProvider] later unrelated",
    "[AuthProvider] also later",
  ].join(""));
  assert.equal(extracted.clientId, "884354919052-newhubclientidabc.apps.googleusercontent.com");
  assert.equal(extracted.clientSecret, "GOCSPX-newHubSecretValueXXXX");
});

test("official oauth client reads Hub language_server when app.asar has no google client", (t) => {
  const { engine, root } = freshEngine(t);
  const {
    readOfficialOauthClient,
    setOfficialOauthClientForTests,
    PUBLISHED_OFFICIAL_OAUTH_CLIENT,
  } = require("../engine/antigravity-oauth-client");
  const exe = path.join(root, "Antigravity.exe");
  fs.writeFileSync(exe, "x");
  const asar = path.join(root, "resources", "app.asar");
  engine.ensureDir(path.dirname(asar));
  fs.writeFileSync(asar, "chrome-devtools-mcp placeholder without google oauth");
  const languageServer = path.join(root, "resources", "bin", "language_server.exe");
  engine.ensureDir(path.dirname(languageServer));
  fs.writeFileSync(languageServer, [
    "https://auth.cloud.google/authorize",
    "GOCSPX-oldHubSecretValueXXXX",
    "GOCSPX-newHubSecretValueXXXX",
    "884354919052-newhubclientidabc.apps.googleusercontent.com",
    "[AuthProvider] SetUserTier",
    "1071006060591-oldhubclientidabc.apps.googleusercontent.com",
  ].join(""));
  setOfficialOauthClientForTests(null);
  t.after(() => setOfficialOauthClientForTests(null));
  const client = readOfficialOauthClient(exe);
  assert.equal(client.clientId, "884354919052-newhubclientidabc.apps.googleusercontent.com");
  assert.equal(client.clientSecret, "GOCSPX-newHubSecretValueXXXX");
  assert.equal(client.source, "official-ide");
  assert.notEqual(client.clientId, PUBLISHED_OFFICIAL_OAUTH_CLIENT.clientId);
});

test("official oauth client list keeps the published client as a refresh fallback", (t) => {
  const { engine, root } = freshEngine(t);
  const {
    listOfficialOauthClients,
    setOfficialOauthClientForTests,
    PUBLISHED_OFFICIAL_OAUTH_CLIENT,
  } = require("../engine/antigravity-oauth-client");
  const exe = path.join(root, "Antigravity.exe");
  fs.writeFileSync(exe, "x");
  const languageServer = path.join(root, "resources", "bin", "language_server.exe");
  engine.ensureDir(path.dirname(languageServer));
  fs.writeFileSync(languageServer, [
    "https://auth.cloud.google/authorize",
    "GOCSPX-oldHubSecretValueXXXX",
    "GOCSPX-newHubSecretValueXXXX",
    "884354919052-newhubclientidabc.apps.googleusercontent.com",
    "[AuthProvider] SetUserTier",
    "1071006060591-oldhubclientidabc.apps.googleusercontent.com",
  ].join(""));
  setOfficialOauthClientForTests(null);
  t.after(() => setOfficialOauthClientForTests(null));
  const clients = listOfficialOauthClients(exe);
  assert.equal(clients[0].clientId, "884354919052-newhubclientidabc.apps.googleusercontent.com");
  assert.equal(clients.some((item) => item.clientId === PUBLISHED_OFFICIAL_OAUTH_CLIENT.clientId), true);
  assert.equal(clients.length, 2);
});

test("antigravity token refresh retries the published client after invalid_client", async (t) => {
  const { engine, root } = freshEngine(t);
  const { setOfficialOauthClientForTests, PUBLISHED_OFFICIAL_OAUTH_CLIENT } = require("../engine/antigravity-oauth-client");
  const exe = path.join(root, "Antigravity.exe");
  fs.writeFileSync(exe, "x");
  const languageServer = path.join(root, "resources", "bin", "language_server.exe");
  engine.ensureDir(path.dirname(languageServer));
  fs.writeFileSync(languageServer, [
    "https://auth.cloud.google/authorize",
    "GOCSPX-oldHubSecretValueXXXX",
    "GOCSPX-newHubSecretValueXXXX",
    "884354919052-newhubclientidabc.apps.googleusercontent.com",
    "[AuthProvider] SetUserTier",
  ].join(""));
  setOfficialOauthClientForTests(null);
  t.after(() => setOfficialOauthClientForTests(null));
  const created = await engine.upsertAntigravityAccount({
    email: "retry-client@example.com",
    access_token: "ya29.expired",
    refresh_token: "1//retry-client",
    expiry_timestamp: 10,
  });
  const clientIds = [];
  engine.setAntigravityRuntimeForTests({
    exePath: () => exe,
    httpJson: async (_url, options) => {
      const body = String(options?.body || "");
      const match = /client_id=([^&]+)/.exec(body);
      clientIds.push(decodeURIComponent(match ? match[1] : ""));
      if (body.includes("884354919052")) {
        return { status: 401, body: JSON.stringify({ error: "invalid_client" }) };
      }
      if (body.includes(PUBLISHED_OFFICIAL_OAUTH_CLIENT.clientId.split("-")[0])) {
        return {
          status: 200,
          body: JSON.stringify({
            access_token: "ya29.from-published",
            expires_in: 3600,
          }),
        };
      }
      throw new Error(`unexpected token body ${body}`);
    },
  });
  const result = await engine.refreshAntigravityToken(
    engine.loadAntigravityAcct(created.account.id),
    { force: true },
  );
  assert.equal(result.ok, true);
  assert.equal(result.account.tokens.access_token, "ya29.from-published");
  assert.equal(result.account.requires_reauth, false);
  assert.deepEqual(clientIds, [
    "884354919052-newhubclientidabc.apps.googleusercontent.com",
    PUBLISHED_OFFICIAL_OAUTH_CLIENT.clientId,
  ]);
});

test("antigravity token refresh still marks reauth when every official client is invalid", async (t) => {
  const { engine, root } = freshEngine(t);
  const { setOfficialOauthClientForTests } = require("../engine/antigravity-oauth-client");
  const exe = path.join(root, "Antigravity.exe");
  fs.writeFileSync(exe, "x");
  const languageServer = path.join(root, "resources", "bin", "language_server.exe");
  engine.ensureDir(path.dirname(languageServer));
  fs.writeFileSync(languageServer, [
    "https://auth.cloud.google/authorize",
    "GOCSPX-oldHubSecretValueXXXX",
    "GOCSPX-newHubSecretValueXXXX",
    "884354919052-newhubclientidabc.apps.googleusercontent.com",
    "[AuthProvider] SetUserTier",
  ].join(""));
  setOfficialOauthClientForTests(null);
  t.after(() => setOfficialOauthClientForTests(null));
  const created = await engine.upsertAntigravityAccount({
    email: "dead-client@example.com",
    access_token: "ya29.expired",
    refresh_token: "1//dead-client",
    expiry_timestamp: 10,
  });
  let posts = 0;
  engine.setAntigravityRuntimeForTests({
    exePath: () => exe,
    httpJson: async () => {
      posts += 1;
      return { status: 401, body: JSON.stringify({ error: "invalid_client" }) };
    },
  });
  const result = await engine.refreshAntigravityToken(
    engine.loadAntigravityAcct(created.account.id),
    { force: true },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reauthRequired, true);
  assert.equal(posts, 2);
  assert.equal(engine.loadAntigravityAcct(created.account.id).requires_reauth, true);
});

test("antigravity authorization_code exchange does not retry the published client", async (t) => {
  const { root } = freshEngine(t);
  const { setOfficialOauthClientForTests } = require("../engine/antigravity-oauth-client");
  const { exchangeGoogleToken } = require("../engine/antigravity-token");
  const { setAntigravityRuntimeForTests } = require("../engine/antigravity-runtime");
  const exe = path.join(root, "Antigravity.exe");
  fs.writeFileSync(exe, "x");
  const languageServer = path.join(root, "resources", "bin", "language_server.exe");
  fs.mkdirSync(path.dirname(languageServer), { recursive: true });
  fs.writeFileSync(languageServer, [
    "https://auth.cloud.google/authorize",
    "GOCSPX-oldHubSecretValueXXXX",
    "GOCSPX-newHubSecretValueXXXX",
    "884354919052-newhubclientidabc.apps.googleusercontent.com",
    "[AuthProvider] SetUserTier",
  ].join(""));
  setOfficialOauthClientForTests(null);
  t.after(() => setOfficialOauthClientForTests(null));
  let posts = 0;
  setAntigravityRuntimeForTests({
    exePath: () => exe,
    httpJson: async () => {
      posts += 1;
      return { status: 401, body: JSON.stringify({ error: "invalid_client" }) };
    },
  });
  const { response, payload } = await exchangeGoogleToken({
    grant_type: "authorization_code",
    code: "4/unused",
    redirect_uri: "http://localhost:51121/oauth-callback",
  });
  assert.equal(response.status, 401);
  assert.equal(payload.error, "invalid_client");
  assert.equal(posts, 1);
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

test("official oauth client retries a transient lock instead of using the published fallback", (t) => {
  const { engine, root } = freshEngine(t);
  const {
    readOfficialOauthClient,
    setOfficialOauthClientForTests,
    PUBLISHED_OFFICIAL_OAUTH_CLIENT,
  } = require("../engine/antigravity-oauth-client");
  const exe = path.join(root, "Antigravity.exe");
  fs.writeFileSync(exe, "x");
  const mainJs = path.join(root, "resources", "app", "out", "main.js");
  engine.ensureDir(path.dirname(mainJs));
  fs.writeFileSync(mainJs, `
    module.exports.oauthClient = {
      client_id: "1071006060591-locked.apps.googleusercontent.com",
      client_secret: "GOCSPX-lockedSecret",
    };
  `);
  setOfficialOauthClientForTests(null);
  const originalRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(mainJs) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => {
    fs.readFileSync = originalRead;
    setOfficialOauthClientForTests(null);
  });
  const client = readOfficialOauthClient(exe);
  assert.equal(client.clientId, "1071006060591-locked.apps.googleusercontent.com");
  assert.equal(client.clientSecret, "GOCSPX-lockedSecret");
  assert.equal(client.source, "official-ide");
  assert.notEqual(client.clientId, PUBLISHED_OFFICIAL_OAUTH_CLIENT.clientId);
  assert.equal(failures, 2);
});

test("official oauth client still reads the IDE file when existsSync reports it missing", (t) => {
  const { engine, root } = freshEngine(t);
  const {
    readOfficialOauthClient,
    setOfficialOauthClientForTests,
    PUBLISHED_OFFICIAL_OAUTH_CLIENT,
  } = require("../engine/antigravity-oauth-client");
  const exe = path.join(root, "Antigravity.exe");
  fs.writeFileSync(exe, "x");
  const mainJs = path.join(root, "resources", "app", "out", "main.js");
  engine.ensureDir(path.dirname(mainJs));
  fs.writeFileSync(mainJs, `
    module.exports.oauthClient = {
      client_id: "1071006060591-existslie.apps.googleusercontent.com",
      client_secret: "GOCSPX-existsLieSecret",
    };
  `);
  setOfficialOauthClientForTests(null);
  const originalExists = fs.existsSync;
  fs.existsSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(mainJs)) return false;
    return originalExists(file);
  };
  t.after(() => {
    fs.existsSync = originalExists;
    setOfficialOauthClientForTests(null);
  });
  const client = readOfficialOauthClient(exe);
  assert.equal(client.clientId, "1071006060591-existslie.apps.googleusercontent.com");
  assert.equal(client.clientSecret, "GOCSPX-existsLieSecret");
  assert.equal(client.source, "official-ide");
  assert.notEqual(client.clientId, PUBLISHED_OFFICIAL_OAUTH_CLIENT.clientId);
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

test("antigravity pending oauth is not cleared on a non-JSON filesystem error", async (t) => {
  process.env.ANTIGRAVITY_MANAGER_CALLBACK_PORT = String(18000 + Math.floor(Math.random() * 2000));
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  engine.setAntigravityRuntimeForTests({
    openUrl: async () => {},
    oauthClient: () => ({
      clientId: "1234567890-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-test",
    }),
  });
  const login = engine.antigravityLoginFlow().catch((error) => error);
  const pendingPath = config.ANTIGRAVITY_OAUTH_PENDING_PATH;
  const startedAt = Date.now();
  while (!fs.existsSync(pendingPath) && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const envelope = fs.readFileSync(pendingPath, "utf8");
  engine.cancelAntigravityOAuth();
  await login;

  fs.writeFileSync(pendingPath, envelope, "utf8");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (target, encoding) => {
    if (path.resolve(String(target)) === path.resolve(pendingPath)) {
      const error = new Error("EISDIR: illegal operation on a directory");
      error.code = "EISDIR";
      throw error;
    }
    return originalRead(target, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  engine.setAntigravityRuntimeForTests({
    openUrl: async () => {},
    oauthClient: () => ({
      clientId: "1234567890-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-test",
    }),
  });
  assert.equal(engine.restorePendingAntigravityOAuth(), false);
  fs.readFileSync = originalRead;
  assert.equal(fs.readFileSync(pendingPath, "utf8"), envelope);
  assert.equal(engine.restorePendingAntigravityOAuth(), true);
  try {
    assert.equal(engine.getAntigravityOAuthStatus().pending, true);
  } finally {
    engine.cancelAntigravityOAuth();
  }
});

test("antigravity pending oauth still restores from backup after persistent corruption", async (t) => {
  process.env.ANTIGRAVITY_MANAGER_CALLBACK_PORT = String(18000 + Math.floor(Math.random() * 2000));
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  engine.setAntigravityRuntimeForTests({
    openUrl: async () => {},
    oauthClient: () => ({
      clientId: "1234567890-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-test",
    }),
  });
  const login = engine.antigravityLoginFlow().catch((error) => error);
  const pendingPath = config.ANTIGRAVITY_OAUTH_PENDING_PATH;
  const startedAt = Date.now();
  while (!fs.existsSync(pendingPath) && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const envelope = fs.readFileSync(pendingPath, "utf8");
  engine.cancelAntigravityOAuth();
  await login;

  fs.writeFileSync(`${pendingPath}.bak`, envelope, "utf8");
  fs.writeFileSync(pendingPath, "{ corrupted", "utf8");
  engine.setAntigravityRuntimeForTests({
    openUrl: async () => {},
    oauthClient: () => ({
      clientId: "1234567890-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-test",
    }),
  });
  assert.equal(engine.restorePendingAntigravityOAuth(), true);
  try {
    assert.equal(engine.getAntigravityOAuthStatus().pending, true);
    assert.equal(JSON.parse(fs.readFileSync(pendingPath, "utf8")).protected_payload.length > 0, true);
  } finally {
    engine.cancelAntigravityOAuth();
  }
});

test("antigravity oauth cancel releases the callback port before listen finishes", async (t) => {
  process.env.ANTIGRAVITY_MANAGER_CALLBACK_PORT = String(18000 + Math.floor(Math.random() * 2000));
  const { engine } = freshEngine(t);
  engine.setAntigravityRuntimeForTests({
    openUrl: async () => {},
    oauthClient: () => ({
      clientId: "1234567890-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-test",
    }),
  });
  const login = engine.antigravityLoginFlow().catch((error) => error);
  assert.equal(engine.cancelAntigravityOAuth(), true);
  await login;
  const config = require("../engine/config");
  const { createCallbackListener } = require("../engine/antigravity-oauth");
  const listener = createCallbackListener({
    callbackPort: config.ANTIGRAVITY_CALLBACK_PORT,
    state: "port-check",
  });
  try {
    await listener.ready;
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

test("antigravity hub credential payload uses consumer auth_method", () => {
  const { buildAntigravityCredentialPayload, parseCredentialBlob } = require("../engine/antigravity-credential");
  const payload = JSON.parse(buildAntigravityCredentialPayload({
    tokens: {
      access_token: "ya29.hub",
      refresh_token: "1//hub",
      token_type: "Bearer",
      expiry_timestamp: 1_787_000_000,
    },
  }));
  assert.equal(payload.auth_method, "consumer");
  assert.equal(payload.token.access_token, "ya29.hub");
  assert.equal(payload.token.refresh_token, "1//hub");
  assert.equal(payload.token.token_type, "Bearer");
  assert.match(payload.token.expiry, /Z$/);
  const parsed = parseCredentialBlob(JSON.stringify(payload));
  assert.equal(parsed.refresh_token, "1//hub");
  assert.equal(parsed.access_token, "ya29.hub");
});

test("antigravity credential write overwrites without deleting first", async () => {
  const { writeWindowsAntigravityCredential } = require("../engine/antigravity-credential");
  let script = "";
  let fsyncedBeforeRead = false;
  const originalFsync = fs.fsyncSync;
  let fsyncs = 0;
  fs.fsyncSync = (fd) => {
    fsyncs += 1;
    return originalFsync(fd);
  };
  try {
    const ok = await writeWindowsAntigravityCredential({
      tokens: { access_token: "ya29.overwrite", refresh_token: "1//overwrite" },
    }, async (_file, args) => {
      fsyncedBeforeRead = fsyncs >= 1;
      script = String(args[args.indexOf("-Command") + 1] || "");
      return { stdout: "", stderr: "" };
    });
    assert.equal(ok, true);
    assert.equal(fsyncedBeforeRead, true);
    assert.match(script, /CredWrite/);
    assert.doesNotMatch(script, /CredDelete\(/);
  } finally {
    fs.fsyncSync = originalFsync;
  }
});

test("antigravity credential writes retry when the temp payload is locked", async (t) => {
  const { writeWindowsAntigravityCredential } = require("../engine/antigravity-credential");
  const originalWrite = fs.writeFileSync;
  let failures = 0;
  fs.writeFileSync = (file, content, encoding) => {
    if (String(file).endsWith("payload.json") && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalWrite(file, content, encoding);
  };
  t.after(() => { fs.writeFileSync = originalWrite; });
  const ok = await writeWindowsAntigravityCredential({
    tokens: { access_token: "ya29.retry", refresh_token: "1//retry" },
  }, async () => ({ stdout: "", stderr: "" }));
  assert.equal(ok, true);
  assert.equal(failures, 2);
});

test("antigravity credential cleanup retries a locked temp payload", async (t) => {
  const { writeWindowsAntigravityCredential } = require("../engine/antigravity-credential");
  const originalUnlink = fs.unlinkSync;
  const originalRm = fs.rmSync;
  let unlinkFailures = 0;
  let leftoverDir = null;
  fs.unlinkSync = (file) => {
    if (String(file).endsWith("payload.json") && unlinkFailures < 2) {
      leftoverDir = path.dirname(String(file));
      unlinkFailures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalUnlink(file);
  };
  fs.rmSync = (dir, options) => {
    if (fs.existsSync(path.join(String(dir), "payload.json"))) {
      const error = new Error("ENOTEMPTY: directory not empty");
      error.code = "ENOTEMPTY";
      throw error;
    }
    return originalRm(dir, options);
  };
  t.after(() => {
    fs.unlinkSync = originalUnlink;
    fs.rmSync = originalRm;
  });
  const ok = await writeWindowsAntigravityCredential({
    tokens: { access_token: "ya29.clean", refresh_token: "1//clean" },
  }, async () => ({ stdout: "", stderr: "" }));
  assert.equal(ok, true);
  assert.equal(unlinkFailures, 2);
  assert.ok(leftoverDir);
  assert.equal(fs.existsSync(path.join(leftoverDir, "payload.json")), false);
});

test("antigravity launch starts Hub through the Windows shell with user-data-dir", () => {
  const runtime = require("../engine/antigravity-runtime");
  const spawned = [];
  const fakeCp = {
    spawn(file, args, options) {
      spawned.push({ file, args, options });
      return { once() {}, unref() {} };
    },
  };
  const exePath = "C:\\Users\\a\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe";
  const userDataDir = "C:\\Users\\a\\AppData\\Roaming\\Antigravity";
  runtime.launchAntigravity(exePath, fakeCp, { userDataDir });
  assert.equal(spawned.length, 1);
  assert.match(String(spawned[0].file), /cmd(\.exe)?$/i);
  assert.equal(spawned[0].args.includes("start"), true);
  assert.equal(spawned[0].args.includes(exePath), true);
  assert.equal(spawned[0].args.includes("--user-data-dir"), true);
  assert.equal(spawned[0].args.includes(userDataDir), true);
  assert.equal(spawned[0].args.includes("--reuse-window"), true);
  assert.equal(spawned[0].options.windowsHide, true);
  assert.equal(spawned[0].options.detached, true);
});

test("antigravity hub switch writes system credential and launches without touching leftover vscdb", async (t) => {
  const { engine, root } = freshEngine(t);
  const leftover = path.join(root, "leftover.vscdb");
  await engine.writeAntigravityAuth(leftover, {
    access_token: "ya29.old-ide",
    refresh_token: "1//old-ide",
    expiry_timestamp: 10,
  });
  const exePath = path.join(root, "Programs", "antigravity", "Antigravity.exe");
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, "fake");
  const created = await engine.upsertAntigravityAccount({
    email: "hub@example.com",
    access_token: "ya29.hub",
    refresh_token: "1//hub",
    expiry_timestamp: 99,
  });
  const launched = [];
  const credentials = [];
  const locks = [];
  const order = [];
  let living = [{ name: "Antigravity.exe", pid: 2147483646, executablePath: exePath }];
  let storedCred = null;
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => leftover,
    exePath: () => exePath,
    userDataDir: () => path.join(root, "Antigravity"),
    listProcesses: async () => living,
    gracefulClose: async () => {
      order.push("kill");
      living = [];
      return true;
    },
    forceClose: async () => true,
    writeSystemCredential: async (account) => {
      order.push("write");
      credentials.push(account.email);
      storedCred = { access_token: account.tokens.access_token };
      return true;
    },
    readSystemCredential: async () => {
      order.push(storedCred ? "verify" : "snapshot");
      return storedCred;
    },
    restoreSystemCredential: async () => true,
    clearStaleLock: (dir) => { locks.push(dir); },
    launch: (target, options) => {
      launched.push({ target, options });
      return true;
    },
    sleep: async () => {},
  });
  const switched = await engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id));
  assert.equal(switched.launched, true);
  assert.deepEqual(credentials, ["hub@example.com"]);
  assert.deepEqual(order.filter((step) => step === "kill" || step === "snapshot" || step === "write"), [
    "kill",
    "snapshot",
    "write",
  ]);
  assert.equal(launched[0].target, exePath);
  assert.equal(launched[0].options.userDataDir, path.join(root, "Antigravity"));
  assert.deepEqual(locks, [path.join(root, "Antigravity")]);
  const leftoverStored = await engine.readAntigravityAuth(leftover, { copyFirst: false });
  assert.equal(leftoverStored.refresh_token, "1//old-ide");
});

test("antigravity credential read throws when PowerShell fails instead of looking empty", async () => {
  const { READ_SCRIPT, readWindowsAntigravityCredential } = require("../engine/antigravity-credential");
  assert.match(READ_SCRIPT, /GetLastWin32Error/);
  assert.match(READ_SCRIPT, /1168/);
  assert.match(READ_SCRIPT, /CredRead failed/);
  await assert.rejects(
    () => readWindowsAntigravityCredential(async () => {
      throw new Error("credential store busy");
    }),
    /credential store busy/,
  );
  const missing = await readWindowsAntigravityCredential(async () => ({ stdout: "\n", stderr: "" }));
  assert.equal(missing, null);
});

test("antigravity hub switch rollback keeps the official credential when the real reader fails", async (t) => {
  const { engine, root } = freshEngine(t);
  const leftover = path.join(root, "leftover.vscdb");
  await engine.writeAntigravityAuth(leftover, {
    access_token: "ya29.old-ide",
    refresh_token: "1//old-ide",
    expiry_timestamp: 10,
  });
  const exePath = path.join(root, "Programs", "antigravity", "Antigravity.exe");
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, "fake");
  const created = await engine.upsertAntigravityAccount({
    email: "hub-read-throw@example.com",
    access_token: "ya29.hub-read-throw",
    refresh_token: "1//hub-read-throw",
    expiry_timestamp: 99,
  });
  const credentials = [];
  const restores = [];
  let living = [{ name: "Antigravity.exe", pid: 2147483646, executablePath: exePath }];
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => leftover,
    exePath: () => exePath,
    userDataDir: () => path.join(root, "Antigravity"),
    listProcesses: async () => living,
    gracefulClose: async () => {
      living = [];
      return true;
    },
    forceClose: async () => true,
    execFile: async () => {
      throw new Error("credential store busy");
    },
    writeSystemCredential: async (account) => {
      credentials.push(account.email);
      return true;
    },
    restoreSystemCredential: async (snapshot, runCommand) => {
      restores.push(snapshot);
      return require("../engine/antigravity-credential").restoreWindowsAntigravityCredential(snapshot, runCommand);
    },
    afterOfficialWrite: async () => {
      throw new Error("meta write failed");
    },
    clearStaleLock: () => {},
    launch: () => true,
    sleep: async () => {},
  });
  await assert.rejects(
    () => engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id)),
    /meta write failed/,
  );
  assert.deepEqual(credentials, ["hub-read-throw@example.com"]);
  assert.equal(restores.length, 1);
  assert.equal(restores[0].snapshotFailed, true);
});

test("antigravity credential restore does not delete after a failed snapshot", async () => {
  const { restoreWindowsAntigravityCredential } = require("../engine/antigravity-credential");
  let ran = 0;
  const result = await restoreWindowsAntigravityCredential({ snapshotFailed: true }, async () => {
    ran += 1;
    return { stdout: "" };
  });
  assert.equal(result, false);
  assert.equal(ran, 0);
});

test("antigravity credential restore still deletes a confirmed empty snapshot", async () => {
  const { restoreWindowsAntigravityCredential } = require("../engine/antigravity-credential");
  let ran = 0;
  await restoreWindowsAntigravityCredential(null, async () => {
    ran += 1;
    return { stdout: "" };
  });
  assert.equal(ran, 1);
});

test("antigravity credential delete failure is not reported as success", async () => {
  const { restoreWindowsAntigravityCredential } = require("../engine/antigravity-credential");
  await assert.rejects(
    () => restoreWindowsAntigravityCredential(null, async () => {
      throw new Error("CredDelete failed: 5");
    }),
    /CredDelete failed/,
  );
});

test("antigravity hub switch rollback keeps the official credential when snapshot failed", async (t) => {
  const { engine, root } = freshEngine(t);
  const leftover = path.join(root, "leftover.vscdb");
  await engine.writeAntigravityAuth(leftover, {
    access_token: "ya29.old-ide",
    refresh_token: "1//old-ide",
    expiry_timestamp: 10,
  });
  const exePath = path.join(root, "Programs", "antigravity", "Antigravity.exe");
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, "fake");
  const created = await engine.upsertAntigravityAccount({
    email: "hub-snap-fail@example.com",
    access_token: "ya29.hub-snap-fail",
    refresh_token: "1//hub-snap-fail",
    expiry_timestamp: 99,
  });
  const credentials = [];
  const restores = [];
  let living = [{ name: "Antigravity.exe", pid: 2147483646, executablePath: exePath }];
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => leftover,
    exePath: () => exePath,
    userDataDir: () => path.join(root, "Antigravity"),
    listProcesses: async () => living,
    gracefulClose: async () => {
      living = [];
      return true;
    },
    forceClose: async () => true,
    writeSystemCredential: async (account) => {
      credentials.push(account.email);
      return true;
    },
    readSystemCredential: async () => {
      throw new Error("credential store busy");
    },
    restoreSystemCredential: async (snapshot) => {
      restores.push(snapshot);
      return require("../engine/antigravity-credential").restoreWindowsAntigravityCredential(snapshot, async () => {
        throw new Error("delete must not run");
      });
    },
    afterOfficialWrite: async () => {
      throw new Error("meta write failed");
    },
    clearStaleLock: () => {},
    launch: () => true,
    sleep: async () => {},
  });
  await assert.rejects(
    () => engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id)),
    /meta write failed/,
  );
  assert.deepEqual(credentials, ["hub-snap-fail@example.com"]);
  assert.equal(restores.length, 1);
  assert.equal(restores[0].snapshotFailed, true);
});

test("antigravity still clears a lockfile when existsSync reports it missing", (t) => {
  const { root } = freshEngine(t);
  const userDataDir = path.join(root, "Antigravity");
  fs.mkdirSync(userDataDir, { recursive: true });
  const lockPath = path.join(userDataDir, "lockfile");
  fs.writeFileSync(lockPath, "lock");
  const originalExists = fs.existsSync;
  fs.existsSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(lockPath)) return false;
    return originalExists(file);
  };
  t.after(() => { fs.existsSync = originalExists; });
  const runtime = require("../engine/antigravity-runtime");
  assert.equal(runtime.clearStaleAntigravityLock(userDataDir), true);
  fs.existsSync = originalExists;
  assert.equal(fs.existsSync(lockPath), false);
});

test("antigravity hub switch still uses the exe when existsSync reports it missing", async (t) => {
  const { engine, root } = freshEngine(t);
  const leftover = path.join(root, "leftover.vscdb");
  await engine.writeAntigravityAuth(leftover, {
    access_token: "ya29.old-ide",
    refresh_token: "1//old-ide",
    expiry_timestamp: 10,
  });
  const exePath = path.join(root, "Programs", "antigravity", "Antigravity.exe");
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, "fake");
  const created = await engine.upsertAntigravityAccount({
    email: "hub-lie@example.com",
    access_token: "ya29.hub-lie",
    refresh_token: "1//hub-lie",
    expiry_timestamp: 99,
  });
  const credentials = [];
  let living = [{ name: "Antigravity.exe", pid: 2147483646, executablePath: exePath }];
  let storedCred = null;
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => leftover,
    exePath: () => exePath,
    userDataDir: () => path.join(root, "Antigravity"),
    listProcesses: async () => living,
    gracefulClose: async () => {
      living = [];
      return true;
    },
    forceClose: async () => true,
    writeSystemCredential: async (account) => {
      credentials.push(account.email);
      storedCred = { access_token: account.tokens.access_token };
      return true;
    },
    readSystemCredential: async () => storedCred,
    restoreSystemCredential: async () => true,
    clearStaleLock: () => {},
    launch: () => true,
    sleep: async () => {},
  });
  const originalExists = fs.existsSync;
  fs.existsSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(exePath)) return false;
    return originalExists(file);
  };
  t.after(() => { fs.existsSync = originalExists; });
  await engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id));
  assert.deepEqual(credentials, ["hub-lie@example.com"]);
  const leftoverStored = await engine.readAntigravityAuth(leftover, { copyFirst: false });
  assert.equal(leftoverStored.refresh_token, "1//old-ide");
});

test("antigravity hub switch rolls back when the written credential does not match", async (t) => {
  const { engine, root } = freshEngine(t);
  const leftover = path.join(root, "leftover.vscdb");
  const exePath = path.join(root, "Programs", "antigravity", "Antigravity.exe");
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, "fake");
  await engine.writeAntigravityAuth(leftover, {
    access_token: "ya29.keep-hub",
    refresh_token: "1//keep-hub",
    expiry_timestamp: 10,
  });
  const created = await engine.upsertAntigravityAccount({
    email: "hub-verify@example.com",
    access_token: "ya29.hub-verify",
    refresh_token: "1//hub-verify",
    expiry_timestamp: 99,
  });
  let living = [{ name: "Antigravity.exe", pid: 2147483646, executablePath: exePath }];
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => leftover,
    exePath: () => exePath,
    userDataDir: () => path.join(root, "Antigravity"),
    listProcesses: async () => living,
    gracefulClose: async () => {
      living = [];
      return true;
    },
    forceClose: async () => true,
    writeSystemCredential: async () => true,
    readSystemCredential: async () => ({ access_token: "ya29.wrong-hub" }),
    restoreSystemCredential: async () => true,
    clearStaleLock: () => {},
    launch: () => true,
    sleep: async () => {},
  });
  await assert.rejects(
    () => engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id)),
    /系统凭据写入后核对失败/,
  );
  const leftoverStored = await engine.readAntigravityAuth(leftover, { copyFirst: false });
  assert.equal(leftoverStored.access_token, "ya29.keep-hub");
});

test("antigravity hub switch does not roll back when leftover lock blocks credential read", async (t) => {
  const { engine, root } = freshEngine(t);
  const leftover = path.join(root, "leftover.vscdb");
  const exePath = path.join(root, "Programs", "antigravity", "Antigravity.exe");
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, "fake");
  await engine.writeAntigravityAuth(leftover, {
    access_token: "ya29.keep-hub-busy",
    refresh_token: "1//keep-hub-busy",
    expiry_timestamp: 10,
  });
  const created = await engine.upsertAntigravityAccount({
    email: "hub-busy@example.com",
    access_token: "ya29.hub-busy",
    refresh_token: "1//hub-busy",
    expiry_timestamp: 99,
  });
  let living = [{ name: "Antigravity.exe", pid: 2147483646, executablePath: exePath }];
  let storedCred = null;
  let restored = 0;
  let credentialReads = 0;
  engine.setAntigravityRuntimeForTests({
    vscdbPath: () => leftover,
    exePath: () => exePath,
    userDataDir: () => path.join(root, "Antigravity"),
    listProcesses: async () => living,
    gracefulClose: async () => {
      living = [];
      return true;
    },
    forceClose: async () => true,
    writeSystemCredential: async (account) => {
      storedCred = { access_token: account.tokens.access_token };
      return true;
    },
    readSystemCredential: async () => {
      credentialReads += 1;
      if (credentialReads === 1) return { access_token: "ya29.old-hub" };
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    },
    restoreSystemCredential: async () => {
      restored += 1;
      return true;
    },
    clearStaleLock: () => {},
    launch: () => true,
    sleep: async () => {},
  });
  const switched = await engine.doAntigravitySwitch(engine.loadAntigravityAcct(created.account.id));
  assert.equal(switched.account.id, created.account.id);
  assert.ok(credentialReads >= 2);
  assert.equal(storedCred.access_token, "ya29.hub-busy");
  assert.equal(restored, 0);
  assert.equal(engine.currentAntigravityAcct().id, created.account.id);
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

test("antigravity upsert after a corrupt index still auto-sets the saved account current", async (t) => {
  const { engine } = freshEngine(t);
  const first = await engine.upsertAntigravityAccount({
    email: "ag-corrupt-a@example.com",
    access_token: "ya29.ag-corrupt-a",
    refresh_token: "1//ag-corrupt-a",
    expiry_timestamp: 20,
  });
  const second = await engine.upsertAntigravityAccount({
    email: "ag-corrupt-b@example.com",
    access_token: "ya29.ag-corrupt-b",
    refresh_token: "1//ag-corrupt-b",
    expiry_timestamp: 30,
  });
  engine.setCurrentAntigravityAccountId(null);
  first.account.last_used = 200;
  engine.saveAntigravityAcct(first.account);
  second.account.last_used = 50;
  engine.saveAntigravityAcct(second.account);
  const config = require("../engine/config");
  try { fs.unlinkSync(`${config.ANTIGRAVITY_IDX_PATH}.bak`); } catch {}
  fs.writeFileSync(config.ANTIGRAVITY_IDX_PATH, "{ corrupted", "utf8");
  const again = await engine.upsertAntigravityAccount({
    email: "ag-corrupt-b@example.com",
    access_token: "ya29.ag-corrupt-b",
    refresh_token: "1//ag-corrupt-b",
    expiry_timestamp: 40,
  });
  assert.equal(again.account.id, second.account.id);
  assert.equal(engine.currentAntigravityAcct().id, second.account.id);
  assert.equal(engine.loadAntigravityIdx().current_antigravity_account_id, second.account.id);
});

test("antigravity collapse does not decrypt unique accounts", async (t) => {
  const { engine } = freshEngine(t);
  await engine.upsertAntigravityAccount({
    email: "unique-a@example.com",
    access_token: "ya29.unique-a",
    refresh_token: "1//unique-a",
  });
  await engine.upsertAntigravityAccount({
    email: "unique-b@example.com",
    access_token: "ya29.unique-b",
    refresh_token: "1//unique-b",
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  engine.collapseDuplicateAntigravityAccounts();
  assert.equal(engine.listAntigravityAccts({ secrets: false }).length, 2);
  assert.equal(decrypts.count, 0);
});

test("antigravity token refreshAll skips reauth accounts without decrypting them", async (t) => {
  const { engine } = freshEngine(t);
  const reauth = await engine.upsertAntigravityAccount({
    email: "need-reauth@example.com",
    access_token: "ya29.need-reauth",
    refresh_token: "1//need-reauth",
  });
  const stored = engine.loadAntigravityAcct(reauth.account.id);
  stored.requires_reauth = true;
  engine.saveAntigravityAcct(stored);
  await engine.upsertAntigravityAccount({
    email: "live-token@example.com",
    access_token: "ya29.live-token",
    refresh_token: "1//live-token",
  });
  engine.setAntigravityRuntimeForTests({
    oauthClient: () => ({ clientId: "id", clientSecret: "secret" }),
    httpJson: async () => ({
      status: 200,
      body: JSON.stringify({
        access_token: "ya29.refreshed",
        refresh_token: "1//live-token",
        expires_in: 3600,
      }),
    }),
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const summary = await engine.refreshAllAntigravityTokens(false);
  assert.equal(summary.results.find((item) => item.email === "need-reauth@example.com").reauthRequired, true);
  assert.equal(summary.results.find((item) => item.email === "live-token@example.com").ok, true);
  assert.ok(decrypts.count >= 1);
  assert.ok(decrypts.count < 3);
});

test("antigravity token refreshAll skips unexpired accounts without decrypting them", async (t) => {
  const { engine } = freshEngine(t);
  await engine.upsertAntigravityAccount({
    email: "fresh-ag-token@example.com",
    access_token: "ya29.fresh-ag-token",
    refresh_token: "1//fresh-ag-token",
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
  });
  engine.setAntigravityRuntimeForTests({
    oauthClient: () => ({ clientId: "id", clientSecret: "secret" }),
    httpJson: async () => {
      throw new Error("unexpired Antigravity tokens must not hit the token endpoint");
    },
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const summary = await engine.refreshAllAntigravityTokens(false);
  assert.equal(summary.results[0].ok, true);
  assert.equal(summary.results[0].skipped, true);
  assert.equal(decrypts.count, 0);
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

test("antigravity current IPC reuses listed accounts without extra decrypts", async (t) => {
  const { engine } = freshEngine(t);
  const current = await engine.upsertAntigravityAccount({
    email: "ipc-current@example.com",
    access_token: "ya29.ipc-current",
    refresh_token: "1//ipc-current",
  });
  await engine.upsertAntigravityAccount({
    email: "ipc-spare@example.com",
    access_token: "ya29.ipc-spare",
    refresh_token: "1//ipc-spare",
  });
  engine.setCurrentAntigravityAccountId(current.account.id);
  const handlers = new Map();
  delete require.cache[require.resolve("../src/main/ipc-handlers")];
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, {
    electron: {
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      BrowserWindow: { getAllWindows: () => [] },
      app: { getVersion: () => "2.0.1", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await handlers.get("antigravity:current")({}, { skipOfficialSync: true });
  assert.equal(result.success, true);
  assert.equal(result.data.id, current.account.id);
  assert.equal(result.data.email, "ipc-current@example.com");
  assert.equal(result.data.tokens, undefined);
  assert.equal(decrypts.count, 0);
});

test("antigravity refreshAll publishes from the in-memory account without a second decrypt", async (t) => {
  const { engine } = freshEngine(t);
  const first = await engine.upsertAntigravityAccount({
    email: "batch-one@example.com",
    access_token: "ya29.batch-one",
    refresh_token: "1//batch-one",
  });
  const second = await engine.upsertAntigravityAccount({
    email: "batch-two@example.com",
    access_token: "ya29.batch-two",
    refresh_token: "1//batch-two",
  });
  engine.refreshAntigravityQuota = async (account) => {
    account.quota = { plan: "google-one" };
    return account.quota;
  };
  const handlers = new Map();
  delete require.cache[require.resolve("../src/main/ipc-handlers")];
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, {
    electron: {
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      BrowserWindow: { getAllWindows: () => [] },
      app: { getVersion: () => "2.0.1", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await handlers.get("antigravity:refreshAllQuotas")({});
  assert.equal(result.success, true);
  assert.equal(result.data.length, 2);
  assert.equal(result.data.find((item) => item.id === first.account.id).quota.plan, "google-one");
  assert.equal(result.data.find((item) => item.id === second.account.id).quota.plan, "google-one");
  assert.equal(decrypts.count, 2);

  engine.refreshAntigravityQuota = async (account) => {
    account.requires_reauth = true;
    account.quota_error = { code: "reauthorization_required", message: "expired", timestamp: 1 };
    return account.quota;
  };
  decrypts.reset();
  const skipped = await handlers.get("antigravity:refreshAllQuotas")({});
  assert.equal(skipped.success, true);
  assert.ok(skipped.data.every((item) => item.skipped === true && item.reason === "reauthorization_required"));
  assert.equal(decrypts.count, 2);
});

test("antigravity refreshAll skips persisted reauth accounts without decrypting them", async (t) => {
  const { engine } = freshEngine(t);
  const reauth = await engine.upsertAntigravityAccount({
    email: "batch-reauth@example.com",
    access_token: "ya29.batch-reauth",
    refresh_token: "1//batch-reauth",
  });
  const stored = engine.loadAntigravityAcct(reauth.account.id);
  stored.requires_reauth = true;
  engine.saveAntigravityAcct(stored);
  const live = await engine.upsertAntigravityAccount({
    email: "batch-live@example.com",
    access_token: "ya29.batch-live",
    refresh_token: "1//batch-live",
  });
  engine.refreshAntigravityQuota = async (account) => {
    account.quota = { plan: "google-one" };
    return account.quota;
  };
  const handlers = new Map();
  delete require.cache[require.resolve("../src/main/ipc-handlers")];
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, {
    electron: {
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      BrowserWindow: { getAllWindows: () => [] },
      app: { getVersion: () => "2.0.3", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await handlers.get("antigravity:refreshAllQuotas")({});
  assert.equal(result.success, true);
  const skipped = result.data.find((item) => item.id === reauth.account.id);
  const okRow = result.data.find((item) => item.id === live.account.id);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "reauthorization_required");
  assert.equal(okRow.quota.plan, "google-one");
  assert.equal(decrypts.count, 1);
});

test("antigravity switch IPC decrypts the target once before switching", async (t) => {
  const { engine } = freshEngine(t);
  const current = await engine.upsertAntigravityAccount({
    email: "switch-current@example.com",
    access_token: "ya29.switch-current",
    refresh_token: "1//switch-current",
  });
  const target = await engine.upsertAntigravityAccount({
    email: "switch-target@example.com",
    access_token: "ya29.switch-target",
    refresh_token: "1//switch-target",
  });
  await engine.upsertAntigravityAccount({
    email: "switch-spare@example.com",
    access_token: "ya29.switch-spare",
    refresh_token: "1//switch-spare",
  });
  engine.setCurrentAntigravityAccountId(current.account.id);
  const switched = [];
  engine.doAntigravitySwitch = async (account) => {
    switched.push(account);
    return { already: false, account };
  };
  const handlers = new Map();
  delete require.cache[require.resolve("../src/main/ipc-handlers")];
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, {
    electron: {
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      BrowserWindow: { getAllWindows: () => [] },
      app: { getVersion: () => "2.0.1", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const missing = await handlers.get("antigravity:switch")({}, "antigravity_missing");
  assert.equal(missing.success, false);
  assert.equal(switched.length, 0);
  assert.equal(decrypts.count, 0);

  decrypts.reset();
  const result = await handlers.get("antigravity:switch")({}, target.account.id);
  assert.equal(result.success, true);
  assert.equal(result.data.account.id, target.account.id);
  assert.equal(switched.length, 1);
  assert.ok(switched[0].tokens?.access_token);
  assert.equal(decrypts.count, 1);
});

test("antigravity reauthorize IPC does not decrypt before starting OAuth", async (t) => {
  const { engine } = freshEngine(t);
  const current = await engine.upsertAntigravityAccount({
    email: "reauth-current@example.com",
    access_token: "ya29.reauth-current",
    refresh_token: "1//reauth-current",
  });
  await engine.upsertAntigravityAccount({
    email: "reauth-spare@example.com",
    access_token: "ya29.reauth-spare",
    refresh_token: "1//reauth-spare",
  });
  const started = [];
  engine.antigravityLoginFlow = async (options) => {
    started.push(options?.targetAccountId || null);
    return { account: current.account, mismatch: false, targetAccountId: current.account.id };
  };
  const handlers = new Map();
  delete require.cache[require.resolve("../src/main/ipc-handlers")];
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, {
    electron: {
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      BrowserWindow: { getAllWindows: () => [] },
      app: { getVersion: () => "2.0.1", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const missing = await handlers.get("antigravity:reauthorize")({}, "antigravity_missing");
  assert.equal(missing.success, false);
  assert.equal(started.length, 0);
  assert.equal(decrypts.count, 0);

  decrypts.reset();
  const result = await handlers.get("antigravity:reauthorize")({}, current.account.id);
  assert.equal(result.success, true);
  assert.equal(result.data.targetAccountId, current.account.id);
  assert.deepEqual(started, [current.account.id]);
  assert.equal(decrypts.count, 0);
});

test("antigravity delete IPC removes a spare account without decrypting", async (t) => {
  const { engine } = freshEngine(t);
  const current = await engine.upsertAntigravityAccount({
    email: "del-current@example.com",
    access_token: "ya29.del-current",
    refresh_token: "1//del-current",
  });
  const spare = await engine.upsertAntigravityAccount({
    email: "del-spare@example.com",
    access_token: "ya29.del-spare",
    refresh_token: "1//del-spare",
  });
  engine.setCurrentAntigravityAccountId(current.account.id);
  const handlers = new Map();
  delete require.cache[require.resolve("../src/main/ipc-handlers")];
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, {
    electron: {
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      BrowserWindow: { getAllWindows: () => [] },
      app: { getVersion: () => "2.0.1", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const blocked = await handlers.get("antigravity:delete")({}, current.account.id);
  assert.equal(blocked.success, false);
  assert.match(String(blocked.error), /Switch to another account/);
  assert.equal(engine.listAntigravityAccts({ secrets: false }).length, 2);
  assert.equal(decrypts.count, 0);

  decrypts.reset();
  const removed = await handlers.get("antigravity:delete")({}, spare.account.id);
  assert.equal(removed.success, true);
  assert.equal(engine.listAntigravityAccts({ secrets: false }).length, 1);
  assert.equal(engine.listAntigravityAccts({ secrets: false })[0].id, current.account.id);
  assert.equal(engine.loadAntigravityIdx().current_antigravity_account_id, current.account.id);
  assert.equal(decrypts.count, 0);
});

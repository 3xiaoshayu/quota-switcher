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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-manager-test-"));
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
    engine.setSwitchRuntimeForTests();
    engine.setCursorRuntimeForTests();
    engine.setSqliteNativeTimingForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { engine, root };
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function cursorToken(email, suffix) {
  return jwt({
    email,
    sub: `auth0|user_${suffix}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  });
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

test("waitForWalToClear returns immediately when no WAL exists", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "no-wal.vscdb");
  fs.writeFileSync(dbPath, "x");
  let sleeps = 0;
  const cleared = await engine.waitForWalToClear(dbPath, 2000, async () => {
    sleeps += 1;
  });
  assert.equal(cleared, true);
  assert.equal(sleeps, 0);
});

test("waitForWalToClear waits until a leftover WAL file is gone", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "pending-wal.vscdb");
  fs.writeFileSync(dbPath, "x");
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64, 1));
  let sleeps = 0;
  const cleared = await engine.waitForWalToClear(dbPath, 2000, async () => {
    sleeps += 1;
    if (sleeps === 2) fs.unlinkSync(`${dbPath}-wal`);
  });
  assert.equal(cleared, true);
  assert.equal(sleeps, 2);
});

test("waitForWalToClear retries a transient WAL stat lock", async (t) => {
  const { engine, root } = freshEngine(t);
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
  const cleared = await engine.waitForWalToClear(dbPath, 2000, async () => {
    sleeps += 1;
    if (sleeps === 1 && fs.existsSync(walPath)) fs.unlinkSync(walPath);
  });
  assert.equal(failures, 2);
  assert.equal(sleeps, 1);
  assert.equal(cleared, true);
  assert.equal(fs.existsSync(walPath), false);
});

test("cursor lists without secrets skip decrypt when token metadata is present", async (t) => {
  const { engine } = freshEngine(t);
  await engine.upsertCursorAccount({
    email: "meta@example.com",
    auth_id: "user_meta",
    access_token: cursorToken("meta@example.com", "meta"),
    refresh_token: "refresh-meta",
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const listed = engine.listCursorAccts({ secrets: false });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].email, "meta@example.com");
  assert.equal(listed[0].tokens, null);
  assert.equal(decrypts.count, 0);
});

test("concurrent Cursor upserts of the same identity keep one account", async (t) => {
  const { engine } = freshEngine(t);
  const [first, second] = await Promise.all([
    engine.upsertCursorAccount({
      email: "same-cursor@example.com",
      auth_id: "user_same_cursor",
      access_token: cursorToken("same-cursor@example.com", "same-a"),
      refresh_token: "refresh-same-a",
    }),
    engine.upsertCursorAccount({
      email: "same-cursor@example.com",
      auth_id: "user_same_cursor",
      access_token: cursorToken("same-cursor@example.com", "same-b"),
      refresh_token: "refresh-same-b",
    }),
  ]);
  assert.equal(engine.listCursorAccts().length, 1);
  assert.equal(first.account.id, second.account.id);
});

test("Cursor upsert identity scan does not decrypt the rest of the vault", async (t) => {
  const { engine } = freshEngine(t);
  const keep = await engine.upsertCursorAccount({
    email: "keep-upsert@example.com",
    auth_id: "user_keep_upsert",
    access_token: cursorToken("keep-upsert@example.com", "keep-upsert"),
    refresh_token: "refresh-keep-upsert",
  });
  await engine.upsertCursorAccount({
    email: "spare-upsert-a@example.com",
    auth_id: "user_spare_upsert_a",
    access_token: cursorToken("spare-upsert-a@example.com", "spare-a"),
    refresh_token: "refresh-spare-a",
  });
  await engine.upsertCursorAccount({
    email: "spare-upsert-b@example.com",
    auth_id: "user_spare_upsert_b",
    access_token: cursorToken("spare-upsert-b@example.com", "spare-b"),
    refresh_token: "refresh-spare-b",
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const created = await engine.upsertCursorAccount({
    email: "fresh-upsert@example.com",
    auth_id: "user_fresh_upsert",
    access_token: cursorToken("fresh-upsert@example.com", "fresh-upsert"),
    refresh_token: "refresh-fresh-upsert",
  });
  assert.equal(created.updated, false);
  assert.notEqual(created.account.id, keep.account.id);
  assert.ok(decrypts.count <= 6);
  decrypts.reset();
  const again = await engine.upsertCursorAccount({
    email: "keep-upsert@example.com",
    auth_id: "user_keep_upsert",
    access_token: cursorToken("keep-upsert@example.com", "keep-upsert-again"),
    refresh_token: "refresh-keep-upsert-again",
  });
  assert.equal(again.updated, true);
  assert.equal(again.account.id, keep.account.id);
  assert.ok(decrypts.count <= 6);
});

test("cursor official sync matches identity without decrypting other accounts", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "sync-secrets.vscdb");
  const keep = await engine.upsertCursorAccount({
    email: "keep-sync@example.com",
    auth_id: "user_keep_sync",
    access_token: cursorToken("keep-sync@example.com", "keep-sync"),
    refresh_token: "refresh-keep-sync",
  });
  await engine.upsertCursorAccount({
    email: "spare-sync@example.com",
    auth_id: "user_spare_sync",
    access_token: cursorToken("spare-sync@example.com", "spare-sync"),
    refresh_token: "refresh-spare-sync",
  });
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("keep-sync@example.com", "keep-sync"),
    "cursorAuth/cachedEmail": "keep-sync@example.com",
    "cursorAuth/authId": "user_keep_sync",
  });
  engine.setCursorRuntimeForTests({ vscdbPath: () => dbPath });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const current = await engine.syncCurrentCursorFromOfficial({ force: true });
  assert.equal(current.id, keep.account.id);
  // current + matched load/save path; listing two encrypted files would add 2 more.
  assert.ok(decrypts.count >= 1);
  assert.ok(decrypts.count < 4);
});

test("cursor token batch check lists without decrypting then loads each account", async (t) => {
  const { engine } = freshEngine(t);
  await engine.upsertCursorAccount({
    email: "batch-live@example.com",
    auth_id: "user_batch_live",
    access_token: jwt({ email: "batch-live@example.com", sub: "user_batch_live", exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "refresh-batch-live",
  });
  await engine.upsertCursorAccount({
    email: "batch-dead@example.com",
    auth_id: "user_batch_dead",
    access_token: jwt({ email: "batch-dead@example.com", sub: "user_batch_dead", exp: Math.floor(Date.now() / 1000) - 10 }),
  });
  engine.setCursorRuntimeForTests({
    httpJson: async () => ({ status: 200, body: JSON.stringify({ accessToken: "new" }) }),
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const summary = await engine.refreshAllCursorTokens(false);
  assert.equal(summary.results.length, 2);
  assert.equal(summary.results.find((item) => item.email === "batch-live@example.com").skipped, true);
  assert.equal(summary.results.find((item) => item.email === "batch-dead@example.com").reauthRequired, true);
  assert.equal(decrypts.count, 0);
});

test("cursor token refreshAll still decrypts expired accounts that have a refresh token", async (t) => {
  const { engine } = freshEngine(t);
  await engine.upsertCursorAccount({
    email: "batch-expired@example.com",
    auth_id: "user_batch_expired",
    access_token: jwt({
      email: "batch-expired@example.com",
      sub: "user_batch_expired",
      exp: Math.floor(Date.now() / 1000) - 10,
    }),
    refresh_token: "refresh-batch-expired",
  });
  await engine.upsertCursorAccount({
    email: "batch-fresh@example.com",
    auth_id: "user_batch_fresh",
    access_token: jwt({
      email: "batch-fresh@example.com",
      sub: "user_batch_fresh",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-batch-fresh",
  });
  engine.setCursorRuntimeForTests({
    httpJson: async () => ({ status: 200, body: JSON.stringify({ accessToken: "rotated-access" }) }),
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const summary = await engine.refreshAllCursorTokens(false);
  assert.equal(summary.results.find((item) => item.email === "batch-expired@example.com").ok, true);
  assert.equal(summary.results.find((item) => item.email === "batch-fresh@example.com").skipped, true);
  assert.equal(decrypts.count, 1);
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

const APPLICATION_USER_KEY = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

function applicationUser(dbPath) {
  const raw = itemText(dbPath, APPLICATION_USER_KEY);
  return raw ? JSON.parse(raw) : null;
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

test("cursor accounts stay out of Codex list and switch", async (t) => {
  const { engine } = freshEngine(t);
  const result = await engine.upsertCursorAccount({
    email: "cursor@example.com",
    auth_id: "user_abc",
    access_token: cursorToken("cursor@example.com", "abc"),
    refresh_token: "refresh-abc",
  });
  assert.equal(result.account.id.startsWith("cursor_"), true);
  assert.equal(engine.listAccts().length, 0);
  assert.equal(engine.listCursorAccts().length, 1);
  assert.equal(engine.loadAcct(result.account.id), null);
  await assert.rejects(
    () => engine.doSwitch({ id: result.account.id, tokens: result.account.tokens }),
    /cannot be switched into official Codex/,
  );
});

test("local vscdb import reads token and email then upserts", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("local@example.com", "local"),
    "cursorAuth/cachedEmail": "local@example.com",
    "cursorAuth/refreshToken": "refresh-local",
    "cursorAuth/authId": "user_local",
    "cursorAuth/stripeMembershipType": "pro",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
  });
  const imported = await engine.importLocalCursorAccount();
  assert.equal(imported.found, true);
  assert.equal(imported.account.email, "local@example.com");
  assert.equal(imported.account.plan_type, "pro");
  assert.equal(imported.account.banned, false);
  assert.equal(imported.account.cursor_ui, null);
  assert.equal(imported.stalePossible, false);
  assert.equal(engine.currentCursorAcct().id, imported.account.id);
  assert.equal(engine.listAccts().length, 0);
});

test("local vscdb import keeps official profile and team cache on the account", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("local@example.com", "local"),
    "cursorAuth/cachedEmail": "local@example.com",
    "cursorAuth/refreshToken": "refresh-local",
    "cursorAuth/authId": "user_local",
    "cursorAuth/cachedTeam": JSON.stringify({ teamId: 4, name: "Local Team" }),
    "cursorAuth/cachedScopedProfile": JSON.stringify({
      displayName: "Local Name",
      pictureUrl: "https://example.com/local.png",
    }),
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
  });
  const imported = await engine.importLocalCursorAccount();
  assert.deepEqual(JSON.parse(imported.account.cursor_ui["cursorAuth/cachedTeam"]), {
    teamId: 4,
    name: "Local Team",
  });
  assert.deepEqual(JSON.parse(imported.account.cursor_ui["cursorAuth/cachedScopedProfile"]), {
    displayName: "Local Name",
    pictureUrl: "https://example.com/local.png",
  });
});

test("cursor list sync marks the official login as current without switching", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  const created = await engine.upsertCursorAccount({
    email: "sync@example.com",
    auth_id: "user_sync",
    access_token: cursorToken("sync@example.com", "sync"),
    refresh_token: "refresh-sync",
  });
  assert.equal(engine.currentCursorAcct(), null);
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("sync@example.com", "sync"),
    "cursorAuth/cachedEmail": "sync@example.com",
    "cursorAuth/authId": "user_sync",
  });
  engine.setCursorRuntimeForTests({ vscdbPath: () => dbPath });
  const current = await engine.syncCurrentCursorFromOfficial();
  assert.equal(current.id, created.account.id);
  assert.equal(engine.currentCursorAcct().id, created.account.id);
});

test("cursor official sync captures profile cache without switching", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  const created = await engine.upsertCursorAccount({
    email: "sync@example.com",
    auth_id: "user_sync",
    access_token: cursorToken("sync@example.com", "sync"),
    refresh_token: "refresh-sync",
  });
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("sync@example.com", "sync"),
    "cursorAuth/cachedEmail": "sync@example.com",
    "cursorAuth/authId": "user_sync",
    "cursorAuth/cachedScopedProfile": JSON.stringify({
      displayName: "Sync Name",
      pictureUrl: "https://example.com/sync.png",
    }),
  });
  engine.setCursorRuntimeForTests({ vscdbPath: () => dbPath });
  await engine.syncCurrentCursorFromOfficial({ force: true });
  const stored = engine.loadCursorAcct(created.account.id);
  assert.deepEqual(JSON.parse(stored.cursor_ui["cursorAuth/cachedScopedProfile"]), {
    displayName: "Sync Name",
    pictureUrl: "https://example.com/sync.png",
  });
});

test("cursor official sync follows vscdb even when WAL is pending", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  const first = await engine.upsertCursorAccount({
    email: "keep@example.com",
    auth_id: "user_keep",
    access_token: cursorToken("keep@example.com", "keep"),
  });
  const other = await engine.upsertCursorAccount({
    email: "other@example.com",
    auth_id: "user_other",
    access_token: cursorToken("other@example.com", "other"),
  });
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("keep@example.com", "keep"),
    "cursorAuth/cachedEmail": "keep@example.com",
    "cursorAuth/authId": "user_keep",
  });
  engine.setCursorRuntimeForTests({ vscdbPath: () => dbPath });
  assert.equal((await engine.syncCurrentCursorFromOfficial()).id, first.account.id);
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("other@example.com", "other"),
    "cursorAuth/cachedEmail": "other@example.com",
    "cursorAuth/authId": "user_other",
  });
  const { DatabaseSync } = require("node:sqlite");
  const holder = new DatabaseSync(dbPath);
  holder.exec("PRAGMA journal_mode=WAL");
  holder.exec("PRAGMA wal_autocheckpoint=0");
  holder.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run("keep/extra", "x");
  const current = await engine.syncCurrentCursorFromOfficial({ force: true });
  assert.equal(current.id, other.account.id);
  holder.close();
});

test("cursor vscdb snapshot still captures rows when existsSync reports the db missing", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("snap-lie@example.com", "snap-lie"),
    "cursorAuth/cachedEmail": "snap-lie@example.com",
    "cursorAuth/authId": "user_snap_lie",
  });
  const originalExists = fs.existsSync;
  fs.existsSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(dbPath)) return false;
    return originalExists(file);
  };
  t.after(() => { fs.existsSync = originalExists; });
  const { snapshotItems, restoreItems } = require("../engine/sqlite-native");
  const snapshot = await snapshotItems(dbPath, ["cursorAuth/cachedEmail"], {});
  assert.equal(snapshot.missing, false);
  assert.ok(snapshot.rows["cursorAuth/cachedEmail"]);
  restoreItems(snapshot, {});
  fs.existsSync = originalExists;
  assert.equal(fs.existsSync(dbPath), true);
});

test("restoring a missing vscdb snapshot retries when unlink is transiently locked", (t) => {
  const { root } = freshEngine(t);
  const dbPath = path.join(root, "missing-restore.vscdb");
  fs.writeFileSync(dbPath, "placeholder");
  const originalUnlink = fs.unlinkSync;
  let failures = 0;
  fs.unlinkSync = (target) => {
    if (path.resolve(String(target)) === path.resolve(dbPath) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalUnlink(target);
  };
  t.after(() => { fs.unlinkSync = originalUnlink; });
  const { restoreItems } = require("../engine/sqlite-native");
  restoreItems({ dbPath, missing: true, rows: {} }, {});
  assert.equal(failures, 2);
  assert.equal(fs.existsSync(dbPath), false);
});

test("cursor list sync can fill an empty current from official vscdb", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  const created = await engine.upsertCursorAccount({
    email: "fill@example.com",
    auth_id: "user_fill",
    access_token: cursorToken("fill@example.com", "fill"),
  });
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("fill@example.com", "fill"),
    "cursorAuth/cachedEmail": "fill@example.com",
    "cursorAuth/authId": "user_fill",
  });
  engine.setCursorRuntimeForTests({ vscdbPath: () => dbPath });
  assert.equal(engine.currentCursorAcct(), null);
  const current = await engine.syncCurrentCursorFromOfficial();
  assert.equal(current.id, created.account.id);
});

test("missing local cursor login is not found", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "empty.vscdb");
  await engine.writeCursorAuth(dbPath, { "cursorAuth/cachedEmail": "" });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
  });
  const imported = await engine.importLocalCursorAccount();
  assert.equal(imported.found, false);
  assert.equal(engine.listCursorAccts().length, 0);
});

test("cursor usage parser treats percent used as used and never bans", (t) => {
  freshEngine(t);
  const { parseCursorUsage } = require("../engine/cursor-quota");
  const quota = parseCursorUsage({
    membershipType: "pro",
    individualUsage: {
      plan: {
        totalPercentUsed: 40,
        autoPercentUsed: 10,
        apiPercentUsed: 80,
      },
    },
  });
  assert.equal(quota.plan_remaining_percentage, 60);
  assert.equal(quota.auto_remaining_percentage, 90);
  assert.equal(quota.api_remaining_percentage, 20);
  const rounded = parseCursorUsage({
    individualUsage: { plan: { autoPercentUsed: 99.93666666666667 } },
  });
  assert.equal(rounded.auto_used_percentage, 100);
  assert.equal(rounded.auto_remaining_percentage, 0);
  assert.equal(quota.membership_type, "pro");
});

test("cursor usage cookie uses workos id from jwt sub", (t) => {
  const { engine } = freshEngine(t);
  const access = cursorToken("cookie@example.com", "cookie");
  const cookie = engine.buildCursorUsageCookie({
    tokens: { access_token: access },
    auth_id: "ignored",
  });
  assert.match(cookie, /WorkosCursorSessionToken=/);
  assert.match(decodeURIComponent(cookie.split("=")[1]), /^user_cookie::/);
  assert.equal(engine.buildCursorUsageCookie({
    tokens: { access_token: jwt({ email: "mail@example.com", sub: "auth0|not-a-user" }) },
    auth_id: "mail@example.com",
  }), null);
  const stored = engine.buildCursorUsageCookie({
    tokens: { access_token: jwt({ email: "mail@example.com", sub: "auth0|not-a-user" }) },
    auth_id: "user_stored",
  });
  assert.match(stored, /WorkosCursorSessionToken=/);
  assert.match(decodeURIComponent(stored.split("=")[1]), /^user_stored::/);
});

test("cursor token batch check reports missing refresh tokens", async (t) => {
  const { engine } = freshEngine(t);
  await engine.upsertCursorAccount({
    email: "live@example.com",
    auth_id: "user_live",
    access_token: jwt({ email: "live@example.com", sub: "user_live", exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "refresh-live",
  });
  await engine.upsertCursorAccount({
    email: "dead@example.com",
    auth_id: "user_dead",
    access_token: jwt({ email: "dead@example.com", sub: "user_dead", exp: Math.floor(Date.now() / 1000) - 10 }),
  });
  engine.setCursorRuntimeForTests({
    httpJson: async () => ({ status: 200, body: JSON.stringify({ accessToken: "new" }) }),
  });
  const summary = await engine.refreshAllCursorTokens(false);
  assert.equal(summary.results.length, 2);
  const live = summary.results.find((item) => item.email === "live@example.com");
  const dead = summary.results.find((item) => item.email === "dead@example.com");
  assert.equal(live.ok, true);
  assert.equal(dead.ok, false);
  assert.equal(dead.reauthRequired, true);
});

test("cursor token check does not pass accounts that still need reauth", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "need-reauth@example.com",
    auth_id: "user_need_reauth",
    access_token: jwt({
      email: "need-reauth@example.com",
      sub: "user_need_reauth",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-need-reauth",
  });
  const account = engine.loadCursorAcct(created.account.id);
  account.requires_reauth = true;
  account.reauth_reason = "Cursor 会话已过期或未认证，请重新授权";
  engine.saveCursorAcct(account);
  engine.setCursorRuntimeForTests({
    httpJson: async () => {
      throw new Error("reauth accounts must not hit the token endpoint");
    },
  });
  const refreshed = await engine.refreshCursorToken(engine.loadCursorAcct(created.account.id), { force: false });
  assert.equal(refreshed.ok, false);
  assert.equal(refreshed.skipped, true);
  assert.equal(refreshed.reauthRequired, true);
  const summary = await engine.refreshAllCursorTokens(false);
  assert.equal(summary.results[0].ok, false);
  assert.equal(summary.results[0].reauthRequired, true);
  const live = await engine.upsertCursorAccount({
    email: "live-check@example.com",
    auth_id: "user_live_check",
    access_token: jwt({
      email: "live-check@example.com",
      sub: "user_live_check",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-live-check",
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const again = await engine.refreshAllCursorTokens(false);
  assert.equal(again.results.find((item) => item.email === account.email).reauthRequired, true);
  assert.equal(again.results.find((item) => item.email === live.account.email).ok, true);
  assert.equal(decrypts.count, 0);
});

test("cursor token refresh clears leftover quota_error", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "stale-quota@example.com",
    auth_id: "user_stale_quota",
    access_token: jwt({
      email: "stale-quota@example.com",
      sub: "user_stale_quota",
      exp: Math.floor(Date.now() / 1000) - 10,
    }),
    refresh_token: "refresh-stale-quota",
  });
  const account = engine.loadCursorAcct(created.account.id);
  account.quota_error = { code: "timeout", message: "Cursor usage request failed: timeout", timestamp: Date.now() };
  engine.saveCursorAcct(account);
  engine.setCursorRuntimeForTests({
    httpJson: async () => ({ status: 200, body: JSON.stringify({ accessToken: "fresh-access" }) }),
  });
  const refreshed = await engine.refreshCursorToken(engine.loadCursorAcct(created.account.id), { force: true });
  assert.equal(refreshed.ok, true);
  const latest = engine.loadCursorAcct(created.account.id);
  assert.equal(latest.quota_error, null);
  assert.equal(latest.tokens.access_token, "fresh-access");
});

test("cursor token refresh shouldLogout only marks reauth", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "reauth@example.com",
    auth_id: "user_reauth",
    access_token: jwt({ email: "reauth@example.com", sub: "user_reauth", exp: Math.floor(Date.now() / 1000) - 10 }),
    refresh_token: "refresh-reauth",
  });
  engine.setCursorRuntimeForTests({
    httpJson: async () => ({ status: 200, body: JSON.stringify({ shouldLogout: true }) }),
  });
  const refreshed = await engine.refreshCursorToken(engine.loadCursorAcct(created.account.id), { force: true });
  assert.equal(refreshed.ok, false);
  assert.equal(refreshed.skipped, true);
  assert.equal(refreshed.reauthRequired, true);
  const latest = engine.loadCursorAcct(created.account.id);
  assert.equal(latest.requires_reauth, true);
  assert.equal(latest.banned, false);
});

test("cursor switch writes vscdb after close and rolls back on write failure", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  const created = await engine.upsertCursorAccount({
    email: "next@example.com",
    auth_id: "user_next",
    access_token: cursorToken("next@example.com", "next"),
    refresh_token: "refresh-next",
    plan_type: "pro",
  });

  let listed = [{ name: "Cursor.exe", pid: 4242, executablePath: exePath }];
  let listCalls = 0;
  const closed = [];
  const launched = [];
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => {
      listCalls += 1;
      return listed;
    },
    gracefulClose: async (pid) => {
      closed.push(pid);
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

  const switched = await engine.doCursorSwitch(engine.loadCursorAcct(created.account.id));
  assert.equal(switched.launched, true);
  assert.deepEqual(closed, [4242]);
  assert.deepEqual(launched, [exePath]);
  assert.ok(listCalls <= 2, `listProcesses called ${listCalls} times`);
  assert.match(readEngineLogs(root), /Cursor switch timings kill=\d+ms writable=\d+ms write=\d+ms/);
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "next@example.com");
  assert.equal(values["cursor.email"], "next@example.com");
  assert.equal(values["cursorAuth/userId"], "user_next");
  assert.equal(values["cursorAuth/authId"], "user_next");
  assert.equal(values["cursorAuth/stripeMembershipAuthId"], "auth0|user_next");
  assert.equal(values["glass.lastSignedInAuthId"], "auth0|user_next");
  assert.equal(engine.currentCursorAcct().id, created.account.id);
  assert.equal(engine.listAccts().length, 0);
});

test("cursor switch still relaunches Cursor.exe when existsSync reports it missing", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  const created = await engine.upsertCursorAccount({
    email: "exe-lie@example.com",
    auth_id: "user_exe_lie",
    access_token: cursorToken("exe-lie@example.com", "exe-lie"),
    refresh_token: "refresh-exe-lie",
  });
  const launched = [];
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: (target) => {
      launched.push(target);
      return true;
    },
    sleep: async () => {},
  });
  const originalExists = fs.existsSync;
  fs.existsSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(exePath)) return false;
    return originalExists(file);
  };
  t.after(() => { fs.existsSync = originalExists; });
  const switched = await engine.doCursorSwitch(engine.loadCursorAcct(created.account.id));
  assert.equal(switched.launched, true);
  assert.deepEqual(launched, [exePath]);
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "exe-lie@example.com");
});

test("cursor switch returns the in-memory account without a final decrypt", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  const created = await engine.upsertCursorAccount({
    email: "mem-switch@example.com",
    auth_id: "user_mem_switch",
    access_token: cursorToken("mem-switch@example.com", "mem-switch"),
    refresh_token: "refresh-mem-switch",
  });
  await engine.upsertCursorAccount({
    email: "mem-spare@example.com",
    auth_id: "user_mem_spare",
    access_token: cursorToken("mem-spare@example.com", "mem-spare"),
    refresh_token: "refresh-mem-spare",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });
  const account = engine.loadCursorAcct(created.account.id);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const switched = await engine.doCursorSwitch(account);
  assert.ok(decrypts.count <= 1);
  assert.equal(switched.account.id, created.account.id);
  assert.equal(switched.account.email, "mem-switch@example.com");
  assert.ok(switched.account.tokens?.access_token);
  assert.ok(switched.account.last_used);
  assert.equal(engine.currentCursorAcct().id, created.account.id);
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "mem-switch@example.com");
});

test("cursor switch clears leftover team and display-name cache from the previous login", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
    "cursorAuth/authId": "user_old",
    "cursorAuth/userId": "user_old",
  });
  putItem(dbPath, "cursorAuth/cachedTeam", JSON.stringify({ teamId: 1, name: "Old Team" }));
  putItem(dbPath, "cursorAuth/cachedScopedProfile", JSON.stringify({ displayName: "Old Name" }));
  putItem(dbPath, "cursor.customize.userDisplayNameCache", "Old Display");
  const created = await engine.upsertCursorAccount({
    email: "next@example.com",
    auth_id: "user_next",
    access_token: cursorToken("next@example.com", "next"),
    refresh_token: "refresh-next",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });

  await engine.doCursorSwitch(engine.loadCursorAcct(created.account.id));
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "next@example.com");
  assert.equal(values["cursorAuth/userId"], "user_next");
  assert.equal(itemText(dbPath, "cursorAuth/cachedTeam"), null);
  assert.deepEqual(JSON.parse(itemText(dbPath, "cursorAuth/cachedScopedProfile")), {
    displayName: "next",
  });
  assert.equal(itemText(dbPath, "cursor.customize.userDisplayNameCache"), null);
});

test("cursor switch clears leftover team id from application storage", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
    "cursorAuth/authId": "user_old",
  });
  putItem(dbPath, APPLICATION_USER_KEY, JSON.stringify({
    membershipType: "enterprise",
    isEnterprise: false,
    aiSettings: { teamId: 29782437, teamIds: [29782437], modelName: "keep-me" },
  }));
  putItem(dbPath, "adminSettings.cachedTeamId", "29782437");
  putItem(dbPath, "adminSettings.cachedAuthId", "auth0|user_old");
  const created = await engine.upsertCursorAccount({
    email: "next@example.com",
    auth_id: "user_next",
    access_token: cursorToken("next@example.com", "next"),
    refresh_token: "refresh-next",
    plan_type: "pro",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });

  await engine.doCursorSwitch(engine.loadCursorAcct(created.account.id));
  const stored = applicationUser(dbPath);
  assert.equal(stored.aiSettings.teamId, undefined);
  assert.deepEqual(stored.aiSettings.teamIds, []);
  assert.equal(stored.aiSettings.modelName, "keep-me");
  assert.equal(stored.membershipType, "pro");
  assert.equal(itemText(dbPath, "adminSettings.cachedTeamId"), null);
  assert.equal(itemText(dbPath, "adminSettings.cachedAuthId"), null);
});

test("cursor switch writes the target team id into application storage", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
    "cursorAuth/authId": "user_old",
  });
  putItem(dbPath, APPLICATION_USER_KEY, JSON.stringify({
    membershipType: "enterprise",
    isEnterprise: false,
    aiSettings: { teamId: 29782437, teamIds: [29782437], modelName: "keep-me" },
  }));
  putItem(dbPath, "adminSettings.cachedTeamId", "29782437");
  const created = await engine.upsertCursorAccount({
    email: "next@example.com",
    auth_id: "user_next",
    access_token: cursorToken("next@example.com", "next"),
    refresh_token: "refresh-next",
    plan_type: "enterprise",
    cursor_ui: {
      "cursorAuth/cachedTeam": JSON.stringify({ teamId: 29626437, name: "Next Team" }),
      "cursorAuth/cachedScopedProfile": JSON.stringify({ displayName: "Next Name" }),
    },
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });

  await engine.doCursorSwitch(engine.loadCursorAcct(created.account.id));
  const stored = applicationUser(dbPath);
  assert.equal(stored.aiSettings.teamId, 29626437);
  assert.deepEqual(stored.aiSettings.teamIds, [29626437]);
  assert.equal(stored.aiSettings.modelName, "keep-me");
  assert.equal(itemText(dbPath, "adminSettings.cachedTeamId"), "29626437");
  assert.deepEqual(JSON.parse(itemText(dbPath, "cursorAuth/cachedTeam")), {
    teamId: 29626437,
    name: "Next Team",
  });
});

test("cursor switch restores the target account profile cache instead of the previous login", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
    "cursorAuth/authId": "user_old",
  });
  putItem(dbPath, "cursorAuth/cachedTeam", JSON.stringify({ teamId: 1, name: "Old Team" }));
  putItem(dbPath, "cursorAuth/cachedScopedProfile", JSON.stringify({
    displayName: "Old Name",
    pictureUrl: "https://example.com/old.png",
  }));
  const created = await engine.upsertCursorAccount({
    email: "next@example.com",
    auth_id: "user_next",
    access_token: cursorToken("next@example.com", "next"),
    refresh_token: "refresh-next",
    cursor_ui: {
      "cursorAuth/cachedTeam": JSON.stringify({ teamId: 9, name: "Next Team" }),
      "cursorAuth/cachedScopedProfile": JSON.stringify({
        displayName: "Next Name",
        pictureUrl: "https://example.com/next.png",
      }),
      "cursor.customize.userDisplayNameCache": "Next Display",
    },
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });

  await engine.doCursorSwitch(engine.loadCursorAcct(created.account.id));
  assert.deepEqual(JSON.parse(itemText(dbPath, "cursorAuth/cachedTeam")), {
    teamId: 9,
    name: "Next Team",
  });
  assert.deepEqual(JSON.parse(itemText(dbPath, "cursorAuth/cachedScopedProfile")), {
    displayName: "Next Name",
    pictureUrl: "https://example.com/next.png",
  });
  assert.equal(itemText(dbPath, "cursor.customize.userDisplayNameCache"), "Next Display");
});

test("cursor switch captures the leaving account profile and restores it on return", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  const leaving = await engine.upsertCursorAccount({
    email: "old@example.com",
    auth_id: "user_old",
    access_token: cursorToken("old@example.com", "old"),
    refresh_token: "refresh-old",
  });
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("old@example.com", "old"),
    "cursorAuth/cachedEmail": "old@example.com",
    "cursorAuth/authId": "user_old",
  });
  putItem(dbPath, "cursorAuth/cachedTeam", JSON.stringify({ teamId: 1, name: "Old Team" }));
  putItem(dbPath, "cursorAuth/cachedScopedProfile", JSON.stringify({
    displayName: "Old Name",
    pictureUrl: "https://example.com/old.png",
  }));
  const next = await engine.upsertCursorAccount({
    email: "next@example.com",
    auth_id: "user_next",
    access_token: cursorToken("next@example.com", "next"),
    refresh_token: "refresh-next",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });

  await engine.doCursorSwitch(engine.loadCursorAcct(next.account.id));
  const storedLeaving = engine.loadCursorAcct(leaving.account.id);
  assert.deepEqual(JSON.parse(storedLeaving.cursor_ui["cursorAuth/cachedTeam"]), {
    teamId: 1,
    name: "Old Team",
  });
  assert.deepEqual(JSON.parse(storedLeaving.cursor_ui["cursorAuth/cachedScopedProfile"]), {
    displayName: "Old Name",
    pictureUrl: "https://example.com/old.png",
  });

  await engine.doCursorSwitch(engine.loadCursorAcct(leaving.account.id));
  assert.deepEqual(JSON.parse(itemText(dbPath, "cursorAuth/cachedTeam")), {
    teamId: 1,
    name: "Old Team",
  });
  assert.deepEqual(JSON.parse(itemText(dbPath, "cursorAuth/cachedScopedProfile")), {
    displayName: "Old Name",
    pictureUrl: "https://example.com/old.png",
  });
});

test("cursor auth write keeps unrelated vscdb rows and does not copy the file", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  putItem(dbPath, "keep/extra", "stay");
  const hits = installVscdbIoSpies(t, dbPath);
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "new-token",
    "cursorAuth/cachedEmail": "new@example.com",
  });
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "new@example.com");
  assert.equal(itemText(dbPath, "keep/extra"), "stay");
  assert.equal(hits.read, 0);
  assert.equal(hits.copy, 0);
});

test("cursor auth write leaves a large extra blob in place without copying the file", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  const blob = Buffer.alloc(4 * 1024 * 1024, 7);
  putItem(dbPath, "keep/extra", blob);
  const hits = installVscdbIoSpies(t, dbPath);
  const started = Date.now();
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "new-token",
    "cursorAuth/cachedEmail": "new@example.com",
  });
  const elapsed = Date.now() - started;
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "new@example.com");
  assert.equal(itemText(dbPath, "keep/extra"), blob.toString("utf8"));
  assert.equal(hits.read, 0);
  assert.equal(hits.copy, 0);
  assert.ok(elapsed < 2000, `writeCursorAuth took ${elapsed}ms`);
});

test("cursor auth write retries when creating the vscdb parent directory is locked", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "nested-lock", "cursor-state.vscdb");
  const parent = path.dirname(dbPath);
  const originalMkdir = fs.mkdirSync;
  let failures = 0;
  fs.mkdirSync = (dir, options) => {
    if (path.resolve(String(dir)) === path.resolve(parent) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalMkdir(dir, options);
  };
  t.after(() => { fs.mkdirSync = originalMkdir; });
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "mkdir-token",
    "cursorAuth/cachedEmail": "mkdir@example.com",
  });
  assert.equal(failures, 2);
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "mkdir@example.com");
});

test("cursor switch writes login keys even when a leftover WAL file is present", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  putItem(dbPath, "keep/extra", "stay");
  const { DatabaseSync } = require("node:sqlite");
  const walHolder = new DatabaseSync(dbPath);
  walHolder.exec("PRAGMA journal_mode=WAL");
  walHolder.exec("PRAGMA wal_autocheckpoint=0");
  walHolder.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run("keep/wal", "pending");
  walHolder.close();
  const created = await engine.upsertCursorAccount({
    email: "wal@example.com",
    auth_id: "user_wal",
    access_token: cursorToken("wal@example.com", "wal"),
    refresh_token: "refresh-wal",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });
  await engine.doCursorSwitch(engine.loadCursorAcct(created.account.id));
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "wal@example.com");
  assert.equal(itemText(dbPath, "keep/extra"), "stay");
});

test("cursor switch refuses a locked vscdb and relaunches without rolling back", async (t) => {
  const { engine, root } = freshEngine(t);
  applyImmediateLockTimeout(engine);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  const locker = holdExclusive(dbPath);
  t.after(() => {
    try { locker.exec("ROLLBACK"); } catch {}
    try { locker.close(); } catch {}
  });
  const created = await engine.upsertCursorAccount({
    email: "busy@example.com",
    auth_id: "user_busy",
    access_token: cursorToken("busy@example.com", "busy"),
    refresh_token: "refresh-busy",
  });
  const launched = [];
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: (target) => launched.push(target),
    sleep: async () => {},
  });
  await assert.rejects(
    () => engine.doCursorSwitch(engine.loadCursorAcct(created.account.id)),
    /占用登录库/,
  );
  try { locker.exec("ROLLBACK"); } catch {}
  try { locker.close(); } catch {}
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "old@example.com");
  assert.deepEqual(launched, [exePath]);
  assert.match(readEngineLogs(root), /Cursor switch failed/);
  assert.match(readEngineLogs(root), /cursor_vscdb_busy|占用登录库/);
});

test("cursor switch waits for a brief vscdb lock then writes", async (t) => {
  const { engine, root } = freshEngine(t);
  engine.setSqliteNativeTimingForTests({
    waitWritableTimeoutMs: 2000,
    waitWritablePollMs: 40,
    waitWritableOpenTimeoutMs: 0,
  });
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  const locker = holdExclusive(dbPath);
  t.after(() => {
    try { locker.exec("ROLLBACK"); } catch {}
    try { locker.close(); } catch {}
  });
  const created = await engine.upsertCursorAccount({
    email: "wait@example.com",
    auth_id: "user_wait",
    access_token: cursorToken("wait@example.com", "wait"),
    refresh_token: "refresh-wait",
  });
  const launched = [];
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: (target) => launched.push(target),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  setTimeout(() => {
    try { locker.exec("ROLLBACK"); } catch {}
    try { locker.close(); } catch {}
  }, 120);
  await engine.doCursorSwitch(engine.loadCursorAcct(created.account.id));
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "wait@example.com");
  assert.deepEqual(launched, [exePath]);
});

test("cursor switch IPC logs the failure", async (t) => {
  const { engine, root } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "ipc-busy@example.com",
    auth_id: "user_ipc_busy",
    access_token: cursorToken("ipc-busy@example.com", "ipc_busy"),
    refresh_token: "refresh-ipc-busy",
  });
  engine.doCursorSwitch = async () => {
    const error = new Error("官方 Cursor 还在占用登录库，请关掉后再切");
    error.code = "cursor_vscdb_busy";
    throw error;
  };
  const handlers = new Map();
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: { getVersion: () => "0.1.0-beta.32", isPackaged: false },
    shell: { async openExternal() {}, async openPath() { return ""; } },
  };
  delete require.cache[require.resolve("../src/main/ipc-handlers")];
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const result = await handlers.get("cursor:switch")({}, created.account.id);
  assert.equal(result.success, false);
  assert.match(String(result.error), /占用登录库/);
  assert.match(readEngineLogs(root), /IPC cursor:switch failed/);
  assert.match(readEngineLogs(root), /cursor_vscdb_busy|占用登录库/);
});

test("cursor switch clears leftover auth keys the target account does not have", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/refreshToken": "old-refresh",
    "cursorAuth/cachedEmail": "old@example.com",
    "cursorAuth/authId": "user_old",
    "cursorAuth/stripeMembershipType": "pro",
  });
  const created = await engine.upsertCursorAccount({
    email: "next-clean@example.com",
    auth_id: "mail@example.com",
    access_token: cursorToken("next-clean@example.com", "next_clean"),
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => path.join(root, "missing.exe"),
    listProcesses: async () => [],
    sleep: async () => {},
  });
  await engine.doCursorSwitch(engine.loadCursorAcct(created.account.id));
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "next-clean@example.com");
  assert.equal(values["cursorAuth/refreshToken"] || "", "");
  assert.equal(values["cursorAuth/authId"] || "", "");
});

test("local cursor import marks stalePossible when WAL is pending", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("stale@example.com", "stale"),
    "cursorAuth/cachedEmail": "stale@example.com",
  });
  const { DatabaseSync } = require("node:sqlite");
  const holder = new DatabaseSync(dbPath);
  holder.exec("PRAGMA journal_mode=WAL");
  holder.exec("PRAGMA wal_autocheckpoint=0");
  holder.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run("keep/extra", "x");
  engine.setCursorRuntimeForTests({ vscdbPath: () => dbPath });
  const imported = await engine.importLocalCursorAccount();
  assert.equal(imported.found, true);
  assert.equal(engine.hasPendingWal(dbPath), true);
  assert.equal(imported.stalePossible, true);
  holder.close();
});

test("cursor switch writes even when Cursor.exe is missing", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  const created = await engine.upsertCursorAccount({
    email: "manual@example.com",
    auth_id: "user_manual",
    access_token: cursorToken("manual@example.com", "manual"),
    refresh_token: "refresh-manual",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => path.join(root, "missing.exe"),
    listProcesses: async () => [],
    launch: () => {
      throw new Error("should not launch");
    },
    sleep: async () => {},
  });
  const switched = await engine.doCursorSwitch(engine.loadCursorAcct(created.account.id));
  assert.equal(switched.launched, false);
  assert.match(switched.launchError, /手动打开/);
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "manual@example.com");
});

test("cursor switch rolls back index when post-write work fails", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  const first = await engine.upsertCursorAccount({
    email: "keep@example.com",
    auth_id: "user_keep",
    access_token: cursorToken("keep@example.com", "keep"),
    refresh_token: "refresh-keep",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });
  await engine.doCursorSwitch(engine.loadCursorAcct(first.account.id));
  assert.equal(engine.currentCursorAcct().id, first.account.id);

  const next = await engine.upsertCursorAccount({
    email: "fail@example.com",
    auth_id: "user_fail",
    access_token: cursorToken("fail@example.com", "fail"),
    refresh_token: "refresh-fail",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
    afterSwitchMetaWrite: async () => {
      throw new Error("post-write failed");
    },
  });
  await assert.rejects(
    () => engine.doCursorSwitch(engine.loadCursorAcct(next.account.id)),
    /post-write failed/,
  );
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "keep@example.com");
  assert.equal(engine.currentCursorAcct().id, first.account.id);
});

test("codex storage rejects cursor ids even if a file is planted in the Codex directory", async (t) => {
  const { engine, root } = freshEngine(t);
  const plantedId = "cursor_plantedaccount00000000000000";
  const accountsDir = path.join(root, "data", "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.writeFileSync(path.join(accountsDir, `${plantedId}.json`), JSON.stringify({ id: plantedId, email: "planted@example.com" }));
  assert.equal(engine.loadAcct(plantedId), null);
  assert.throws(
    () => engine.saveAcct({ id: plantedId, email: "planted@example.com" }),
    /cannot be stored in the Codex account directory/,
  );
  assert.throws(
    () => engine.writeAuthJson({ id: plantedId, tokens: { access_token: "x" } }),
    /cannot be written to official Codex/,
  );
});

test("cursor workos id ignores jwt sub segments that are not user_", (t) => {
  const { engine } = freshEngine(t);
  assert.equal(engine.extractCursorWorkosUserId(jwt({ sub: "auth0|not-a-user" })), null);
  assert.equal(engine.extractCursorWorkosUserId(jwt({ sub: "auth0|user_ok" })), "user_ok");
});

test("local cursor import can use jwt email when cachedEmail is empty", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("jwt@example.com", "jwtmail"),
  });
  const local = engine.authFromLocalValues(await engine.readCursorAuth(dbPath, { copyFirst: false }));
  assert.equal(local.email, "jwt@example.com");
});

test("cursor oauth poll upserts account without touching Codex", async (t) => {
  const { engine } = freshEngine(t);
  let polls = 0;
  engine.setCursorRuntimeForTests({
    openUrl: async () => {},
    sleep: async () => {},
    httpJson: async (url) => {
      if (String(url).includes("/auth/poll")) {
        polls += 1;
        if (polls === 1) return { status: 404, body: "" };
        return {
          status: 200,
          body: JSON.stringify({
            accessToken: cursorToken("oauth@example.com", "oauth"),
            refreshToken: "refresh-oauth",
            authId: "oauth@example.com",
          }),
        };
      }
      if (String(url).includes("GetUserMeta")) {
        return {
          status: 200,
          body: JSON.stringify({
            email: "meta@example.com",
            workosId: "user_oauth_meta",
          }),
        };
      }
      return { status: 200, body: "{}" };
    },
  });
  const result = await engine.cursorLoginFlow();
  assert.equal(result.account.email, "meta@example.com");
  assert.equal(result.account.auth_id, "user_oauth_meta");
  const stored = engine.loadCursorAcct(result.account.id);
  assert.equal(stored.email, "meta@example.com");
  assert.equal(stored.auth_id, "user_oauth_meta");
  assert.equal(engine.listCursorAccts().length, 1);
  assert.equal(engine.listAccts().length, 0);
  assert.equal(engine.currentCursorAcct(), null);
});

test("cursor quota refresh without a usage cookie does not mark reauth", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "nocookie@example.com",
    auth_id: "nocookie@example.com",
    access_token: jwt({
      email: "nocookie@example.com",
      sub: "auth0|not-a-user",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
  engine.setCursorRuntimeForTests({
    httpJson: async () => {
      throw new Error("usage cookie should fail before HTTP");
    },
  });
  await assert.rejects(
    () => engine.refreshCursorQuota(engine.loadCursorAcct(created.account.id), { force: true }),
    /没查清/,
  );
  const latest = engine.loadCursorAcct(created.account.id);
  assert.equal(latest.requires_reauth, false);
  assert.equal(latest.banned, false);
  assert.equal(latest.probe.status, "probe_failed");
  assert.equal(latest.quota_error.code, "cursor_session_missing");
});

test("cursor pending oauth can be discarded without touching Codex", async (t) => {
  const { engine } = freshEngine(t);
  let releaseSleep = null;
  engine.setCursorRuntimeForTests({
    openUrl: async () => {},
    sleep: () => new Promise((resolve) => { releaseSleep = resolve; }),
    httpJson: async () => ({ status: 404, body: "" }),
  });
  const login = engine.cursorLoginFlow().catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.getCursorOAuthStatus().pending, true);
  assert.equal(engine.listAccts().length, 0);
  engine.discardPendingCursorOAuth("authorization is already in progress");
  assert.equal(engine.getCursorOAuthStatus().pending, false);
  assert.equal(engine.listAccts().length, 0);
  if (releaseSleep) releaseSleep();
  await login;
});

test("cursor pending oauth is not cleared on a non-JSON filesystem error", async (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  let releaseSleep = null;
  engine.setCursorRuntimeForTests({
    openUrl: async () => {},
    sleep: () => new Promise((resolve) => { releaseSleep = resolve; }),
    httpJson: async () => ({ status: 404, body: "" }),
  });
  const login = engine.cursorLoginFlow().catch((error) => error);
  const pendingPath = config.CURSOR_OAUTH_PENDING_PATH;
  const startedAt = Date.now();
  while (!fs.existsSync(pendingPath) && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const envelope = fs.readFileSync(pendingPath, "utf8");
  engine.cancelCursorOAuth();
  if (releaseSleep) releaseSleep();
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
  engine.setCursorRuntimeForTests({
    openUrl: async () => {},
    sleep: async () => {},
    httpJson: async () => ({ status: 404, body: "" }),
  });
  assert.equal(engine.restorePendingCursorOAuth(), false);
  fs.readFileSync = originalRead;
  assert.equal(fs.readFileSync(pendingPath, "utf8"), envelope);
  assert.equal(engine.restorePendingCursorOAuth(), true);
  try {
    assert.equal(engine.getCursorOAuthStatus().pending, true);
  } finally {
    engine.cancelCursorOAuth();
  }
});

test("cursor pending oauth still restores from backup after persistent corruption", async (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  let releaseSleep = null;
  engine.setCursorRuntimeForTests({
    openUrl: async () => {},
    sleep: () => new Promise((resolve) => { releaseSleep = resolve; }),
    httpJson: async () => ({ status: 404, body: "" }),
  });
  const login = engine.cursorLoginFlow().catch((error) => error);
  const pendingPath = config.CURSOR_OAUTH_PENDING_PATH;
  const startedAt = Date.now();
  while (!fs.existsSync(pendingPath) && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const envelope = fs.readFileSync(pendingPath, "utf8");
  engine.cancelCursorOAuth();
  if (releaseSleep) releaseSleep();
  await login;

  fs.writeFileSync(`${pendingPath}.bak`, envelope, "utf8");
  fs.writeFileSync(pendingPath, "{ corrupted", "utf8");
  engine.setCursorRuntimeForTests({
    openUrl: async () => {},
    sleep: async () => {},
    httpJson: async () => ({ status: 404, body: "" }),
  });
  assert.equal(engine.restorePendingCursorOAuth(), true);
  try {
    assert.equal(engine.getCursorOAuthStatus().pending, true);
    assert.equal(JSON.parse(fs.readFileSync(pendingPath, "utf8")).protected_payload.length > 0, true);
  } finally {
    engine.cancelCursorOAuth();
  }
});

test("cursor quota usage_limited only follows plan remaining", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "quota@example.com",
    auth_id: "user_quota",
    access_token: cursorToken("quota@example.com", "quota"),
    refresh_token: "refresh-quota",
  });

  engine.setCursorRuntimeForTests({
    httpJson: async (url) => {
      if (String(url).includes("usage-summary")) {
        return {
          status: 200,
          body: JSON.stringify({
            individualUsage: {
              plan: {
                totalPercentUsed: 40,
                autoPercentUsed: 100,
                apiPercentUsed: 100,
              },
            },
          }),
        };
      }
      return { status: 200, body: "{}" };
    },
  });
  await engine.refreshCursorQuota(engine.loadCursorAcct(created.account.id), { force: true });
  const mixed = engine.loadCursorAcct(created.account.id);
  assert.equal(mixed.banned, false);
  assert.equal(mixed.probe.status, "active");
  assert.equal(mixed.quota.plan_remaining_percentage, 60);

  engine.setCursorRuntimeForTests({
    httpJson: async (url) => {
      if (String(url).includes("usage-summary")) {
        return {
          status: 200,
          body: JSON.stringify({
            individualUsage: { plan: { totalPercentUsed: 100, autoPercentUsed: 10, apiPercentUsed: 10 } },
          }),
        };
      }
      return { status: 200, body: "{}" };
    },
  });
  await engine.refreshCursorQuota(engine.loadCursorAcct(created.account.id), { force: true });
  const depleted = engine.loadCursorAcct(created.account.id);
  assert.equal(depleted.banned, false);
  assert.equal(depleted.probe.status, "usage_limited");
  assert.equal(depleted.quota.plan_remaining_percentage, 0);
});

test("cursor same email different auth id stays one account", async (t) => {
  const { engine } = freshEngine(t);
  const first = await engine.upsertCursorAccount({
    email: "same@example.com",
    auth_id: "user_old",
    access_token: cursorToken("same@example.com", "old"),
    refresh_token: "refresh-old",
  });
  const second = await engine.upsertCursorAccount({
    email: "same@example.com",
    auth_id: "user_new",
    access_token: cursorToken("same@example.com", "new"),
    refresh_token: "refresh-new",
  });
  assert.equal(second.account.id, first.account.id);
  assert.equal(second.updated, true);
  assert.equal(engine.listCursorAccts().length, 1);
  assert.equal(engine.loadCursorAcct(first.account.id).auth_id, "user_new");
});

test("cursor collapse folds same-email files and keeps current", async (t) => {
  const { engine } = freshEngine(t);
  const first = await engine.upsertCursorAccount({
    email: "fold@example.com",
    auth_id: "user_fold",
    access_token: cursorToken("fold@example.com", "fold"),
    refresh_token: "refresh-fold",
  });
  engine.setCurrentCursorAccountId(first.account.id);
  const extra = {
    ...first.account,
    id: engine.buildCursorId("fold@example.com", "user_other"),
    auth_id: "user_other",
    created_at: first.account.created_at + 10,
    tokens: {
      ...first.account.tokens,
      auth_id: "user_other",
    },
  };
  engine.saveCursorAcct(extra);
  assert.equal(engine.listCursorAccts().length, 2);
  engine.collapseDuplicateCursorAccounts();
  const remaining = engine.listCursorAccts();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, first.account.id);
  assert.equal(engine.currentCursorAcct().id, first.account.id);
});

test("cursor collapse does not decrypt unique accounts", async (t) => {
  const { engine } = freshEngine(t);
  await engine.upsertCursorAccount({
    email: "unique-a@example.com",
    auth_id: "user_unique_a",
    access_token: cursorToken("unique-a@example.com", "unique-a"),
    refresh_token: "refresh-unique-a",
  });
  await engine.upsertCursorAccount({
    email: "unique-b@example.com",
    auth_id: "user_unique_b",
    access_token: cursorToken("unique-b@example.com", "unique-b"),
    refresh_token: "refresh-unique-b",
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  engine.collapseDuplicateCursorAccounts();
  assert.equal(engine.listCursorAccts({ secrets: false }).length, 2);
  assert.equal(decrypts.count, 0);
});

test("cursor still finds Cursor.exe when existsSync reports it missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-exe-lie-"));
  const previousLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "Local");
  clearEngineModules();
  const originalExists = fs.existsSync;
  try {
    const exePath = path.join(root, "Local", "Programs", "cursor", "Cursor.exe");
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, "fake");
    fs.existsSync = (file) => {
      if (path.resolve(String(file)) === path.resolve(exePath)) return false;
      return originalExists(file);
    };
    const runtime = require("../engine/cursor-runtime");
    assert.equal(runtime.firstExistingCursorExe(), exePath);
  } finally {
    fs.existsSync = originalExists;
    if (previousLocal == null) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocal;
    fs.rmSync(root, { recursive: true, force: true });
    clearEngineModules();
  }
});

test("cursor default exe path does not query running processes", () => {
  const cp = require("node:child_process");
  const runtime = require("../engine/cursor-runtime");
  const original = cp.execFileSync;
  let spawned = false;
  cp.execFileSync = (...args) => {
    spawned = true;
    return original(...args);
  };
  try {
    assert.equal(runtime.defaultCursorExePath(), runtime.firstExistingCursorExe());
    assert.equal(spawned, false);
  } finally {
    cp.execFileSync = original;
  }
});

test("cursor process listing uses Get-Process instead of a full Win32_Process scan", async () => {
  const { defaultListProcesses } = require("../engine/cursor-runtime");
  let command = "";
  const processes = await defaultListProcesses(async (_file, args) => {
    command = String(args[args.length - 1] || "");
    return {
      stdout: JSON.stringify({
        Name: "Cursor.exe",
        ProcessId: 4242,
        ParentProcessId: 0,
        ExecutablePath: "E:\\\\cursor\\\\cursor\\\\Cursor.exe",
      }),
    };
  });
  assert.match(command, /Get-Process/);
  assert.doesNotMatch(command, /Get-CimInstance/);
  assert.equal(processes.length, 1);
  assert.equal(processes[0].pid, 4242);
  assert.equal(processes[0].name, "Cursor.exe");
});

test("cursor unknown email does not bridge two mailboxes", () => {
  const { groupByIdentity } = require("../engine/account-identity");
  const { sameCursorIdentity } = require("../engine/cursor-local");
  const accounts = [
    { id: "a", email: "alpha@example.com", auth_id: "shared-fp" },
    { id: "b", email: "unknown", auth_id: "shared-fp" },
    { id: "c", email: "beta@example.com", auth_id: "shared-fp" },
  ];
  const groups = groupByIdentity(accounts, sameCursorIdentity);
  const groupOf = (email) => groups.find((group) => group.some((item) => item.email === email));
  assert.notEqual(groupOf("alpha@example.com"), groupOf("beta@example.com"));
});

test("cursor upsert keeps quota_error when no new windows arrive", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "keep-error@example.com",
    auth_id: "user_keep",
    access_token: cursorToken("keep-error@example.com", "old"),
    refresh_token: "refresh-old",
  });
  const stored = engine.loadCursorAcct(created.account.id);
  stored.quota_error = { code: "probe_failed", message: "这次没查清额度，请稍后重试。" };
  stored.probe = { status: "probe_failed" };
  engine.saveCursorAcct(stored);
  const updated = await engine.upsertCursorAccount({
    email: "keep-error@example.com",
    auth_id: "user_keep",
    access_token: cursorToken("keep-error@example.com", "new"),
    refresh_token: "refresh-new",
  });
  assert.equal(updated.updated, true);
  assert.equal(updated.account.quota_error.code, "probe_failed");
  assert.equal(engine.loadCursorAcct(created.account.id).quota_error.code, "probe_failed");
});

test("cursor official sync reads sqlite in place and shares one pass", async (t) => {
  const { engine, root } = freshEngine(t);
  const kept = await engine.upsertCursorAccount({
    email: "keep@example.com",
    auth_id: "user_keep",
    access_token: cursorToken("keep@example.com", "keep"),
    refresh_token: "refresh-keep",
  });
  const dbPath = path.join(root, "ttl.vscdb");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("keep@example.com", "keep"),
    "cursorAuth/cachedEmail": "keep@example.com",
    "cursorAuth/authId": "user_keep",
  });
  let pathReads = 0;
  engine.setCursorRuntimeForTests({
    vscdbPath: () => {
      pathReads += 1;
      return dbPath;
    },
  });
  const hits = installVscdbIoSpies(t, dbPath);
  await Promise.all([
    engine.syncCurrentCursorFromOfficial(),
    engine.syncCurrentCursorFromOfficial(),
  ]);
  await engine.syncCurrentCursorFromOfficial();
  assert.equal(pathReads, 1);
  assert.equal(hits.read, 0);
  assert.equal(hits.copy, 0);
  assert.equal(engine.currentCursorAcct().id, kept.account.id);
});

test("cursor official sync in flight does not revert current after switch", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  const first = await engine.upsertCursorAccount({
    email: "old@example.com",
    auth_id: "user_old",
    access_token: cursorToken("old@example.com", "old"),
    refresh_token: "refresh-old",
  });
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": cursorToken("old@example.com", "old"),
    "cursorAuth/cachedEmail": "old@example.com",
    "cursorAuth/authId": "user_old",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => true,
    sleep: async () => {},
  });
  await engine.doCursorSwitch(engine.loadCursorAcct(first.account.id));
  const next = await engine.upsertCursorAccount({
    email: "next@example.com",
    auth_id: "user_next",
    access_token: cursorToken("next@example.com", "next"),
    refresh_token: "refresh-next",
  });

  const { readVscdbItemRowsLocal } = require("../engine/sqlite-native");
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  let capturedEmail = "";
  engine.setSqliteReadTransport(async (target, keys, options) => {
    const rows = await readVscdbItemRowsLocal(target, keys, options);
    const raw = rows["cursorAuth/cachedEmail"];
    if (raw) capturedEmail = Buffer.from(raw, "base64").toString("utf8").trim();
    await gate;
    return rows;
  });
  t.after(() => engine.setSqliteReadTransport(null));

  const syncing = engine.syncCurrentCursorFromOfficial({ force: true });
  const started = Date.now();
  while (!capturedEmail && Date.now() - started < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(capturedEmail, "old@example.com");
  await engine.doCursorSwitch(engine.loadCursorAcct(next.account.id));
  assert.equal(engine.currentCursorAcct().id, next.account.id);
  releaseRead();
  await syncing;
  assert.equal(engine.currentCursorAcct().id, next.account.id);
});

test("cursor current IPC reuses listed accounts without extra decrypts", async (t) => {
  const { engine } = freshEngine(t);
  const current = await engine.upsertCursorAccount({
    email: "ipc-current@example.com",
    auth_id: "user_ipc_current",
    access_token: cursorToken("ipc-current@example.com", "ipc-current"),
    refresh_token: "refresh-ipc-current",
  });
  await engine.upsertCursorAccount({
    email: "ipc-spare@example.com",
    auth_id: "user_ipc_spare",
    access_token: cursorToken("ipc-spare@example.com", "ipc-spare"),
    refresh_token: "refresh-ipc-spare",
  });
  engine.setCurrentCursorAccountId(current.account.id);
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
  const result = await handlers.get("cursor:current")({}, { skipOfficialSync: true });
  assert.equal(result.success, true);
  assert.equal(result.data.id, current.account.id);
  assert.equal(result.data.email, "ipc-current@example.com");
  assert.equal(result.data.tokens, undefined);
  assert.equal(decrypts.count, 0);
});

test("cursor switch IPC decrypts the target once before switching", async (t) => {
  const { engine } = freshEngine(t);
  const current = await engine.upsertCursorAccount({
    email: "switch-current@example.com",
    auth_id: "user_switch_current",
    access_token: cursorToken("switch-current@example.com", "switch-current"),
    refresh_token: "refresh-switch-current",
  });
  const target = await engine.upsertCursorAccount({
    email: "switch-target@example.com",
    auth_id: "user_switch_target",
    access_token: cursorToken("switch-target@example.com", "switch-target"),
    refresh_token: "refresh-switch-target",
  });
  await engine.upsertCursorAccount({
    email: "switch-spare@example.com",
    auth_id: "user_switch_spare",
    access_token: cursorToken("switch-spare@example.com", "switch-spare"),
    refresh_token: "refresh-switch-spare",
  });
  engine.setCurrentCursorAccountId(current.account.id);
  const switched = [];
  engine.doCursorSwitch = async (account) => {
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
  const missing = await handlers.get("cursor:switch")({}, "cursor_missing");
  assert.equal(missing.success, false);
  assert.equal(switched.length, 0);
  assert.equal(decrypts.count, 0);

  decrypts.reset();
  const result = await handlers.get("cursor:switch")({}, target.account.id);
  assert.equal(result.success, true);
  assert.equal(result.data.account.id, target.account.id);
  assert.equal(switched.length, 1);
  assert.ok(switched[0].tokens?.access_token);
  assert.equal(decrypts.count, 1);
});

test("cursor reauthorize IPC does not decrypt before starting OAuth", async (t) => {
  const { engine } = freshEngine(t);
  const current = await engine.upsertCursorAccount({
    email: "reauth-current@example.com",
    auth_id: "user_reauth_current",
    access_token: cursorToken("reauth-current@example.com", "reauth-current"),
    refresh_token: "refresh-reauth-current",
  });
  await engine.upsertCursorAccount({
    email: "reauth-spare@example.com",
    auth_id: "user_reauth_spare",
    access_token: cursorToken("reauth-spare@example.com", "reauth-spare"),
    refresh_token: "refresh-reauth-spare",
  });
  const started = [];
  engine.cursorLoginFlow = async (options) => {
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
  const missing = await handlers.get("cursor:reauthorize")({}, "cursor_missing");
  assert.equal(missing.success, false);
  assert.equal(started.length, 0);
  assert.equal(decrypts.count, 0);

  decrypts.reset();
  const result = await handlers.get("cursor:reauthorize")({}, current.account.id);
  assert.equal(result.success, true);
  assert.equal(result.data.targetAccountId, current.account.id);
  assert.deepEqual(started, [current.account.id]);
  assert.equal(decrypts.count, 0);
});

test("cursor delete IPC removes a spare account without decrypting", async (t) => {
  const { engine } = freshEngine(t);
  const current = await engine.upsertCursorAccount({
    email: "del-current@example.com",
    auth_id: "user_del_current",
    access_token: cursorToken("del-current@example.com", "del-current"),
    refresh_token: "refresh-del-current",
  });
  const spare = await engine.upsertCursorAccount({
    email: "del-spare@example.com",
    auth_id: "user_del_spare",
    access_token: cursorToken("del-spare@example.com", "del-spare"),
    refresh_token: "refresh-del-spare",
  });
  engine.setCurrentCursorAccountId(current.account.id);
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
  const blocked = await handlers.get("cursor:delete")({}, current.account.id);
  assert.equal(blocked.success, false);
  assert.match(String(blocked.error), /Switch to another account/);
  assert.equal(engine.listCursorAccts({ secrets: false }).length, 2);
  assert.equal(decrypts.count, 0);

  decrypts.reset();
  const removed = await handlers.get("cursor:delete")({}, spare.account.id);
  assert.equal(removed.success, true);
  assert.equal(engine.listCursorAccts({ secrets: false }).length, 1);
  assert.equal(engine.listCursorAccts({ secrets: false })[0].id, current.account.id);
  assert.equal(engine.loadCursorIdx().current_cursor_account_id, current.account.id);
  assert.equal(decrypts.count, 0);
});

test("cursor refreshAll publishes from the in-memory account without a second decrypt", async (t) => {
  const { engine } = freshEngine(t);
  const first = await engine.upsertCursorAccount({
    email: "batch-one@example.com",
    auth_id: "user_batch_one",
    access_token: cursorToken("batch-one@example.com", "batch-one"),
    refresh_token: "refresh-batch-one",
  });
  const second = await engine.upsertCursorAccount({
    email: "batch-two@example.com",
    auth_id: "user_batch_two",
    access_token: cursorToken("batch-two@example.com", "batch-two"),
    refresh_token: "refresh-batch-two",
  });
  engine.refreshCursorQuota = async (account) => {
    account.quota = { membership_type: "pro" };
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
  const result = await handlers.get("cursor:refreshAllQuotas")({});
  assert.equal(result.success, true);
  assert.equal(result.data.length, 2);
  assert.equal(result.data.find((item) => item.id === first.account.id).quota.membership_type, "pro");
  assert.equal(result.data.find((item) => item.id === second.account.id).quota.membership_type, "pro");
  assert.equal(decrypts.count, 2);

  engine.refreshCursorQuota = async (account) => {
    account.requires_reauth = true;
    account.quota_error = { code: "reauthorization_required", message: "expired", timestamp: 1 };
    return account.quota;
  };
  decrypts.reset();
  const skipped = await handlers.get("cursor:refreshAllQuotas")({});
  assert.equal(skipped.success, true);
  assert.ok(skipped.data.every((item) => item.skipped === true && item.reason === "reauthorization_required"));
  assert.equal(decrypts.count, 2);
});

test("cursor refreshAll skips persisted reauth accounts without decrypting them", async (t) => {
  const { engine } = freshEngine(t);
  const reauth = await engine.upsertCursorAccount({
    email: "batch-reauth@example.com",
    auth_id: "user_batch_reauth",
    access_token: cursorToken("batch-reauth@example.com", "batch-reauth"),
    refresh_token: "refresh-batch-reauth",
  });
  const stored = engine.loadCursorAcct(reauth.account.id);
  stored.requires_reauth = true;
  engine.saveCursorAcct(stored);
  const live = await engine.upsertCursorAccount({
    email: "batch-live@example.com",
    auth_id: "user_batch_live",
    access_token: cursorToken("batch-live@example.com", "batch-live"),
    refresh_token: "refresh-batch-live",
  });
  engine.refreshCursorQuota = async (account) => {
    account.quota = { membership_type: "pro" };
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
  const result = await handlers.get("cursor:refreshAllQuotas")({});
  assert.equal(result.success, true);
  const skipped = result.data.find((item) => item.id === reauth.account.id);
  const okRow = result.data.find((item) => item.id === live.account.id);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "reauthorization_required");
  assert.equal(okRow.quota.membership_type, "pro");
  assert.equal(decrypts.count, 1);
});

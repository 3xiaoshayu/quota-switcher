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
  assert.equal(imported.stalePossible, false);
  assert.equal(engine.currentCursorAcct().id, imported.account.id);
  assert.equal(engine.listAccts().length, 0);
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

test("cursor list sync does not guess current while WAL is pending", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "state.vscdb");
  const first = await engine.upsertCursorAccount({
    email: "keep@example.com",
    auth_id: "user_keep",
    access_token: cursorToken("keep@example.com", "keep"),
  });
  await engine.upsertCursorAccount({
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
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64, 3));
  const current = await engine.syncCurrentCursorFromOfficial();
  assert.equal(current.id, first.account.id);
});

test("cursor list sync can fill an empty current from a WAL checkpoint", async (t) => {
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
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64, 3));
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
  const closed = [];
  const launched = [];
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => listed,
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
  const values = await engine.readCursorAuth(dbPath, { copyFirst: false });
  assert.equal(values["cursorAuth/cachedEmail"], "next@example.com");
  assert.equal(values["cursor.email"], "next@example.com");
  assert.equal(engine.currentCursorAcct().id, created.account.id);
  assert.equal(engine.listAccts().length, 0);
});

test("cursor switch refuses to overwrite vscdb while WAL is pending", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  const before = fs.readFileSync(dbPath);
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64, 7));
  const created = await engine.upsertCursorAccount({
    email: "wal@example.com",
    auth_id: "user_wal",
    access_token: cursorToken("wal@example.com", "wal"),
    refresh_token: "refresh-wal",
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
    /登录库写完/,
  );
  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.equal(engine.hasPendingWal(dbPath), true);
  assert.deepEqual(launched, [exePath]);
});

test("cursor switch does not rollback a live vscdb after WAL refuse relaunch", async (t) => {
  const { engine, root } = freshEngine(t);
  const dbPath = path.join(root, "cursor-state.vscdb");
  const exePath = path.join(root, "Cursor.exe");
  fs.writeFileSync(exePath, "fake");
  await engine.writeCursorAuth(dbPath, {
    "cursorAuth/accessToken": "old-token",
    "cursorAuth/cachedEmail": "old@example.com",
  });
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64, 7));
  const created = await engine.upsertCursorAccount({
    email: "wal-live@example.com",
    auth_id: "user_wal_live",
    access_token: cursorToken("wal-live@example.com", "wal_live"),
    refresh_token: "refresh-wal-live",
  });
  engine.setCursorRuntimeForTests({
    vscdbPath: () => dbPath,
    cursorExePath: () => exePath,
    listProcesses: async () => [],
    launch: () => {
      fs.writeFileSync(dbPath, Buffer.from("cursor-rewrote-after-launch"));
    },
    sleep: async () => {},
  });
  await assert.rejects(
    () => engine.doCursorSwitch(engine.loadCursorAcct(created.account.id)),
    /登录库写完/,
  );
  assert.equal(fs.readFileSync(dbPath, "utf8"), "cursor-rewrote-after-launch");
  assert.equal(engine.hasPendingWal(dbPath), true);
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
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64, 3));
  engine.setCursorRuntimeForTests({ vscdbPath: () => dbPath });
  const imported = await engine.importLocalCursorAccount();
  assert.equal(imported.found, true);
  assert.equal(imported.stalePossible, true);
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

test("cursor official sync copies sqlite asynchronously and shares one pass", async (t) => {
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
  engine.setCursorRuntimeForTests({ vscdbPath: () => dbPath });
  let asyncCopies = 0;
  let syncCopies = 0;
  const originalAsync = fs.promises.copyFile;
  const originalSync = fs.copyFileSync;
  fs.promises.copyFile = async (...args) => {
    asyncCopies += 1;
    return originalAsync.apply(fs.promises, args);
  };
  fs.copyFileSync = (...args) => {
    if (String(args[1] || "").includes("cursor-vscdb")) syncCopies += 1;
    return originalSync(...args);
  };
  t.after(() => {
    fs.promises.copyFile = originalAsync;
    fs.copyFileSync = originalSync;
  });
  await Promise.all([
    engine.syncCurrentCursorFromOfficial(),
    engine.syncCurrentCursorFromOfficial(),
  ]);
  const afterPair = asyncCopies;
  await engine.syncCurrentCursorFromOfficial();
  assert.equal(syncCopies, 0);
  assert.ok(afterPair >= 1);
  assert.equal(asyncCopies, afterPair);
  assert.equal(engine.currentCursorAcct().id, kept.account.id);
});

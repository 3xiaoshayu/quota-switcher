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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-manager-test-"));
  process.env.CODEX_MANAGER_DATA_DIR = path.join(root, "data");
  process.env.CODEX_MANAGER_CODEX_DIR = path.join(root, "codex");
  process.env.CODEX_MANAGER_CALLBACK_PORT = String(24000 + Math.floor(Math.random() * 10000));
  clearEngineModules();
  const engine = require("../engine");
  const codec = {
    name: "test-codec",
    encrypt: value => Buffer.from(value, "utf8").toString("base64"),
    decrypt: value => Buffer.from(value, "base64").toString("utf8"),
  };
  engine.setSecretCodec(codec);
  let launched = false;
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: async () => launched
      ? [{
        name: "ChatGPT.exe",
        pid: 4242,
        parentPid: 0,
        executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT\\ChatGPT.exe",
        windowTitle: "ChatGPT",
      }]
      : [],
    gracefulClose: async () => {
      launched = false;
      return true;
    },
    forceClose: async () => {
      launched = false;
      return true;
    },
    launch() { launched = true; },
    sleep: async () => {},
  });
  t.after(() => {
    try { engine.cancelOAuth(); } catch {}
    try { engine.resetPendingAccountRewritesForTests(); } catch {}
    engine.setSwitchRuntimeForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { engine, root, codec };
}

function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function tokens(email, accountId, suffix) {
  const payload = {
    email,
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      account_id: accountId,
      user_id: `user-${suffix}`,
      chatgpt_plan_type: "plus",
      organizations: [],
    },
  };
  return {
    id_token: jwt(payload),
    access_token: jwt(payload),
    refresh_token: `refresh-${suffix}`,
  };
}

async function addAccount(engine, email, accountId, suffix) {
  return (await engine.upsert(tokens(email, accountId, suffix))).account;
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

function stubTornJsonReads(t, filePath, tornReads = 2) {
  const originalRead = fs.readFileSync;
  let remaining = tornReads;
  fs.readFileSync = (target, encoding) => {
    if (path.resolve(String(target)) === path.resolve(filePath) && remaining > 0) {
      remaining -= 1;
      return encoding === undefined ? Buffer.from("{") : "{";
    }
    return originalRead(target, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
}

test("aligned auth inspect decrypts only the current account", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "first-aligned@example.com", "acct-first-aligned", "first-aligned");
  await addAccount(engine, "spare-aligned@example.com", "acct-spare-aligned", "spare-aligned");
  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  const firstAuth = engine.writeAuthJson(first);
  engine.writeProjection(first, firstAuth);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  assert.equal(engine.inspectAuthState({ migrateProjection: false }).status, "aligned");
  assert.equal(decrypts.count, 1);
});

test("conflict auth inspect still matches the official account among all records", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "first-conflict@example.com", "acct-first-conflict", "first-conflict");
  const second = await addAccount(engine, "second-conflict@example.com", "acct-second-conflict", "second-conflict");
  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  engine.writeAuthJson(first);
  engine.writeProjection(first, engine.writeAuthJson(first));
  const secondAuth = require("../engine/switch").buildAuthJson(second);
  const config = require("../engine/config");
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(secondAuth), "utf8");
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const conflict = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.matchedAccountId, second.id);
  assert.equal(decrypts.count, 1);
});

test("conflict auth inspect still matches a legacy record without plaintext account_id", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "first-legacy-conflict@example.com", "acct-first-legacy-conflict", "first-legacy-conflict");
  const second = await addAccount(engine, "second-legacy-conflict@example.com", "acct-second-legacy-conflict", "second-legacy-conflict");
  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  engine.writeAuthJson(first);
  engine.writeProjection(first, engine.writeAuthJson(first));
  const filePath = engine.accountFilePath(second.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.account_id;
  delete raw.email;
  fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");
  const secondAuth = require("../engine/switch").buildAuthJson(engine.loadAcct(second.id));
  const config = require("../engine/config");
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(secondAuth), "utf8");
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const conflict = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.matchedAccountId, second.id);
  // Current account plus the one stripped record. A vault-wide decrypt used to be 3.
  assert.equal(decrypts.count, 2);
});

test("conflict auth inspect does not decrypt identified neighbors of a legacy match", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "first-legacy-spare@example.com", "acct-first-legacy-spare", "first-legacy-spare");
  const second = await addAccount(engine, "second-legacy-spare@example.com", "acct-second-legacy-spare", "second-legacy-spare");
  await addAccount(engine, "spare-legacy-spare@example.com", "acct-spare-legacy-spare", "spare-legacy-spare");
  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  engine.writeAuthJson(first);
  engine.writeProjection(first, engine.writeAuthJson(first));
  const filePath = engine.accountFilePath(second.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.account_id;
  delete raw.email;
  fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");
  const secondAuth = require("../engine/switch").buildAuthJson(engine.loadAcct(second.id));
  const config = require("../engine/config");
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(secondAuth), "utf8");
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const conflict = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.matchedAccountId, second.id);
  assert.equal(decrypts.count, 2);
});

test("conflict auth inspect matches a listed email without decrypting the rest of the vault", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "first-email-conflict@example.com", "acct-first-email-conflict", "first-email-conflict");
  const second = await addAccount(engine, "second-email-conflict@example.com", "acct-second-email-conflict", "second-email-conflict");
  await addAccount(engine, "spare-email-conflict@example.com", "acct-spare-email-conflict", "spare-email-conflict");
  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  engine.writeAuthJson(first);
  engine.writeProjection(first, engine.writeAuthJson(first));
  const filePath = engine.accountFilePath(second.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.account_id;
  fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");
  const secondAuth = require("../engine/switch").buildAuthJson(engine.loadAcct(second.id));
  const config = require("../engine/config");
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(secondAuth), "utf8");
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const conflict = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.matchedAccountId, second.id);
  // Current account plus a vault-wide decrypt used to be 4.
  assert.equal(decrypts.count, 1);
});

test("conflict auth inspect still prefers account id when two records share an email", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "shared-conflict@example.com", "acct-shared-conflict-one", "shared-conflict-one");
  const second = await addAccount(engine, "shared-conflict@example.com", "acct-shared-conflict-two", "shared-conflict-two");
  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  engine.writeAuthJson(first);
  engine.writeProjection(first, engine.writeAuthJson(first));
  const secondAuth = require("../engine/switch").buildAuthJson(second);
  const config = require("../engine/config");
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(secondAuth), "utf8");
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const conflict = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.matchedAccountId, second.id);
  assert.equal(decrypts.count, 1);
});

test("auth inspect retries a transient official auth.json lock", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "auth-retry@example.com", "acct-auth-retry", "auth-retry");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const originalRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(authPath) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  assert.equal(engine.inspectAuthState({ migrateProjection: false }).status, "aligned");
  assert.equal(failures, 2);
});

test("auth inspect does not treat a locked official auth.json as missing", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "auth-locked@example.com", "acct-auth-locked", "auth-locked");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(authPath)) {
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  assert.throws(
    () => engine.inspectAuthState({ migrateProjection: false }),
    (error) => error.code === "EPERM" && error.transientIoError === true,
  );
});

test("background auth inspect cancels work that never acquired the lock", async () => {
  const { inspectAuthStateWithBusyTimeout } = require("../src/main/ipc-handlers");
  let inspectCount = 0;
  let lockReleased;
  const lockDone = new Promise((resolve) => { lockReleased = resolve; });
  const engine = {
    inspectAuthState: () => {
      inspectCount += 1;
      return { status: "aligned" };
    },
    withAccountLock: async (_id, task) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        return await task();
      } finally {
        lockReleased();
      }
    },
  };
  const started = Date.now();
  await assert.rejects(
    () => inspectAuthStateWithBusyTimeout(engine, "account-one"),
    /Authentication state is busy/,
  );
  assert.ok(Date.now() - started < 1800);
  await lockDone;
  assert.equal(inspectCount, 0);
});

test("quota refreshAll lists without decrypting then loads each account for work", async (t) => {
  const { engine } = freshEngine(t);
  await addAccount(engine, "batch-one@example.com", "acct-batch-one", "batch-one");
  await addAccount(engine, "batch-two@example.com", "acct-batch-two", "batch-two");
  engine.refreshQuota = async (account) => account.quota || {};
  engine.probeUsageOnly = async (account) => account.quota || {};
  const handlers = new Map();
  const electron = {
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
    BrowserWindow: { getAllWindows: () => [] },
    app: { getVersion: () => "2.0.1", isPackaged: false },
    shell: { async openExternal() {}, async openPath() { return ""; } },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await handlers.get("quota:refreshAll")({});
  assert.equal(result.success, true);
  assert.equal(result.data.length, 2);
  // listAccts({ secrets: false }) adds 0; each account is loadAcct once inside
  // the lock and published from that same object.
  assert.equal(decrypts.count, 2);
});

test("quota refreshAll reports in-memory bans without a second decrypt", async (t) => {
  const { engine } = freshEngine(t);
  const banned = await addAccount(engine, "batch-banned@example.com", "acct-batch-banned", "batch-banned");
  await addAccount(engine, "batch-ok@example.com", "acct-batch-ok", "batch-ok");
  engine.refreshQuota = async (account) => {
    if (account.id === banned.id) {
      account.banned = true;
      const error = new Error("The target account is banned and cannot refresh quotas");
      error.code = "account_banned";
      throw error;
    }
    return account.quota || {};
  };
  engine.probeUsageOnly = async (account) => account.quota || {};
  const handlers = new Map();
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
  const result = await handlers.get("quota:refreshAll")({});
  assert.equal(result.success, true);
  assert.equal(result.data.length, 2);
  const failed = result.data.find((item) => item.id === banned.id);
  const okRow = result.data.find((item) => item.id !== banned.id);
  assert.equal(failed.banned, true);
  assert.equal(failed.reason, "account_banned");
  assert.equal(okRow.error, undefined);
  assert.equal(decrypts.count, 2);
});

test("quota refreshAll skips persisted reauth accounts without leftover access", async (t) => {
  const { engine } = freshEngine(t);
  const reauth = await addAccount(engine, "batch-reauth@example.com", "acct-batch-reauth", "batch-reauth");
  reauth.requires_reauth = true;
  reauth.tokens.access_token = "";
  engine.saveAcct(reauth);
  const live = await addAccount(engine, "batch-live@example.com", "acct-batch-live", "batch-live");
  engine.refreshQuota = async (account) => account.quota || {};
  engine.probeUsageOnly = async () => {
    throw new Error("should not probe a leftover-less reauth account");
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
  const listedReauth = engine.listAccts({ secrets: false }).find((item) => item.id === reauth.id);
  assert.equal(listedReauth.requires_reauth, true);
  assert.equal(listedReauth.has_access, false);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await handlers.get("quota:refreshAll")({});
  assert.equal(result.success, true);
  const skipped = result.data.find((item) => item.id === reauth.id);
  const okRow = result.data.find((item) => item.id === live.id);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "reauthorization_required");
  assert.equal(okRow.error, undefined);
  assert.equal(decrypts.count, 1);
});

test("concurrent Codex upserts of the same identity keep one account", async (t) => {
  const { engine } = freshEngine(t);
  const [first, second] = await Promise.all([
    engine.upsert(tokens("same-identity@example.com", "acct-same-identity", "same-a")),
    engine.upsert(tokens("same-identity@example.com", "acct-same-identity", "same-b")),
  ]);
  assert.equal(engine.listAccts().length, 1);
  assert.equal(first.account.id, second.account.id);
});

test("Codex upsert identity scan does not decrypt the rest of the vault", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "keep-upsert@example.com", "acct-keep-upsert", "keep-upsert");
  await addAccount(engine, "spare-upsert-a@example.com", "acct-spare-upsert-a", "spare-upsert-a");
  await addAccount(engine, "spare-upsert-b@example.com", "acct-spare-upsert-b", "spare-upsert-b");
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const created = await engine.upsert(tokens("fresh-upsert@example.com", "acct-fresh-upsert", "fresh-upsert"));
  assert.equal(created.updated, false);
  assert.notEqual(created.account.id, first.id);
  assert.ok(decrypts.count <= 6);
  decrypts.reset();
  const again = await engine.upsert(tokens("keep-upsert@example.com", "acct-keep-upsert", "keep-upsert-again"));
  assert.equal(again.updated, true);
  assert.equal(again.account.id, first.id);
  assert.ok(decrypts.count <= 6);
  assert.equal(engine.listAccts().length, 4);
});

test("quota parsing preserves window absence, clamps percentages, and applies weekly blocking", t => {
  freshEngine(t);
  const { parseQuotaPayload } = require("../engine/quota");

  const missingWeekly = parseQuotaPayload({
    rate_limit: { primary_window: { used_percent: -20, limit_window_seconds: 18000 } },
  });
  assert.equal(missingWeekly.hourly_remaining_percentage, 100);
  assert.equal(missingWeekly.weekly_remaining_percentage, null);
  assert.equal(missingWeekly.weekly_window_present, false);

  const blocked = parseQuotaPayload({
    rate_limit: {
      primary_window: { used_percent: 10 },
      secondary_window: { used_percent: 120 },
    },
  });
  assert.equal(blocked.weekly_remaining_percentage, 0);
  assert.equal(blocked.hourly_remaining_percentage, 0);
  assert.equal(blocked.weekly_blocks_hourly, true);

  const malformed = parseQuotaPayload({
    rate_limit: {
      primary_window: {},
      secondary_window: { used_percent: "not-a-number" },
    },
  });
  assert.equal(malformed.hourly_window_present, true);
  assert.equal(malformed.hourly_remaining_percentage, null);
  assert.equal(malformed.weekly_window_present, true);
  assert.equal(malformed.weekly_remaining_percentage, null);
});

test("quota windows are classified by duration, not position", t => {
  freshEngine(t);
  const { parseQuotaPayload, normalizeQuota, extractQuotaMetrics } = require("../engine/quota");

  // Upstream currently ships only the weekly window, placed in primary_window.
  const weeklyOnly = parseQuotaPayload({
    rate_limit: { primary_window: { used_percent: 59, limit_window_seconds: 604800 } },
  });
  assert.equal(weeklyOnly.hourly_window_present, false);
  assert.equal(weeklyOnly.hourly_remaining_percentage, null);
  assert.equal(weeklyOnly.weekly_window_present, true);
  assert.equal(weeklyOnly.weekly_remaining_percentage, 41);
  assert.equal(weeklyOnly.weekly_blocks_hourly, false);

  // The classic two-window layout keeps its slots.
  const classic = parseQuotaPayload({
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
    },
  });
  assert.equal(classic.hourly_remaining_percentage, 90);
  assert.equal(classic.weekly_remaining_percentage, 80);

  // Records saved by older versions are re-derived from their raw payload.
  const stale = {
    hourly_remaining_percentage: 41,
    hourly_window_present: true,
    weekly_remaining_percentage: null,
    weekly_window_present: false,
    raw_data: { rate_limit: { primary_window: { used_percent: 59, limit_window_seconds: 604800 } } },
  };
  const normalized = normalizeQuota(stale);
  assert.equal(normalized.hourly_window_present, false);
  assert.equal(normalized.weekly_remaining_percentage, 41);

  // Auto-switch metrics follow the corrected slots, so the weekly threshold applies.
  const metrics = extractQuotaMetrics({ quota: stale });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].key, "secondary_window");
  assert.equal(metrics[0].percentage, 41);
});

test("quota authorization retries once after repairing an invalidated access token", async t => {
  freshEngine(t);
  const { fetchQuotaWithTokenRepair, isQuotaAuthError } = require("../engine/quota");
  const account = { tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) } };
  let fetchCount = 0;
  let refreshCount = 0;
  const quota = await fetchQuotaWithTokenRepair(account, {
    fetchQuota: async () => {
      fetchCount += 1;
      if (fetchCount === 1) throw new Error("HTTP 401 token_invalidated");
      return { hourly_remaining_percentage: 75 };
    },
    refreshOneTok: async (_account, options) => {
      refreshCount += 1;
      assert.equal(options.force, true);
      return { ok: true };
    },
  });

  assert.equal(isQuotaAuthError(new Error("HTTP 401 token_revoked")), true);
  assert.equal(fetchCount, 2);
  assert.equal(refreshCount, 1);
  assert.equal(quota.hourly_remaining_percentage, 75);
});

test("usage account_deactivated does not force another token refresh", async t => {
  freshEngine(t);
  const { fetchQuotaWithTokenRepair } = require("../engine/quota");
  const account = {
    tokens: {
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "old-refresh",
    },
  };
  let refreshCount = 0;
  let err;
  try {
    await fetchQuotaWithTokenRepair(account, {
      fetchQuota: async () => {
        throw new Error("HTTP 401 account_deactivated");
      },
      refreshOneTok: async () => {
        refreshCount += 1;
        return { ok: true };
      },
    });
  } catch (error) {
    err = error;
  }
  assert.ok(err);
  assert.equal(refreshCount, 0);
  assert.equal(err.probe.status, "banned");
});

test("quota refresh does not ask for reauth when an expired token hits HTTP 500", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "token-500@example.com", "acct-token-500", "token-500");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  account.tokens.refresh_token = "refresh-token-500";
  engine.saveAcct(account);
  const tokenRefresh = require("../engine/token-refresh");
  const originalRefresh = tokenRefresh.refreshOneTok;
  tokenRefresh.refreshOneTok = async () => ({
    ok: false,
    error: "HTTP 500 temporarily_unavailable",
    revoked: false,
    reauthRequired: false,
  });
  t.after(() => { tokenRefresh.refreshOneTok = originalRefresh; });
  await assert.rejects(
    () => engine.refreshQuota(engine.loadAcct(account.id), { force: true }),
    /HTTP 500/,
  );
  const latest = engine.loadAcct(account.id);
  assert.equal(latest.requires_reauth, false);
  assert.doesNotMatch(String(latest.quota_error?.message || ""), /Token 已过期且刷新失败/);
  assert.match(String(latest.quota_error?.message || ""), /HTTP 500/);
  assert.ok(Number(latest.quota_next_retry_at) > Math.floor(Date.now() / 1000));
  await assert.rejects(
    () => engine.refreshQuota(engine.loadAcct(account.id), { force: false }),
    /waiting for retry|quota_retry_pending/,
  );
});

test("codex quota 429 honors Retry-After instead of a fixed 15 minutes", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "retry-after@example.com", "acct-retry-after", "retry-after");
  account.quota = {
    weekly_remaining_percentage: 81,
    weekly_window_present: true,
  };
  engine.saveAcct(account);
  const httpClient = require("../engine/http-client");
  httpClient.setHttpJsonTransport(async () => ({
    status: 429,
    headers: { "retry-after": "45" },
    body: JSON.stringify({ detail: { code: "rate_limit" } }),
  }));
  t.after(() => httpClient.setHttpJsonTransport(null));
  const started = Math.floor(Date.now() / 1000);
  await assert.rejects(
    () => engine.refreshQuota(engine.loadAcct(account.id), { force: true }),
    /429|rate.?limit/,
  );
  const latest = engine.loadAcct(account.id);
  const delay = Number(latest.quota_next_retry_at) - started;
  assert.ok(delay >= 45 && delay <= 90, `Retry-After 45s should beat the 15-minute default, got ${delay}s`);
  assert.equal(latest.probe?.status, "probe_failed");
  assert.notEqual(latest.probe?.status, "usage_limited");
  assert.equal(latest.quota.weekly_remaining_percentage, 81);
  assert.equal(latest.requires_reauth, false);
  assert.equal(latest.banned, false);
});

test("codex quota 429 honors x-ratelimit-reset-requests when Retry-After is missing", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "reset-requests@example.com", "acct-reset-requests", "reset-requests");
  const httpClient = require("../engine/http-client");
  httpClient.setHttpJsonTransport(async () => ({
    status: 429,
    headers: { "x-ratelimit-reset-requests": "45s" },
    body: JSON.stringify({ detail: { code: "rate_limit" } }),
  }));
  t.after(() => httpClient.setHttpJsonTransport(null));
  const started = Math.floor(Date.now() / 1000);
  await assert.rejects(
    () => engine.refreshQuota(engine.loadAcct(account.id), { force: true }),
    /429|rate.?limit/,
  );
  const latest = engine.loadAcct(account.id);
  const delay = Number(latest.quota_next_retry_at) - started;
  assert.ok(delay >= 45 && delay <= 90, `x-ratelimit-reset-requests 45s should beat the 15-minute default, got ${delay}s`);
  assert.equal(latest.probe?.status, "probe_failed");
  assert.equal(latest.requires_reauth, false);
});

test("codex quota 429 honors a fractional Retry-After instead of a fixed 15 minutes", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "retry-after-frac@example.com", "acct-retry-after-frac", "retry-after-frac");
  const httpClient = require("../engine/http-client");
  httpClient.setHttpJsonTransport(async () => ({
    status: 429,
    headers: { "retry-after": "45.2" },
    body: JSON.stringify({ detail: { code: "rate_limit" } }),
  }));
  t.after(() => httpClient.setHttpJsonTransport(null));
  const started = Math.floor(Date.now() / 1000);
  await assert.rejects(
    () => engine.refreshQuota(engine.loadAcct(account.id), { force: true }),
    /429|rate.?limit/,
  );
  const latest = engine.loadAcct(account.id);
  const delay = Number(latest.quota_next_retry_at) - started;
  assert.ok(delay >= 45 && delay <= 90, `fractional Retry-After 45.2s should beat the 15-minute default, got ${delay}s`);
  assert.equal(latest.probe?.status, "probe_failed");
  assert.notEqual(latest.probe?.status, "usage_limited");
});

test("quota repair does not ask for reauth when token refresh hits HTTP 500", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "repair-500@example.com", "acct-repair-500", "repair-500");
  const quotaModule = require("../engine/quota");
  const originalRepair = quotaModule.fetchQuotaWithTokenRepair;
  quotaModule.fetchQuotaWithTokenRepair = async (acct) => originalRepair(acct, {
    fetchQuota: async () => {
      throw new Error("HTTP 401 token_invalidated");
    },
    refreshOneTok: async () => ({
      ok: false,
      error: "HTTP 500 temporarily_unavailable",
      revoked: false,
      reauthRequired: false,
    }),
  });
  t.after(() => { quotaModule.fetchQuotaWithTokenRepair = originalRepair; });
  await assert.rejects(
    () => quotaModule.refreshQuota(engine.loadAcct(account.id), { force: true }),
    /HTTP 500/,
  );
  const latest = engine.loadAcct(account.id);
  assert.equal(latest.requires_reauth, false);
  assert.doesNotMatch(String(latest.quota_error?.message || ""), /Quota authorization could not be repaired|请重新授权|Token 已过期/);
  assert.match(String(latest.quota_error?.message || ""), /HTTP 500/);
  assert.ok(Number(latest.quota_next_retry_at) > Math.floor(Date.now() / 1000));
});

test("quota refresh still asks for reauth when an expired token is revoked", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "token-revoked@example.com", "acct-token-revoked", "token-revoked");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  account.tokens.refresh_token = "refresh-token-revoked";
  engine.saveAcct(account);
  const tokenRefresh = require("../engine/token-refresh");
  const originalRefresh = tokenRefresh.refreshOneTok;
  tokenRefresh.refreshOneTok = async () => ({
    ok: false,
    error: "invalid_grant",
    revoked: true,
    reauthRequired: true,
  });
  t.after(() => { tokenRefresh.refreshOneTok = originalRefresh; });
  await assert.rejects(
    () => engine.refreshQuota(engine.loadAcct(account.id), { force: true }),
    /Token 已过期且刷新失败/,
  );
  const latest = engine.loadAcct(account.id);
  assert.match(String(latest.quota_error?.message || ""), /请重新授权/);
  assert.doesNotMatch(String(latest.quota_error?.message || ""), /额度暂时没刷到|服务暂时不可用/);
});

test("refresh success plus usage account_deactivated keeps the new refresh token", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "banned@example.com", "acct-banned", "banned");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  account.tokens.refresh_token = "old-refresh";
  engine.saveAcct(account);

  const { fetchQuotaWithTokenRepair } = require("../engine/quota");
  let refreshCount = 0;
  let err;
  try {
    await fetchQuotaWithTokenRepair(account, {
      fetchQuota: async () => {
        throw new Error("HTTP 401 account_deactivated");
      },
      refreshOneTok: async (acct) => {
        refreshCount += 1;
        acct.tokens.refresh_token = "rotated-refresh";
        acct.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        return { ok: true };
      },
    });
  } catch (error) {
    err = error;
  }
  assert.ok(err);
  assert.equal(err.probe.status, "banned");
  assert.equal(refreshCount, 1);
  assert.equal(account.tokens.refresh_token, "rotated-refresh");
});

test("refreshQuota stores banned and does not let a later timeout clear it", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "sticky@example.com", "acct-sticky", "sticky");
  const quotaModule = require("../engine/quota");
  const originalFetch = quotaModule.fetchQuotaWithTokenRepair;
  t.after(() => {
    quotaModule.fetchQuotaWithTokenRepair = originalFetch;
  });

  quotaModule.fetchQuotaWithTokenRepair = async () => {
    const error = new Error("HTTP 401 account_deactivated");
    error.probe = {
      status: "banned",
      error_code: "account_deactivated",
      http_status: 401,
      message: "账号已封号，无法继续使用。",
      ok: false,
    };
    throw error;
  };
  let firstErr;
  try {
    await quotaModule.refreshQuota(account, { force: true });
  } catch (error) {
    firstErr = error;
  }
  assert.ok(firstErr);
  let stored = engine.loadAcct(account.id);
  assert.equal(stored.banned, true);
  assert.equal(stored.probe.status, "banned");

  quotaModule.fetchQuotaWithTokenRepair = async () => {
    throw new Error("请求超时");
  };
  try {
    await quotaModule.refreshQuota(stored, { force: true });
  } catch {}
  stored = engine.loadAcct(account.id);
  assert.equal(stored.banned, true);
  assert.equal(stored.probe.status, "banned");
  assert.equal(stored.probe.error_code, "account_deactivated");
});

test("usage 429 does not force another token refresh", async t => {
  freshEngine(t);
  const { fetchQuotaWithTokenRepair } = require("../engine/quota");
  const account = {
    tokens: {
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "keep-refresh",
    },
  };
  let refreshCount = 0;
  let err;
  try {
    await fetchQuotaWithTokenRepair(account, {
      fetchQuota: async () => {
        throw new Error("HTTP 429 usage_limit_reached");
      },
      refreshOneTok: async () => {
        refreshCount += 1;
        return { ok: true };
      },
    });
  } catch (error) {
    err = error;
  }
  assert.ok(err);
  assert.equal(refreshCount, 0);
  assert.equal(err.probe.status, "usage_limited");
});

test("probeUsageOnly bans a reauth account without refreshing tokens", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "probe-ban@example.com", "acct-probe-ban", "probe-ban");
  account.requires_reauth = true;
  account.reauth_reason = "refresh_token needs re-authorization";
  account.quota_error = { code: "refresh_token_invalidated", message: "keep me", timestamp: engine.ts() };
  engine.saveAcct(account);
  const originalRefresh = account.tokens.refresh_token;
  const { probeUsageOnly } = require("../engine/quota");
  let err;
  try {
    await probeUsageOnly(account, {
      fetchQuota: async () => {
        const error = new Error("HTTP 401 account_deactivated");
        error.probe = {
          status: "banned",
          error_code: "account_deactivated",
          http_status: 401,
          message: "账号已封号，无法继续使用。",
          ok: false,
        };
        throw error;
      },
    });
  } catch (error) {
    err = error;
  }
  assert.ok(err);
  const stored = engine.loadAcct(account.id);
  assert.equal(stored.banned, true);
  assert.equal(stored.probe.status, "banned");
  assert.equal(stored.requires_reauth, true);
  assert.equal(stored.quota_error.code, "account_deactivated");
  assert.equal(stored.tokens.refresh_token, originalRefresh);
});

test("probeUsageOnly keeps reauthorization when leftover access token still works", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "probe-ok@example.com", "acct-probe-ok", "probe-ok");
  account.requires_reauth = true;
  account.quota_error = { code: "refresh_token_invalidated", message: "keep me", timestamp: engine.ts() };
  engine.saveAcct(account);
  const { probeUsageOnly } = require("../engine/quota");
  await probeUsageOnly(account, {
    fetchQuota: async () => ({ hourly_remaining_percentage: 80, weekly_remaining_percentage: 80 }),
  });
  const stored = engine.loadAcct(account.id);
  assert.equal(stored.banned, false);
  assert.equal(stored.probe.status, "active");
  assert.equal(stored.requires_reauth, true);
  assert.equal(stored.quota_error.code, "refresh_token_invalidated");
});

test("probeUsageOnly refuses expired leftover tokens and does not call usage", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "probe-expired@example.com", "acct-probe-expired", "probe-expired");
  account.requires_reauth = true;
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  const { probeUsageOnly, needsBanProbe } = require("../engine/quota");
  let fetchCount = 0;
  await assert.rejects(
    probeUsageOnly(account, {
      fetchQuota: async () => {
        fetchCount += 1;
        return {};
      },
    }),
    /requires reauthorization/i,
  );
  assert.equal(fetchCount, 0);
  assert.equal(needsBanProbe(account), false);
});

test("probeUsageOnly stops after leftover access token is rejected", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "probe-spent@example.com", "acct-probe-spent", "probe-spent");
  account.requires_reauth = true;
  account.probe = {
    status: "probe_failed",
    error_code: "token_invalidated",
    http_status: 401,
    checked_at: engine.ts(),
  };
  engine.saveAcct(account);
  const { probeUsageOnly, canProbeUsageWithoutRefresh, needsBanProbe } = require("../engine/quota");
  let fetchCount = 0;
  await assert.rejects(
    probeUsageOnly(account, {
      fetchQuota: async () => {
        fetchCount += 1;
        return {};
      },
    }),
    /requires reauthorization/i,
  );
  assert.equal(fetchCount, 0);
  assert.equal(canProbeUsageWithoutRefresh(account), false);
  assert.equal(needsBanProbe(account), false);
});

test("probeUsageOnly does not ask banned leftover-dead accounts to reauthorize", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "probe-banned-dead@example.com", "acct-probe-banned-dead", "probe-banned-dead");
  account.banned = true;
  account.probe = {
    status: "probe_failed",
    error_code: "token_invalidated",
    http_status: 401,
    checked_at: engine.ts(),
  };
  engine.saveAcct(account);
  const { probeUsageOnly } = require("../engine/quota");
  let fetchCount = 0;
  await assert.rejects(
    probeUsageOnly(account, {
      fetchQuota: async () => {
        fetchCount += 1;
        return {};
      },
    }),
    (error) => error.code === "account_banned" && /banned and cannot refresh quotas/i.test(error.message),
  );
  assert.equal(fetchCount, 0);
});


test("token refresh IPC does not convert an engine failure into success", () => {
  const { tokenRefreshResponse } = require("../src/main/ipc-handlers");
  assert.deepEqual(
    tokenRefreshResponse({ ok: false, error: "HTTP 403 unsupported_country_region_territory" }),
    { success: false, error: "HTTP 403 unsupported_country_region_territory" },
  );
  assert.deepEqual(
    tokenRefreshResponse({ ok: true, skipped: true }),
    { success: true, data: { ok: true, skipped: true } },
  );
  assert.deepEqual(
    tokenRefreshResponse({ ok: false, skipped: true, reauthRequired: true, error: "该账号需要重新授权后才能刷新令牌" }),
    { success: true, data: { ok: false, skipped: true, reauthRequired: true, error: "该账号需要重新授权后才能刷新令牌" } },
  );
});

test("background quota IPC stops at an authentication conflict", async () => {
  const handlers = new Map();
  let refreshCount = 0;
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const account = { id: "account-one", email: "one@example.com" };
  const engine = {
    inspectAuthState: () => ({
      status: "conflict",
      requiresResolution: true,
      message: "Official Codex authentication changed.",
    }),
    withAccountLock: async (_id, task) => task(),
    loadAcct: () => account,
    async refreshQuota() {
      refreshCount += 1;
      return { hourly_remaining_percentage: 50 };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });

  const background = await handlers.get("quota:refresh")({}, account.id, false);
  assert.equal(background.success, false);
  assert.equal(background.error, "auth_conflict");
  assert.equal(refreshCount, 0);

  const manual = await handlers.get("quota:refresh")({}, account.id, true);
  assert.equal(manual.success, true);
  assert.equal(refreshCount, 1);
});

test("background quota IPC still runs when official auth.json is missing", async () => {
  const handlers = new Map();
  let refreshCount = 0;
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const account = { id: "account-missing-auth", email: "missing-auth@example.com" };
  const engine = {
    inspectAuthState: () => ({
      status: "missing_official_auth",
      requiresResolution: true,
      message: "Official Codex authentication is missing.",
    }),
    withAccountLock: async (_id, task) => task(),
    loadAcct: () => account,
    async refreshQuota() {
      refreshCount += 1;
      return { hourly_remaining_percentage: 40 };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });

  const background = await handlers.get("quota:refresh")({}, account.id, false);
  assert.equal(background.success, true);
  assert.equal(refreshCount, 1);
});

test("background quota IPC still runs when official auth.json is locked", async () => {
  const handlers = new Map();
  let refreshCount = 0;
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "2.0.4",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const account = { id: "account-locked-auth", email: "locked-auth@example.com" };
  const engine = {
    inspectAuthState() {
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      error.transientIoError = true;
      throw error;
    },
    withAccountLock: async (_id, task) => task(),
    loadAcct: () => account,
    async refreshQuota() {
      refreshCount += 1;
      return { hourly_remaining_percentage: 40 };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });

  const background = await handlers.get("quota:refresh")({}, account.id, false);
  assert.equal(background.success, true);
  assert.notEqual(background.error, "auth_conflict");
  assert.equal(refreshCount, 1);
});

test("quota IPC skips accounts that require reauthorization", async () => {
  const handlers = new Map();
  let quotaRefreshCount = 0;
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const suspended = {
    id: "suspended-account",
    email: "suspended@example.com",
    requires_reauth: true,
  };
  const active = {
    id: "active-account",
    email: "active@example.com",
    requires_reauth: false,
  };
  const accounts = new Map([[suspended.id, suspended], [active.id, active]]);
  const engine = {
    inspectAuthState: () => ({ status: "aligned", requiresResolution: false }),
    listAccts: () => [suspended, active],
    loadAcct: id => accounts.get(id) || null,
    withAccountLock: async (_id, task) => task(),
    async refreshQuota() {
      quotaRefreshCount += 1;
      return { hourly_remaining_percentage: 50 };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });

  const directQuota = await handlers.get("quota:refresh")({}, suspended.id, true);
  assert.equal(directQuota.success, false);
  assert.match(directQuota.error, /requires reauthorization/i);
  assert.equal(quotaRefreshCount, 0);

  const allQuotas = await handlers.get("quota:refreshAll")({});
  assert.equal(allQuotas.success, true);
  assert.deepEqual(allQuotas.data[0], {
    id: suspended.id,
    email: suspended.email,
    skipped: true,
    reason: "reauthorization_required",
    banned: false,
  });
  assert.equal(allQuotas.data[1].id, active.id);
  assert.equal(quotaRefreshCount, 1);
});

test("quota IPC probes leftover access tokens on reauthorization accounts", async () => {
  const handlers = new Map();
  let probeCount = 0;
  let quotaRefreshCount = 0;
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const suspended = {
    id: "suspended-live",
    email: "suspended-live@example.com",
    requires_reauth: true,
    tokens: { access_token: "live-token" },
  };
  const engine = {
    inspectAuthState: () => ({ status: "aligned", requiresResolution: false }),
    listAccts: () => [suspended],
    loadAcct: () => suspended,
    withAccountLock: async (_id, task) => task(),
    canProbeUsageWithoutRefresh: account => !!account.tokens?.access_token,
    async probeUsageOnly() {
      probeCount += 1;
      return { hourly_remaining_percentage: 40 };
    },
    async refreshQuota() {
      quotaRefreshCount += 1;
      return { hourly_remaining_percentage: 50 };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });

  const directQuota = await handlers.get("quota:refresh")({}, suspended.id, true);
  assert.equal(directQuota.success, true);
  assert.equal(probeCount, 1);
  assert.equal(quotaRefreshCount, 0);

  const allQuotas = await handlers.get("quota:refreshAll")({});
  assert.equal(allQuotas.success, true);
  assert.equal(allQuotas.data[0].id, suspended.id);
  assert.equal(allQuotas.data[0].skipped, undefined);
  assert.equal(probeCount, 2);
  assert.equal(quotaRefreshCount, 0);
});

test("quota refreshAll catch includes the error code as reason", async () => {
  const handlers = new Map();
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const suspended = {
    id: "refresh-all-reason",
    email: "refresh-all-reason@example.com",
    requires_reauth: true,
    tokens: { access_token: "live-token" },
  };
  const engine = {
    inspectAuthState: () => ({ status: "aligned", requiresResolution: false }),
    listAccts: () => [suspended],
    loadAcct: () => suspended,
    withAccountLock: async (_id, task) => task(),
    canProbeUsageWithoutRefresh: account => !!account.tokens?.access_token,
    async probeUsageOnly() {
      const error = new Error("Account requires reauthorization before quotas can be refreshed.");
      error.code = "reauthorization_required";
      throw error;
    },
    async refreshQuota() {
      throw new Error("should not refresh");
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });

  const allQuotas = await handlers.get("quota:refreshAll")({});
  assert.equal(allQuotas.success, true);
  assert.equal(allQuotas.data[0].id, suspended.id);
  assert.equal(allQuotas.data[0].reason, "reauthorization_required");
  assert.match(allQuotas.data[0].error, /reauthorization/i);
});

test("quota IPC probes leftover tokens on banned accounts and skips token refresh", async () => {
  const handlers = new Map();
  let probeCount = 0;
  let quotaRefreshCount = 0;
  let tokenRefreshCount = 0;
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const banned = {
    id: "banned-account",
    email: "banned@example.com",
    banned: true,
    tokens: { access_token: "live-token" },
  };
  const engine = {
    inspectAuthState: () => ({ status: "aligned", requiresResolution: false }),
    listAccts: () => [banned],
    loadAcct: () => banned,
    withAccountLock: async (_id, task) => task(),
    canProbeUsageWithoutRefresh: account => !!account.tokens?.access_token,
    async probeUsageOnly() {
      probeCount += 1;
      return { hourly_remaining_percentage: 10 };
    },
    async refreshQuota() {
      quotaRefreshCount += 1;
      return { hourly_remaining_percentage: 50 };
    },
    async refreshOneTok() {
      tokenRefreshCount += 1;
      return { ok: true };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });

  const quota = await handlers.get("quota:refresh")({}, banned.id, true);
  assert.equal(quota.success, true);
  assert.equal(probeCount, 1);
  assert.equal(quotaRefreshCount, 0);

  const token = await handlers.get("token:refresh")({}, banned.id);
  assert.equal(token.success, false);
  assert.match(token.error, /banned/i);
  assert.equal(tokenRefreshCount, 0);
});

test("quota IPC skips banned accounts that have no leftover access token", async () => {
  const handlers = new Map();
  let quotaRefreshCount = 0;
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const banned = {
    id: "banned-dead",
    email: "banned-dead@example.com",
    banned: true,
  };
  const engine = {
    inspectAuthState: () => ({ status: "aligned", requiresResolution: false }),
    listAccts: () => [banned],
    loadAcct: () => banned,
    withAccountLock: async (_id, task) => task(),
    canProbeUsageWithoutRefresh: () => false,
    async probeUsageOnly() {
      throw new Error("should not probe");
    },
    async refreshQuota() {
      quotaRefreshCount += 1;
      return { hourly_remaining_percentage: 50 };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });

  const quota = await handlers.get("quota:refresh")({}, banned.id, true);
  assert.equal(quota.success, false);
  assert.match(quota.error, /banned/i);
  assert.equal(quotaRefreshCount, 0);

  const allQuotas = await handlers.get("quota:refreshAll")({});
  assert.equal(allQuotas.success, true);
  assert.equal(allQuotas.data[0].skipped, true);
  assert.equal(allQuotas.data[0].reason, "account_banned");
  assert.equal(quotaRefreshCount, 0);
});

test("a missing Codex account file does not restore a leftover backup", async (t) => {
  const { engine } = freshEngine(t);
  const kept = await addAccount(engine, "acct-keep@example.com", "acct-keep", "keep");
  const gone = await addAccount(engine, "acct-gone@example.com", "acct-gone", "gone");
  kept.last_used += 1;
  gone.last_used += 1;
  engine.saveAcct(kept);
  engine.saveAcct(gone);
  const gonePath = engine.accountFilePath(gone.id);
  const keptPath = engine.accountFilePath(kept.id);
  assert.equal(fs.existsSync(`${gonePath}.bak`), true);
  fs.unlinkSync(gonePath);
  assert.equal(engine.loadAcct(gone.id), null);
  assert.equal(fs.existsSync(gonePath), false, "a leftover backup must not resurrect a deleted account file");

  fs.writeFileSync(`${keptPath}.bak`, fs.readFileSync(keptPath, "utf8"), "utf8");
  fs.writeFileSync(keptPath, "{broken", "utf8");
  assert.equal(engine.loadAcct(kept.id).email, "acct-keep@example.com");

  const index = engine.loadIdx();
  index.current_account_id = kept.id;
  engine.saveIdx(index);
  engine.writeAuthJson(kept);
  engine.writeProjection(kept, engine.writeAuthJson(kept));
  let running = false;
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: () => running ? [{ name: "Codex.exe", pid: 99 }] : [],
    gracefulClose: () => { running = false; return true; },
    forceClose: () => { running = false; return true; },
    launch: () => { running = true; },
    sleep() {},
  });
  await engine.doSwitch(engine.loadAcct(kept.id));
  assert.equal(engine.loadIdx().current_account_id, kept.id);
  assert.equal(engine.inspectAuthState({ migrateProjection: false }).status, "aligned");
});

test("storage restores valid backups and preserves DPAPI failures", async t => {
  const { engine, codec } = freshEngine(t);
  const account = await addAccount(engine, "alpha@example.com", "acct-alpha", "alpha");
  account.last_used += 1;
  engine.saveAcct(account);
  const config = require("../engine/config");
  const accountPath = path.join(config.ACCTS_DIR, `${account.id}.json`);

  fs.writeFileSync(accountPath, "{broken", "utf8");
  const restored = engine.loadAcct(account.id);
  assert.equal(restored.id, account.id);
  assert.equal(fs.existsSync(`${accountPath}.bak`), true);

  for (const indexPath of [config.IDX_PATH, `${config.IDX_PATH}.bak`]) {
    try { fs.unlinkSync(indexPath); } catch {}
  }
  const rebuilt = engine.loadIdx();
  assert.ok(rebuilt.accounts.some(item => item.id === account.id));

  engine.setSecretCodec({
    name: "broken-codec",
    encrypt: codec.encrypt,
    decrypt: () => { throw new Error("DPAPI unavailable"); },
  });
  const indexBeforeCredentialFailure = fs.readFileSync(config.IDX_PATH, "utf8");
  const protectedBeforeFailure = fs.readFileSync(accountPath, "utf8");
  fs.writeFileSync(`${accountPath}.bak`, JSON.stringify({
    ...account,
    tokens: tokens("backup@example.com", "acct-backup", "backup"),
  }), "utf8");
  assert.equal(engine.loadAcct(account.id), null);
  assert.equal(engine.listAccts().length, 0);
  assert.equal(fs.readFileSync(config.IDX_PATH, "utf8"), indexBeforeCredentialFailure);
  assert.equal(fs.existsSync(accountPath), true);
  assert.equal(fs.readFileSync(accountPath, "utf8"), protectedBeforeFailure);
  assert.ok(engine.getStorageDiagnostics().some(item => item.type === "account_credentials"));
  engine.setSecretCodec(codec);
});

test("a readable account with a corrupt token payload does not restore a stale backup", async (t) => {
  const { engine, codec } = freshEngine(t);
  const account = await addAccount(engine, "payload-keep@example.com", "acct-payload-keep", "payload-keep");
  const filePath = engine.accountFilePath(account.id);
  const primary = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const stale = JSON.parse(fs.readFileSync(filePath, "utf8"));
  stale.email = "payload-stale@example.com";
  stale.tokens_encrypted = codec.encrypt(JSON.stringify(tokens("payload-stale@example.com", "acct-payload-stale", "payload-stale")));
  fs.writeFileSync(`${filePath}.bak`, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
  primary.tokens_encrypted = codec.encrypt("{");
  fs.writeFileSync(filePath, `${JSON.stringify(primary, null, 2)}\n`, "utf8");
  assert.equal(engine.loadAcct(account.id), null);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).email, "payload-keep@example.com");
  assert.equal(JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8")).email, "payload-stale@example.com");
  assert.ok(engine.getStorageDiagnostics().some((item) => item.type === "account_credentials"));
});

test("account file access rejects unsafe ids and delete rolls back on index failure", async t => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "delete-one@example.com", "acct-delete-one", "delete-one");
  const second = await addAccount(engine, "delete-two@example.com", "acct-delete-two", "delete-two");
  const config = require("../engine/config");
  const firstPath = engine.accountFilePath(first.id);

  assert.throws(() => engine.loadAcct("..\\outside"), /Invalid account id/);
  assert.throws(() => engine.saveAcct({ ...first, id: "../outside" }), /Invalid account id/);

  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  assert.throws(() => engine.deleteAcct(first.id), /Switch to another account/);
  assert.equal(fs.existsSync(firstPath), true);
  assert.equal(engine.loadIdx().current_account_id, first.id);

  const secondPath = engine.accountFilePath(second.id);
  const originalRename = fs.renameSync;
  let blockedIndexWrite = false;
  fs.renameSync = (from, to) => {
    if (!blockedIndexWrite && path.resolve(to) === path.resolve(config.IDX_PATH)) {
      blockedIndexWrite = true;
      throw new Error("index write failed");
    }
    return originalRename(from, to);
  };
  t.after(() => { fs.renameSync = originalRename; });

  assert.throws(() => engine.deleteAcct(second.id), /index write failed/);
  assert.equal(fs.existsSync(secondPath), true);
  assert.ok(engine.loadIdx().accounts.some(item => item.id === second.id));
  assert.equal(engine.loadAcct(second.id).email, second.email);

  fs.renameSync = originalRename;
  assert.equal(engine.deleteAcct(second.id), true);
  assert.equal(fs.existsSync(secondPath), false);
  assert.equal(engine.loadIdx().accounts.some(item => item.id === second.id), false);
});

test("deleting a non-current account still works after a corrupt index", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "delete-corrupt-a@example.com", "acct-delete-corrupt-a", "delete-corrupt-a");
  const second = await addAccount(engine, "delete-corrupt-b@example.com", "acct-delete-corrupt-b", "delete-corrupt-b");
  first.last_used = 10;
  engine.saveAcct(first);
  second.last_used = 20;
  engine.saveAcct(second);
  assert.equal(engine.loadIdx().current_account_id, null);
  const config = require("../engine/config");
  try { fs.unlinkSync(`${config.IDX_PATH}.bak`); } catch {}
  fs.writeFileSync(config.IDX_PATH, "{ corrupted", "utf8");
  assert.equal(engine.deleteAcct(second.id), true);
  assert.equal(engine.loadAcct(second.id), null);
  assert.equal(engine.loadAcct(first.id).email, "delete-corrupt-a@example.com");
  assert.equal(engine.loadIdx().current_account_id, null);
  assert.equal(engine.currentAcct(), null);
});

test("deleting an account retries when the account file is transiently locked", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "delete-keep@example.com", "acct-delete-keep", "delete-keep");
  const spare = await addAccount(engine, "delete-lock@example.com", "acct-delete-lock", "delete-lock");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const sparePath = engine.accountFilePath(spare.id);
  const originalUnlink = fs.unlinkSync;
  let failures = 0;
  fs.unlinkSync = (target) => {
    if (path.resolve(String(target)) === path.resolve(sparePath) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalUnlink(target);
  };
  t.after(() => { fs.unlinkSync = originalUnlink; });

  assert.equal(engine.deleteAcct(spare.id), true);
  assert.equal(failures, 2);
  assert.equal(fs.existsSync(sparePath), false);
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(engine.loadAcct(current.id).email, "delete-keep@example.com");
});

test("auth state detects drift, migrates legacy projections, and adopts official login", async t => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "first@example.com", "acct-first", "first");
  const second = await addAccount(engine, "second@example.com", "acct-second", "second");
  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  const firstAuth = engine.writeAuthJson(first);
  engine.writeProjection(first, firstAuth);
  assert.equal(engine.inspectAuthState().status, "aligned");

  const config = require("../engine/config");
  const secondAuth = require("../engine/switch").buildAuthJson(second);
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(secondAuth), "utf8");
  const conflict = engine.inspectAuthState();
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.matchedAccountId, second.id);
  engine.inspectAuthState();
  const logPath = path.join(config.DATA_DIR, "logs", `app-${new Date().toISOString().slice(0, 10)}.log`);
  const conflictWarnings = () => fs.readFileSync(logPath, "utf8")
    .split("\n")
    .filter(line => line.includes("Official Codex authentication differs from the managed current account"));
  assert.equal(conflictWarnings().length, 1);

  const adopted = await engine.adoptOfficialAuth();
  assert.equal(adopted.account.id, second.id);
  assert.equal(adopted.updated, true);
  assert.equal(engine.loadAcct(second.id).updated, undefined);
  assert.equal(engine.loadIdx().current_account_id, second.id);
  assert.equal(engine.inspectAuthState().status, "aligned");

  const nextIndex = engine.loadIdx();
  nextIndex.current_account_id = first.id;
  engine.saveIdx(nextIndex);
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(firstAuth), "utf8");
  fs.writeFileSync(path.join(config.CODEX_DIR, "codex_auth_projection.json"), JSON.stringify({
    version: 1,
    account_id: first.id,
  }), "utf8");
  assert.equal(engine.inspectAuthState().status, "aligned");
  const migrated = JSON.parse(fs.readFileSync(path.join(config.CODEX_DIR, "codex_auth_projection.json"), "utf8"));
  assert.ok(migrated.auth_fingerprint);
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(secondAuth), "utf8");
  assert.equal(engine.inspectAuthState().status, "conflict");
  assert.equal(conflictWarnings().length, 2);
});

test("identity-only aligned inspect does not authorize pushing vault tokens to official auth", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "mirror-rotate@example.com", "acct-mirror-rotate", "mirror-rotate");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const originalAuth = engine.writeAuthJson(account);
  engine.writeProjection(account, originalAuth);
  const aligned = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(aligned.status, "aligned");
  assert.equal(aligned.safeToMirrorOfficial, true);
  assert.equal(engine.canMirrorOfficialAuth(aligned), true);

  const rotatedTokens = tokens("mirror-rotate@example.com", "acct-mirror-rotate", "mirror-rotate-official");
  const rotatedAuth = {
    ...originalAuth,
    tokens: {
      ...rotatedTokens,
      account_id: "acct-mirror-rotate",
    },
  };
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify(rotatedAuth), "utf8");
  const rotated = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(rotated.status, "aligned");
  assert.equal(rotated.safeToMirrorOfficial, false);
  assert.equal(engine.canMirrorOfficialAuth(rotated), false);
  assert.equal(engine.loadAcct(account.id).tokens.access_token, account.tokens.access_token);
});

test("the daemon does not overwrite an official Codex token rotation", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-rotate@example.com", "acct-daemon-rotate", "daemon-rotate");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const originalAuth = engine.writeAuthJson(account);
  engine.writeProjection(account, originalAuth);
  const rotatedTokens = tokens("daemon-rotate@example.com", "acct-daemon-rotate", "daemon-rotate-official");
  const rotatedAuth = {
    ...originalAuth,
    tokens: {
      ...rotatedTokens,
      account_id: "acct-daemon-rotate",
    },
  };
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify(rotatedAuth), "utf8");

  const quotaModule = require("../engine/quota");
  const originalFetch = quotaModule.fetchQuotaWithTokenRepair;
  quotaModule.fetchQuotaWithTokenRepair = async () => ({
    hourly_remaining_percentage: null,
    hourly_window_present: false,
    weekly_remaining_percentage: 70,
    weekly_window_present: true,
  });
  t.after(() => { quotaModule.fetchQuotaWithTokenRepair = originalFetch; });

  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.access_token, rotatedTokens.access_token);
  assert.equal(engine.loadAcct(account.id).tokens.access_token, account.tokens.access_token);
});

test("the daemon leaves official auth.json alone when the vault already holds the same tokens", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-quiet@example.com", "acct-daemon-quiet", "daemon-quiet");
  account.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  account.usage_updated_at = engine.ts();
  engine.saveAcct(account);
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const before = fs.readFileSync(authPath, "utf8");
  const beforeStat = fs.statSync(authPath);
  const quotaModule = require("../engine/quota");
  const originalFetch = quotaModule.fetchQuotaWithTokenRepair;
  quotaModule.fetchQuotaWithTokenRepair = async () => ({
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: null,
    weekly_window_present: false,
  });
  t.after(() => { quotaModule.fetchQuotaWithTokenRepair = originalFetch; });
  await new Promise((resolve) => setTimeout(resolve, 15));

  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.length, 0);
  assert.equal(fs.readFileSync(authPath, "utf8"), before, "no rewrite when nothing changed");
  assert.equal(fs.statSync(authPath).mtimeMs, beforeStat.mtimeMs);
});

test("the daemon still mirrors vault tokens that official Codex does not have yet", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-mirror@example.com", "acct-daemon-mirror", "daemon-mirror");
  account.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  account.usage_updated_at = engine.ts();
  engine.saveAcct(account);
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);

  // A refresh that never reached official auth.json: the vault moves on while
  // the projection still matches what official holds.
  const rotated = tokens("daemon-mirror@example.com", "acct-daemon-mirror", "daemon-mirror-new");
  const stored = engine.loadAcct(account.id);
  stored.tokens = { ...rotated, account_id: "acct-daemon-mirror" };
  stored.token_generation = Number(stored.token_generation || 0) + 1;
  engine.saveAcct(stored);

  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const quotaModule = require("../engine/quota");
  const originalFetch = quotaModule.fetchQuotaWithTokenRepair;
  quotaModule.fetchQuotaWithTokenRepair = async () => ({
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: null,
    weekly_window_present: false,
  });
  t.after(() => { quotaModule.fetchQuotaWithTokenRepair = originalFetch; });
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.access_token, rotated.access_token);
  const after = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(after.status, "aligned");
  assert.equal(after.vaultMatchesOfficial, true);
  assert.equal(after.projectionMatchesOfficial, true);
});

test("token refresh still mirrors official auth when the projection matches", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "refresh-mirror@example.com", "acct-refresh-mirror", "refresh-mirror");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const originalAuth = engine.writeAuthJson(account);
  engine.writeProjection(account, originalAuth);
  const refreshed = tokens("refresh-mirror@example.com", "acct-refresh-mirror", "refresh-mirror-new");
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const result = await engine.refreshOneTok(account, {
    force: true,
    httpJson: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        id_token: refreshed.id_token,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
      }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.access_token, refreshed.access_token);
});

test("token refresh keeps a successful result when official auth.json is locked", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "refresh-lock@example.com", "acct-refresh-lock", "refresh-lock");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const originalAuth = engine.writeAuthJson(account);
  engine.writeProjection(account, originalAuth);
  const authState = require("../engine/auth-state");
  const originalInspect = authState.inspectAuthState;
  authState.inspectAuthState = () => {
    const error = new Error("EPERM: operation not permitted");
    error.code = "EPERM";
    error.transientIoError = true;
    throw error;
  };
  t.after(() => { authState.inspectAuthState = originalInspect; });
  const refreshed = tokens("refresh-lock@example.com", "acct-refresh-lock", "refresh-lock-new");
  const result = await engine.refreshOneTok(account, {
    force: true,
    httpJson: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        id_token: refreshed.id_token,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
      }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(engine.loadAcct(account.id).tokens.access_token, refreshed.access_token);
  const authPath = path.join(require("../engine/config").CODEX_DIR, "auth.json");
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.access_token, originalAuth.tokens.access_token);
});

test("token refresh does not overwrite an official Codex token rotation", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "refresh-rotate@example.com", "acct-refresh-rotate", "refresh-rotate");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const originalAuth = engine.writeAuthJson(account);
  engine.writeProjection(account, originalAuth);
  const rotatedTokens = tokens("refresh-rotate@example.com", "acct-refresh-rotate", "refresh-rotate-official");
  const rotatedAuth = {
    ...originalAuth,
    tokens: {
      ...rotatedTokens,
      account_id: "acct-refresh-rotate",
    },
  };
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify(rotatedAuth), "utf8");
  const refreshed = tokens("refresh-rotate@example.com", "acct-refresh-rotate", "refresh-rotate-vault");
  const result = await engine.refreshOneTok(account, {
    force: true,
    httpJson: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        id_token: refreshed.id_token,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
      }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.access_token, rotatedTokens.access_token);
  assert.equal(engine.loadAcct(account.id).tokens.access_token, refreshed.access_token);
});

test("auth state accepts and synchronizes token rotation for the same official identity", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "same@example.com", "acct-same", "first-token");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const originalAuth = engine.writeAuthJson(account);
  engine.writeProjection(account, originalAuth);

  const rotatedTokens = tokens("same@example.com", "acct-same", "rotated-token");
  const rotatedAuth = {
    ...originalAuth,
    tokens: {
      ...rotatedTokens,
      account_id: "acct-same",
    },
  };
  const config = require("../engine/config");
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(rotatedAuth), "utf8");

  const state = engine.inspectAuthState();
  const synchronized = engine.loadAcct(account.id);
  assert.equal(state.status, "aligned");
  assert.equal(state.requiresResolution, false);
  assert.equal(synchronized.tokens.access_token, rotatedTokens.access_token);
  assert.equal(engine.inspectAuthState().status, "aligned");
});

test("inspect does not pull older official tokens over a fresher vault", async t => {
  const { engine } = freshEngine(t);
  const now = Math.floor(Date.now() / 1000);
  const account = await addAccount(engine, "fresh-vault@example.com", "acct-fresh-vault", "fresh-vault");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const originalAuth = engine.writeAuthJson(account);
  engine.writeProjection(account, originalAuth);
  const vaultClaims = {
    email: "fresh-vault@example.com",
    exp: now + 7200,
    "https://api.openai.com/auth": {
      account_id: "acct-fresh-vault",
      user_id: "user-fresh-vault",
      chatgpt_plan_type: "plus",
      organizations: [],
    },
  };
  account.tokens = {
    id_token: jwt(vaultClaims),
    access_token: jwt(vaultClaims),
    refresh_token: "refresh-fresh-vault-new",
  };
  engine.saveAcct(account);
  const staleOfficial = tokens("fresh-vault@example.com", "acct-fresh-vault", "fresh-vault-old");
  const config = require("../engine/config");
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify({
    ...originalAuth,
    tokens: {
      ...staleOfficial,
      account_id: "acct-fresh-vault",
    },
  }), "utf8");
  const state = engine.inspectAuthState();
  const loaded = engine.loadAcct(account.id);
  assert.equal(state.status, "aligned");
  assert.equal(loaded.tokens.access_token, account.tokens.access_token);
  assert.equal(loaded.tokens.refresh_token, "refresh-fresh-vault-new");
});

test("switching the current Codex account does not revert a fresher vault token", async t => {
  const { engine } = freshEngine(t);
  const now = Math.floor(Date.now() / 1000);
  const account = await addAccount(engine, "switch-fresh@example.com", "acct-switch-fresh", "switch-fresh");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const originalAuth = engine.writeAuthJson(account);
  engine.writeProjection(account, originalAuth);
  const vaultClaims = {
    email: "switch-fresh@example.com",
    exp: now + 7200,
    "https://api.openai.com/auth": {
      account_id: "acct-switch-fresh",
      user_id: "user-switch-fresh",
      chatgpt_plan_type: "plus",
      organizations: [],
    },
  };
  account.tokens = {
    id_token: jwt(vaultClaims),
    access_token: jwt(vaultClaims),
    refresh_token: "refresh-switch-fresh-new",
  };
  engine.saveAcct(account);
  const staleOfficial = tokens("switch-fresh@example.com", "acct-switch-fresh", "switch-fresh-old");
  const config = require("../engine/config");
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify({
    ...originalAuth,
    tokens: {
      ...staleOfficial,
      account_id: "acct-switch-fresh",
    },
  }), "utf8");
  const skipped = await engine.doSwitch(engine.loadAcct(account.id));
  assert.equal(skipped.already, true);
  const loaded = engine.loadAcct(account.id);
  assert.equal(loaded.tokens.refresh_token, "refresh-switch-fresh-new");
  assert.equal(loaded.tokens.access_token, account.tokens.access_token);
});

test("token refresh rechecks official auth before writing refreshed credentials", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "race-current@example.com", "acct-race-current", "race-current");
  const external = await addAccount(engine, "race-external@example.com", "acct-race-external", "race-external");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const originalAuth = engine.writeAuthJson(current);
  engine.writeProjection(current, originalAuth);
  assert.equal(engine.inspectAuthState().status, "aligned");

  const config = require("../engine/config");
  const { buildAuthJson } = require("../engine/switch");
  const { refreshOneTok } = require("../engine/token-refresh");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const projectionPath = path.join(config.CODEX_DIR, "codex_auth_projection.json");
  const externalAuth = buildAuthJson(external);
  const refreshed = tokens("race-current@example.com", "acct-race-current", "race-current-refreshed");

  const result = await refreshOneTok(current, {
    force: true,
    httpJson: async () => {
      fs.writeFileSync(authPath, JSON.stringify(externalAuth), "utf8");
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          id_token: refreshed.id_token,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(engine.loadAcct(current.id).tokens.access_token, refreshed.access_token);
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.access_token, external.tokens.access_token);
  assert.equal(JSON.parse(fs.readFileSync(projectionPath, "utf8")).auth_fingerprint, engine.authFingerprint(originalAuth));
  const conflict = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.matchedAccountId, external.id);
});

test("token refresh skips revoked accounts until reauthorization", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "revoked-token@example.com", "acct-revoked-token", "revoked-token");
  account.requires_reauth = true;
  account.reauth_reason = "refresh_token needs re-authorization";
  account.quota_error = {
    code: "refresh_token_invalidated",
    message: "Account requires reauthorization before tokens can be refreshed.",
    timestamp: engine.ts(),
  };
  engine.saveAcct(account);

  let refreshCalled = false;
  const { refreshOneTok } = require("../engine/token-refresh");
  const result = await refreshOneTok(account, {
    force: true,
    httpJson: async () => {
      refreshCalled = true;
      throw new Error("refresh endpoint should not be called");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reauthRequired, true);
  assert.equal(result.code, "refresh_token_invalidated");
  assert.equal(refreshCalled, false);
  assert.equal(engine.loadAcct(account.id).quota_error.code, "refresh_token_invalidated");
});

test("auto-switch does not leave the current account after a 429 rate_limit miss", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "as-429-cur@example.com", "acct-as-429-cur", "as-429-cur");
  const other = await addAccount(engine, "as-429-other@example.com", "acct-as-429-other", "as-429-other");
  current.quota = {
    weekly_remaining_percentage: 81,
    weekly_window_present: true,
    hourly_window_present: false,
  };
  current.usage_updated_at = engine.ts();
  engine.saveAcct(current);
  other.quota = {
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
    hourly_window_present: false,
  };
  other.usage_updated_at = engine.ts();
  engine.saveAcct(other);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const httpClient = require("../engine/http-client");
  httpClient.setHttpJsonTransport(async () => ({
    status: 429,
    headers: { "retry-after": "45" },
    body: JSON.stringify({ detail: { code: "rate_limit" } }),
  }));
  t.after(() => httpClient.setHttpJsonTransport(null));
  await assert.rejects(
    () => engine.refreshQuota(engine.loadAcct(current.id), { force: true }),
    /429|rate.?limit/,
  );
  assert.equal(engine.loadAcct(current.id).probe?.status, "probe_failed");
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "quota_sufficient");
  assert.equal(engine.loadIdx().current_account_id, current.id);
});

test("auto-switch refuses to use stale quota after current refresh failure", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "current@example.com", "acct-current", "current");
  account.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  engine.saveAcct(account);
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);

  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => { throw new Error("network unavailable"); };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "current_quota_refresh_failed");
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, account.id);
});

test("auto-switch reuses a provided auth state instead of inspecting again", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "reuse-auth@example.com", "acct-reuse-auth", "reuse-auth");
  account.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  account.usage_updated_at = engine.ts();
  engine.saveAcct(account);
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);
  const authState = require("../engine/auth-state");
  const originalInspect = authState.inspectAuthState;
  let inspects = 0;
  authState.inspectAuthState = (...args) => {
    inspects += 1;
    return originalInspect(...args);
  };
  t.after(() => { authState.inspectAuthState = originalInspect; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  }, {
    authState: { status: "aligned", requiresResolution: false },
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "quota_sufficient");
  assert.equal(inspects, 0);
  assert.equal(result.authState.status, "aligned");
});

test("auto-switch does not leave when current quota is exactly the threshold", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "exact-th@example.com", "acct-exact-th", "exact-th");
  const candidate = await addAccount(engine, "exact-th-ready@example.com", "acct-exact-th-ready", "exact-th-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 20,
    hourly_window_present: true,
    weekly_remaining_percentage: 30,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account, authState: { status: "aligned", currentAccountId: account.id } };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "quota_sufficient");
  assert.equal(switchedTo, null);
  assert.equal(engine.loadIdx().current_account_id, current.id);
});

test("auto-switch still leaves when current quota is below the threshold", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "below-th@example.com", "acct-below-th", "below-th");
  const candidate = await addAccount(engine, "below-th-ready@example.com", "acct-below-th-ready", "below-th-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 19,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account, authState: { status: "aligned", currentAccountId: account.id } };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, true);
  assert.equal(switchedTo, candidate.id);
});

test("auto-switch rechecks official auth before writing a switch", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "stale-auth-current@example.com", "acct-stale-auth-current", "stale-auth-current");
  const candidate = await addAccount(engine, "stale-auth-ready@example.com", "acct-stale-auth-ready", "stale-auth-ready");
  const outsider = await addAccount(engine, "stale-auth-out@example.com", "acct-stale-auth-out", "stale-auth-out");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const outsiderAuth = engine.writeAuthJson(outsider);
  engine.writeProjection(outsider, outsiderAuth);
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  }, {
    authState: { status: "aligned", requiresResolution: false, currentAccountId: current.id },
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "auth_conflict");
  assert.equal(switchedTo, null);
  assert.equal(result.authState.status, "conflict");
  const official = JSON.parse(fs.readFileSync(path.join(require("../engine/config").CODEX_DIR, "auth.json"), "utf8"));
  assert.equal(official.tokens.access_token, outsider.tokens.access_token);
});

test("auto-switch recheck treats a vanished official login as missing, not a write", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "recheck-missing-cur@example.com", "acct-recheck-missing-cur", "recheck-missing-cur");
  const candidate = await addAccount(engine, "recheck-missing-ready@example.com", "acct-recheck-missing-ready", "recheck-missing-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  }, {
    authState: { status: "aligned", requiresResolution: false, currentAccountId: current.id },
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "missing_official_auth");
  assert.equal(result.authState.status, "missing_official_auth");
  assert.equal(switchedTo, null);
});

test("auto-switch does not write when the current account changes before the lock", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "changed-cur@example.com", "acct-changed-cur", "changed-cur");
  const candidate = await addAccount(engine, "changed-ready@example.com", "acct-changed-ready", "changed-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const storage = require("../engine/storage");
  const originalLoadIdx = storage.loadIdx;
  let loads = 0;
  storage.loadIdx = () => {
    loads += 1;
    const latest = originalLoadIdx();
    if (loads > 1) return { ...latest, current_account_id: candidate.id };
    return latest;
  };
  t.after(() => { storage.loadIdx = originalLoadIdx; });
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  }, {
    authState: { status: "aligned", requiresResolution: false, currentAccountId: current.id, message: "stale-pre-lock" },
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "current_changed");
  assert.equal(switchedTo, null);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, current.id);
  assert.notEqual(result.authState.message, "stale-pre-lock");
});

test("auto-switch current-changed does not invent a conflict when auth.json is locked", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "changed-lock@example.com", "acct-changed-lock", "changed-lock");
  const candidate = await addAccount(engine, "changed-lock-ready@example.com", "acct-changed-lock-ready", "changed-lock-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const storage = require("../engine/storage");
  const originalLoadIdx = storage.loadIdx;
  let loads = 0;
  storage.loadIdx = () => {
    loads += 1;
    const latest = originalLoadIdx();
    if (loads > 1) return { ...latest, current_account_id: candidate.id };
    return latest;
  };
  const authState = require("../engine/auth-state");
  const originalInspect = authState.inspectAuthState;
  authState.inspectAuthState = () => {
    const error = new Error("EPERM: operation not permitted");
    error.code = "EPERM";
    error.transientIoError = true;
    throw error;
  };
  t.after(() => {
    storage.loadIdx = originalLoadIdx;
    authState.inspectAuthState = originalInspect;
  });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  }, {
    authState: { status: "aligned", requiresResolution: false, currentAccountId: current.id },
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "current_changed");
  assert.equal(result.authState.status, "unknown");
  assert.equal(result.authState.requiresResolution, false);
  assert.notEqual(result.authState.status, "conflict");
});

test("auto-switch names a missing official login separately from a conflict", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "missing-official-cur@example.com", "acct-missing-official-cur", "missing-official-cur");
  const candidate = await addAccount(engine, "missing-official-ready@example.com", "acct-missing-official-ready", "missing-official-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "missing_official_auth");
  assert.equal(result.authState.status, "missing_official_auth");
  assert.equal(switchedTo, null);
});

test("auto-switch names an unmanaged official login separately from a conflict", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "unmanaged-cur@example.com", "acct-unmanaged-cur", "unmanaged-cur");
  const candidate = await addAccount(engine, "unmanaged-ready@example.com", "acct-unmanaged-ready", "unmanaged-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  }, {
    authState: { status: "unmanaged_official_auth", requiresResolution: true },
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "unmanaged_official_auth");
  assert.equal(switchedTo, null);
});

test("auto-switch keeps cached quota when refresh is only waiting to retry", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "retry-current@example.com", "acct-retry-current", "retry-current");
  const now = engine.ts();
  account.quota = {
    hourly_window_present: false,
    weekly_remaining_percentage: 93,
    weekly_window_present: true,
  };
  account.quota_error = { code: "quota_retry_pending", message: "Quota refresh is waiting for retry until 1" };
  account.usage_updated_at = now - 1200;
  engine.saveAcct(account);
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);

  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => {
    const error = new Error("Quota refresh is waiting for retry until 1");
    error.code = "quota_retry_pending";
    throw error;
  };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "quota_sufficient");

  engine.saveAutoSwitchCfg({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const worker = await engine.runDaemonWorker();
  assert.ok(!worker.failures.some((item) => /waiting for retry|quota_retry_pending/i.test(item.message || "")));
});

test("auto-switch cancellation prevents switching after a daemon stop", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "cancel-current@example.com", "acct-cancel-current", "cancel-current");
  const candidate = await addAccount(engine, "cancel-candidate@example.com", "acct-cancel-candidate", "cancel-candidate");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  // Stale on purpose: the tick must go through the refresh path so the
  // cancellation signal below can fire.
  current.usage_updated_at = now - 1200;
  candidate.quota = {
    hourly_remaining_percentage: 100,
    hourly_window_present: true,
    weekly_remaining_percentage: 100,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let refreshedCurrent = false;
  let switched = false;
  quotaModule.refreshQuota = async acct => {
    if (acct.id === current.id) refreshedCurrent = true;
  };
  switchModule.doSwitch = async () => {
    switched = true;
    throw new Error("switch should have been cancelled");
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  }, {
    isCancelled: () => refreshedCurrent,
  });

  assert.equal(result.switched, false);
  assert.equal(result.reason, "cancelled");
  assert.equal(switched, false);
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, current.id);
});

test("auto-switch revalidates failed candidates and excludes accounts requiring reauthorization", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "candidate-current@example.com", "acct-candidate-current", "candidate-current");
  const candidate = await addAccount(engine, "candidate-ready@example.com", "acct-candidate-ready", "candidate-ready");
  const revoked = await addAccount(engine, "candidate-revoked@example.com", "acct-candidate-revoked", "candidate-revoked");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  candidate.quota_error = { code: "network_error", message: "previous refresh failed", timestamp: now };
  revoked.quota = {
    hourly_remaining_percentage: 100,
    hourly_window_present: true,
    weekly_remaining_percentage: 100,
    weekly_window_present: true,
  };
  revoked.usage_updated_at = now;
  revoked.requires_reauth = true;
  revoked.reauth_reason = "refresh token revoked";
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  engine.saveAcct(revoked);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let candidateRefreshed = false;
  let switchedTo = null;
  quotaModule.refreshQuota = async account => {
    if (account.id === candidate.id) {
      candidateRefreshed = true;
      account.quota_error = null;
      account.usage_updated_at = engine.ts();
      engine.saveAcct(account);
    }
    return account.quota;
  };
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });

  assert.equal(candidateRefreshed, true);
  assert.equal(result.switched, true);
  assert.equal(switchedTo, candidate.id);
  assert.notEqual(switchedTo, revoked.id);
});

test("auto-switch treats a banned current account as must-leave and skips banned candidates", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "banned-current@example.com", "acct-banned-current", "banned-current");
  const candidate = await addAccount(engine, "banned-ready@example.com", "acct-banned-ready", "banned-ready");
  const bannedCandidate = await addAccount(engine, "banned-other@example.com", "acct-banned-other", "banned-other");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  current.banned = true;
  current.probe = { status: "banned", error_code: "account_deactivated", http_status: 401, checked_at: now };
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  bannedCandidate.quota = {
    hourly_remaining_percentage: 100,
    hourly_window_present: true,
    weekly_remaining_percentage: 100,
    weekly_window_present: true,
  };
  bannedCandidate.usage_updated_at = now;
  bannedCandidate.banned = true;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  engine.saveAcct(bannedCandidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let refreshedIds = [];
  let switchedTo = null;
  quotaModule.refreshQuota = async account => {
    refreshedIds.push(account.id);
    return account.quota;
  };
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });

  assert.equal(result.switched, true);
  assert.equal(switchedTo, candidate.id);
  assert.ok(!refreshedIds.includes(current.id));
  assert.ok(!refreshedIds.includes(bannedCandidate.id));
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.ok(decrypts.count < 6);
});

test("auto-switch treats a reauth current account as must-leave", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "reauth-current-switch@example.com", "acct-reauth-current-switch", "reauth-current-switch");
  const candidate = await addAccount(engine, "reauth-ready@example.com", "acct-reauth-ready", "reauth-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  current.requires_reauth = true;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let refreshedIds = [];
  let switchedTo = null;
  quotaModule.refreshQuota = async account => {
    refreshedIds.push(account.id);
    return account.quota;
  };
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });

  assert.equal(result.switched, true);
  assert.equal(switchedTo, candidate.id);
  assert.ok(!refreshedIds.includes(current.id));
});

test("auto-switch does not immediately undo a just-completed official switch", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "recent-switch-cur@example.com", "acct-recent-switch-cur", "recent-switch-cur");
  const candidate = await addAccount(engine, "recent-switch-ready@example.com", "acct-recent-switch-ready", "recent-switch-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  engine.noteOfficialSwitch();
  const blocked = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(blocked.switched, false);
  assert.equal(blocked.reason, "recently_switched");
  assert.equal(switchedTo, null);
  assert.equal(blocked.authState.status, "aligned");
  assert.equal(blocked.authState.currentAccountId, current.id);
});

test("auto-switch does not write while Codex OAuth is pending", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "oauth-pend-cur@example.com", "acct-oauth-pend-cur", "oauth-pend-cur");
  const candidate = await addAccount(engine, "oauth-pend-ready@example.com", "acct-oauth-pend-ready", "oauth-pend-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const oauth = require("../engine/oauth");
  const originalStatus = oauth.getOAuthStatus;
  oauth.getOAuthStatus = () => ({ pending: true });
  t.after(() => { oauth.getOAuthStatus = originalStatus; });
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "oauth_pending");
  assert.equal(switchedTo, null);
});

test("auto-switch recheck does not write if OAuth starts after the first look", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "oauth-race-cur@example.com", "acct-oauth-race-cur", "oauth-race-cur");
  const candidate = await addAccount(engine, "oauth-race-ready@example.com", "acct-oauth-race-ready", "oauth-race-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const oauth = require("../engine/oauth");
  const originalStatus = oauth.getOAuthStatus;
  let looks = 0;
  oauth.getOAuthStatus = () => {
    looks += 1;
    return { pending: looks > 1 };
  };
  t.after(() => { oauth.getOAuthStatus = originalStatus; });
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  }, {
    authState: { status: "aligned", requiresResolution: false, currentAccountId: current.id },
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "oauth_pending");
  assert.equal(switchedTo, null);
  assert.ok(looks >= 2);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, current.id);
});

test("auto-switch reports a verify failure instead of throwing", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "verify-fail-cur@example.com", "acct-verify-fail-cur", "verify-fail-cur");
  const candidate = await addAccount(engine, "verify-fail-ready@example.com", "acct-verify-fail-ready", "verify-fail-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  switchModule.doSwitch = async () => {
    const error = new Error("Codex 官方登录写入后核对失败，没有切到目标账号");
    error.code = "codex_switch_verify_failed";
    throw error;
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "switch_verify_failed");
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, current.id);
});

test("auto-switch treats a usage-limited current account as must-leave", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "limited-current-switch@example.com", "acct-limited-current-switch", "limited-current-switch");
  const candidate = await addAccount(engine, "limited-ready@example.com", "acct-limited-ready", "limited-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  current.probe = {
    status: "usage_limited",
    error_code: "usage_limit_reached",
    http_status: 429,
    checked_at: now,
  };
  candidate.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let refreshedIds = [];
  let switchedTo = null;
  quotaModule.refreshQuota = async account => {
    refreshedIds.push(account.id);
    return account.quota;
  };
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account, authState: { status: "aligned", currentAccountId: account.id } };
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });

  assert.equal(result.switched, true);
  assert.equal(switchedTo, candidate.id);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, candidate.id);
  assert.ok(!refreshedIds.includes(current.id));
});

test("auto-switch excludes usage-limited candidates even when cached quota is high", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "limited-cand-current@example.com", "acct-limited-cand-current", "limited-cand-current");
  const limited = await addAccount(engine, "limited-cand@example.com", "acct-limited-cand", "limited-cand");
  const ready = await addAccount(engine, "limited-cand-ready@example.com", "acct-limited-cand-ready", "limited-cand-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  limited.quota = {
    hourly_remaining_percentage: 99,
    hourly_window_present: true,
    weekly_remaining_percentage: 99,
    weekly_window_present: true,
  };
  limited.usage_updated_at = now;
  limited.probe = {
    status: "usage_limited",
    error_code: "usage_limit_reached",
    http_status: 429,
    checked_at: now,
  };
  ready.quota = {
    hourly_remaining_percentage: 70,
    hourly_window_present: true,
    weekly_remaining_percentage: 70,
    weekly_window_present: true,
  };
  ready.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(limited);
  engine.saveAcct(ready);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  quotaModule.refreshQuota = async account => account.quota;
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });

  assert.equal(result.switched, true);
  assert.equal(switchedTo, ready.id);
});

test("auto-switch skips candidates that have no access token", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "empty-tok-cur@example.com", "acct-empty-tok-cur", "empty-tok-cur");
  const empty = await addAccount(engine, "empty-tok-cand@example.com", "acct-empty-tok-cand", "empty-tok-cand");
  const ready = await addAccount(engine, "empty-tok-ready@example.com", "acct-empty-tok-ready", "empty-tok-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  empty.tokens.access_token = "";
  empty.quota = {
    hourly_remaining_percentage: 99,
    hourly_window_present: true,
    weekly_remaining_percentage: 99,
    weekly_window_present: true,
  };
  empty.usage_updated_at = now;
  ready.quota = {
    hourly_remaining_percentage: 70,
    hourly_window_present: true,
    weekly_remaining_percentage: 70,
    weekly_window_present: true,
  };
  ready.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(empty);
  engine.saveAcct(ready);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  assert.equal(engine.listAccts({ secrets: false }).find((item) => item.id === empty.id).has_access, false);

  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  quotaModule.refreshQuota = async account => account.quota;
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account, authState: { status: "aligned", currentAccountId: account.id } };
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });

  assert.equal(result.switched, true);
  assert.equal(switchedTo, ready.id);
  assert.equal(result.authState.status, "aligned");
});

test("auto-switch does not throw when the only candidate has no access token", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "empty-only-cur@example.com", "acct-empty-only-cur", "empty-only-cur");
  const empty = await addAccount(engine, "empty-only-cand@example.com", "acct-empty-only-cand", "empty-only-cand");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  empty.tokens.access_token = "";
  empty.quota = {
    hourly_remaining_percentage: 99,
    hourly_window_present: true,
    weekly_remaining_percentage: 99,
    weekly_window_present: true,
  };
  empty.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(empty);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  quotaModule.refreshQuota = async account => account.quota;
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });

  assert.equal(result.switched, false);
  assert.equal(result.reason, "no_candidates");
  assert.equal(switchedTo, null);
});

test("auto-switch leaves a current account that has no access token", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "empty-cur-leave@example.com", "acct-empty-cur-leave", "empty-cur-leave");
  const ready = await addAccount(engine, "empty-cur-ready@example.com", "acct-empty-cur-ready", "empty-cur-ready");
  const now = engine.ts();
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  current.tokens.access_token = "";
  current.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  ready.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  ready.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(ready);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  assert.equal(engine.listAccts({ secrets: false }).find((item) => item.id === current.id).has_access, false);

  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  quotaModule.refreshQuota = async account => account.quota;
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account, authState: { status: "aligned", currentAccountId: account.id } };
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });

  assert.equal(result.switched, true);
  assert.equal(switchedTo, ready.id);
});

test("auto-switch still accepts listed candidates that omit has_access", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "omit-access-cur@example.com", "acct-omit-access-cur", "omit-access-cur");
  const ready = await addAccount(engine, "omit-access-ready@example.com", "acct-omit-access-ready", "omit-access-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  ready.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  ready.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(ready);
  const filePath = engine.accountFilePath(ready.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.has_access;
  if (raw.token_exp == null) raw.token_exp = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const listed = engine.listAccts({ secrets: false }).find((item) => item.id === ready.id);
  assert.equal(listed.has_access, undefined);
  assert.equal(listed.tokens, null);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  quotaModule.refreshQuota = async account => account.quota;
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account, authState: { status: "aligned", currentAccountId: account.id } };
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });

  assert.equal(result.switched, true);
  assert.equal(switchedTo, ready.id);
});

test("the daemon does not treat leftover usage limits as worker failures", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-limited@example.com", "acct-daemon-limited", "daemon-limited");
  account.requires_reauth = true;
  account.quota_error = { code: "refresh_token_invalidated", message: "keep me", timestamp: engine.ts() };
  engine.saveAcct(account);
  const quotaModule = require("../engine/quota");
  const originalFetch = quotaModule.fetchQuota;
  quotaModule.fetchQuota = async () => {
    const error = new Error("HTTP 429 usage_limit_reached");
    error.code = "usage_limit_reached";
    error.probe = {
      status: "usage_limited",
      error_code: "usage_limit_reached",
      http_status: 429,
      message: "额度已达上限或触发限流。",
      ok: false,
    };
    throw error;
  };
  t.after(() => {
    quotaModule.fetchQuota = originalFetch;
  });

  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.filter((item) => item.stage === "ban_probe").length, 0);
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.probe.status, "usage_limited");
  assert.equal(persisted.requires_reauth, true);
});

test("auto-switch reports but does not switch when the global switch is off", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "disabled-current@example.com", "acct-disabled-current", "disabled-current");
  const candidate = await addAccount(engine, "disabled-candidate@example.com", "acct-disabled-candidate", "disabled-candidate");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => {
    switchModule.doSwitch = originalSwitch;
  });

  const result = await engine.autoSwitchTick({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });

  assert.equal(result.switched, false);
  assert.equal(result.reason, "disabled");
  assert.equal(switchedTo, null);
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, current.id);
});

test("daemon still refreshes spare tokens when official auth.json is missing", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-missing-cur@example.com", "acct-daemon-missing-cur", "daemon-missing-cur");
  const spare = await addAccount(engine, "daemon-missing-spare@example.com", "acct-daemon-missing-spare", "daemon-missing-spare");
  spare.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(spare);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const tokenModule = require("../engine/token-refresh");
  const originalRefresh = tokenModule.refreshOneTok;
  const refreshed = [];
  tokenModule.refreshOneTok = async (account, options = {}) => {
    refreshed.push(account.id);
    return originalRefresh(account, {
      ...options,
      httpJson: async () => ({
        status: 200,
        body: JSON.stringify({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: account.tokens.refresh_token,
          id_token: account.tokens.id_token,
        }),
      }),
    });
  };
  t.after(() => { tokenModule.refreshOneTok = originalRefresh; });
  const result = await engine.runDaemonWorker();
  assert.equal(result.authState.status, "missing_official_auth");
  assert.equal(result.pausedReason, null);
  assert.equal(refreshed.includes(spare.id), true);
  assert.ok(result.tokenRefreshes.some((item) => item.accountId === spare.id && item.ok === true));
});

test("daemon pauses before network work when official authentication conflicts", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon@example.com", "acct-daemon", "daemon");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);

  const external = require("../engine/switch").buildAuthJson({
    ...account,
    tokens: tokens("external@example.com", "acct-external", "external"),
    account_id: "acct-external",
  });
  const config = require("../engine/config");
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(external), "utf8");

  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, "auth_conflict");
  assert.equal(result.accountsUpdated, 0);
  assert.deepEqual(result.tokenRefreshes, []);
});

test("the daemon does not restore a stale index backup after a non-JSON filesystem error", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-idx-fs@example.com", "acct-daemon-idx-fs", "daemon-idx-fs");
  const other = await addAccount(engine, "daemon-idx-fs-b@example.com", "acct-daemon-idx-fs-b", "daemon-idx-fs-b");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  const good = fs.readFileSync(config.IDX_PATH, "utf8");
  const stale = JSON.parse(good);
  stale.current_account_id = other.id;
  fs.writeFileSync(`${config.IDX_PATH}.bak`, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(config.IDX_PATH)) {
      const error = new Error("EISDIR: illegal operation on a directory");
      error.code = "EISDIR";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.some((item) => item.stage === "account_index" && item.code === "EISDIR"), true);
  assert.deepEqual(result.tokenRefreshes, []);
  fs.readFileSync = originalRead;
  assert.equal(JSON.parse(fs.readFileSync(config.IDX_PATH, "utf8")).current_account_id, current.id);
  assert.equal(JSON.parse(fs.readFileSync(`${config.IDX_PATH}.bak`, "utf8")).current_account_id, other.id);
});

test("the daemon does not pause as an auth conflict when official auth.json stays locked", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-auth-lock@example.com", "acct-daemon-auth-lock", "daemon-auth-lock");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(authPath)) {
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.some((item) => item.stage === "auth_inspect"), false);
  assert.equal(result.authState.status, "unknown");
  assert.equal(result.authState.requiresResolution, false);
  assert.equal(result.autoSwitchResult, null);
  assert.equal(result.accountsUpdated, 0);
  assert.deepEqual(result.tokenRefreshes, []);
});

test("the daemon skips official mirror when a later auth.json lock is leftover", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-auth-lock-later@example.com", "acct-daemon-auth-lock-later", "daemon-auth-lock-later");
  account.quota = {
    hourly_remaining_percentage: 80,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  account.usage_updated_at = engine.ts();
  engine.saveAcct(account);
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const originalRead = fs.readFileSync;
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async (target, options) => {
    try {
      return await originalRefresh(target, options);
    } finally {
      fs.readFileSync = (file, encoding) => {
        if (path.resolve(String(file)) === path.resolve(authPath)) {
          const error = new Error("EPERM: operation not permitted");
          error.code = "EPERM";
          throw error;
        }
        return originalRead(file, encoding);
      };
    }
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    fs.readFileSync = originalRead;
  });
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.notEqual(result.pausedReason, "auth_conflict");
  assert.equal(result.failures.some((item) => item.stage === "auth_inspect"), false);
  assert.equal(result.authState.status, "aligned");
});

test("the daemon does not pause as an auth conflict when official auth.json hits a non-JSON filesystem error", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-auth-fs@example.com", "acct-daemon-auth-fs", "daemon-auth-fs");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(authPath)) {
      const error = new Error("EISDIR: illegal operation on a directory");
      error.code = "EISDIR";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.some((item) => item.stage === "auth_inspect" && item.code === "EISDIR"), true);
  fs.readFileSync = originalRead;
  assert.ok(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.access_token);
});

test("daemon announces a newly missing official login once", async t => {
  const { engine } = freshEngine(t);
  const sent = [];
  engine.runDaemonWorker = async () => ({
    completedAt: Date.now(),
    pausedReason: null,
    failures: [],
    autoSwitchResult: null,
    authState: { status: "missing_official_auth", requiresResolution: true },
  });
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  const daemon = registerIpcHandlers(engine, {
    electron: {
      ipcMain: { handle() {} },
      BrowserWindow: {
        getAllWindows: () => [{
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send(channel, payload) { sent.push({ channel, status: payload?.status }); },
          },
        }],
      },
      app: { getVersion: () => "2.0.4", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  await daemon.runDaemon();
  await daemon.runDaemon();
  const authEvents = sent.filter((item) => item.channel === "auth:conflict");
  assert.equal(authEvents.length, 1);
  assert.equal(authEvents[0].status, "missing_official_auth");

  engine.runDaemonWorker = async () => ({
    completedAt: Date.now(),
    pausedReason: "auth_conflict",
    failures: [],
    autoSwitchResult: null,
    authState: { status: "conflict", requiresResolution: true },
  });
  await daemon.runDaemon();
  await daemon.runDaemon();
  const afterConflict = sent.filter((item) => item.channel === "auth:conflict");
  assert.equal(afterConflict.length, 2);
  assert.equal(afterConflict[1].status, "conflict");

  engine.getTickIntervalMs = () => 60 * 60 * 1000;
  engine.getTickIntervalMinutes = () => 60;
  daemon.startDaemon();
  await new Promise((resolve) => setTimeout(resolve, 40));
  daemon.stopDaemon();
  const afterRestart = sent.filter((item) => item.channel === "auth:conflict");
  assert.equal(afterRestart.length, 3);
  assert.equal(afterRestart[2].status, "conflict");
});

test("daemon restart during in-flight work schedules an immediate replacement run", async t => {
  const handlers = new Map();
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: {
      getAllWindows() {
        return [];
      },
    },
    app: {
      getVersion() {
        return "0.1.0-beta.9";
      },
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() {
        return "";
      },
    },
  };
  const releases = [];
  let runCount = 0;
  const engine = {
    getTickIntervalMs() {
      return 60 * 60 * 1000;
    },
    getTickIntervalMinutes() {
      return 60;
    },
    runDaemonWorker(options) {
      runCount += 1;
      return new Promise(resolve => {
        releases.push(() => resolve({
          completedAt: Date.now(),
          pausedReason: options.isCancelled() ? "stopped" : null,
          failures: [],
          autoSwitchResult: null,
        }));
      });
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  const daemon = registerIpcHandlers(engine, { electron });
  t.after(() => daemon.stopDaemon());

  daemon.startDaemon();
  assert.equal(runCount, 1);
  daemon.stopDaemon();
  daemon.startDaemon();
  assert.equal(runCount, 1);

  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runCount, 2);

  daemon.stopDaemon();
  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runCount, 2);
  assert.equal(handlers.has("daemon:start"), true);
  assert.equal(handlers.has("daemon:stop"), true);
});

test("starting the daemon clears a leftover stopped pause reason", async () => {
  const handlers = new Map();
  const engine = {
    getTickIntervalMs: () => 60 * 60 * 1000,
    getTickIntervalMinutes: () => 60,
    runDaemonWorker() {
      return new Promise(() => {});
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  const daemon = registerIpcHandlers(engine, {
    electron: {
      ipcMain: {
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      BrowserWindow: { getAllWindows: () => [] },
      app: { getVersion: () => "2.0.4", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  daemon.startDaemon();
  daemon.stopDaemon();
  const stopped = await handlers.get("daemon:status")({});
  assert.equal(stopped.data.pausedReason, "stopped");
  daemon.startDaemon();
  const started = await handlers.get("daemon:status")({});
  assert.equal(started.data.running, true);
  assert.equal(started.data.pausedReason, null);
  daemon.stopDaemon();
});

test("a cancelled daemon worker does not write stopped back over a restarted run", async () => {
  const handlers = new Map();
  const releases = [];
  const engine = {
    getTickIntervalMs: () => 60 * 60 * 1000,
    getTickIntervalMinutes: () => 60,
    runDaemonWorker(options) {
      return new Promise((resolve) => {
        releases.push(() => resolve({
          completedAt: Date.now(),
          pausedReason: options.isCancelled() ? "stopped" : null,
          failures: [],
          autoSwitchResult: null,
        }));
      });
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  const daemon = registerIpcHandlers(engine, {
    electron: {
      ipcMain: {
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      BrowserWindow: { getAllWindows: () => [] },
      app: { getVersion: () => "2.0.4", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  daemon.startDaemon();
  daemon.stopDaemon();
  daemon.startDaemon();
  assert.equal(releases.length, 1);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  const status = await handlers.get("daemon:status")({});
  assert.equal(status.data.running, true);
  assert.equal(status.data.pausedReason, null);
  daemon.stopDaemon();
  releases.shift()?.();
});

test("config saves reload only a changed daemon interval without triggering work", async t => {
  const handlers = new Map();
  const intervalCalls = [];
  const clearedIntervals = [];
  let nextTimerId = 0;
  let runCount = 0;
  let config = {
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 10,
  };
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const engine = {
    getTickIntervalMs: () => config.sync_interval_minutes * 60000,
    getTickIntervalMinutes: () => config.sync_interval_minutes,
    loadAutoSwitchCfg: () => ({ ...config }),
    saveAutoSwitchCfg(next) { config = { ...next }; },
    async runDaemonWorker() {
      runCount += 1;
      return {
        completedAt: Date.now(),
        pausedReason: null,
        failures: [],
        autoSwitchResult: null,
      };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  const daemon = registerIpcHandlers(engine, {
    electron,
    setInterval(callback, milliseconds) {
      const timer = { id: ++nextTimerId, callback, milliseconds };
      intervalCalls.push(timer);
      return timer;
    },
    clearInterval(timer) {
      clearedIntervals.push(timer);
    },
  });
  t.after(() => daemon.stopDaemon());

  daemon.startDaemon();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runCount, 1);
  assert.deepEqual(intervalCalls.map(timer => timer.milliseconds), [10 * 60000]);

  await handlers.get("autoswitch:config:save")({}, { ...config, primary_threshold: 15 });
  assert.equal(runCount, 1);
  assert.equal(intervalCalls.length, 1);
  assert.equal(clearedIntervals.length, 0);

  await handlers.get("autoswitch:config:save")({}, { ...config, sync_interval_minutes: 25 });
  assert.equal(runCount, 1);
  assert.deepEqual(intervalCalls.map(timer => timer.milliseconds), [10 * 60000, 25 * 60000]);
  assert.equal(clearedIntervals.length, 1);
});

test("manual auto-switch checks update daemon status metadata", async () => {
  const handlers = new Map();
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  let nextResult = { switched: false, reason: "quota_sufficient" };
  const engine = {
    getTickIntervalMs: () => 10 * 60000,
    getTickIntervalMinutes: () => 10,
    loadAutoSwitchCfg: () => ({
      enabled: false,
      primary_threshold: 20,
      secondary_threshold: 30,
      account_scope_mode: "selected",
      selected_account_ids: [],
      sync_interval_minutes: 10,
    }),
    async autoSwitchTick() {
      return nextResult;
    },
  };

  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });

  const before = await handlers.get("daemon:status")({});
  assert.equal(before.data.lastRunAt, null);

  const firstResult = await handlers.get("autoswitch:tick")({});
  assert.equal(firstResult.success, true);
  assert.equal(firstResult.data.reason, "quota_sufficient");
  const afterSuccess = await handlers.get("daemon:status")({});
  assert.equal(typeof afterSuccess.data.lastRunAt, "number");
  assert.equal(afterSuccess.data.lastSuccessAt, afterSuccess.data.lastRunAt);
  assert.equal(afterSuccess.data.lastError, null);

  nextResult = { switched: false, reason: "no_monitored" };
  const skippedResult = await handlers.get("autoswitch:tick")({});
  assert.equal(skippedResult.success, true);
  const afterSkip = await handlers.get("daemon:status")({});
  assert.equal(typeof afterSkip.data.lastRunAt, "number");
  assert.equal(afterSkip.data.lastSuccessAt, afterSuccess.data.lastSuccessAt);
  assert.equal(afterSkip.data.lastError, null);

  nextResult = {
    switched: false,
    reason: "current_quota_refresh_failed",
    error: "network unavailable",
  };
  const failedResult = await handlers.get("autoswitch:tick")({});
  assert.equal(failedResult.success, true);
  const afterFailure = await handlers.get("daemon:status")({});
  assert.equal(afterFailure.data.lastError, "network unavailable");
  assert.equal(afterFailure.data.lastSuccessAt, afterSkip.data.lastSuccessAt);

  nextResult = {
    switched: false,
    reason: "missing_official_auth",
    authState: { status: "missing_official_auth", requiresResolution: true },
  };
  const missingResult = await handlers.get("autoswitch:tick")({});
  assert.equal(missingResult.success, true);
  const afterMissing = await handlers.get("daemon:status")({});
  assert.equal(afterMissing.data.lastError, null);
  assert.equal(afterMissing.data.lastAuthStatus, "missing_official_auth");
  assert.equal(afterMissing.data.lastSuccessAt, afterSkip.data.lastSuccessAt);
  assert.equal(afterMissing.data.pausedReason, "missing_official_auth");

  nextResult = { switched: false, reason: "quota_sufficient", authState: { status: "aligned", requiresResolution: false } };
  const recovered = await handlers.get("autoswitch:tick")({});
  assert.equal(recovered.success, true);
  const afterRecovered = await handlers.get("daemon:status")({});
  assert.equal(afterRecovered.data.pausedReason, null);
  assert.equal(afterRecovered.data.lastAuthStatus, "aligned");
});

test("manual auto-switch check broadcasts the new current account to other windows", async () => {
  const handlers = new Map();
  const sent = [];
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send(channel, payload) { sent.push({ channel, payload }); },
        },
      }],
    },
    app: {
      getVersion: () => "2.0.4",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  let nextResult = {
    switched: false,
    reason: "quota_sufficient",
    to: { id: "codex_keep", email: "keep@example.com" },
  };
  const engine = {
    getTickIntervalMs: () => 10 * 60000,
    getTickIntervalMinutes: () => 10,
    loadAutoSwitchCfg: () => ({
      enabled: false,
      primary_threshold: 20,
      secondary_threshold: 30,
      account_scope_mode: "selected",
      selected_account_ids: [],
      sync_interval_minutes: 10,
    }),
    async autoSwitchTick() {
      return nextResult;
    },
  };

  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });

  const skipped = await handlers.get("autoswitch:tick")({});
  assert.equal(skipped.success, true);
  assert.equal(sent.some((item) => item.channel === "account:updated"), false);
  assert.equal(sent.some((item) => item.channel === "autoswitch:executed"), false);

  nextResult = {
    switched: true,
    reason: "switched",
    from: { id: "codex_keep", email: "keep@example.com" },
    to: { id: "codex_next", email: "next@example.com" },
    authState: { status: "aligned", currentAccountId: "codex_next", requiresResolution: false },
  };
  sent.length = 0;
  const switched = await handlers.get("autoswitch:tick")({});
  assert.equal(switched.success, true);
  assert.equal(switched.data.to.id, "codex_next");
  const accountEvents = sent.filter((item) => item.channel === "account:updated");
  assert.equal(accountEvents.length, 1);
  assert.equal(accountEvents[0].payload.product, "codex");
  assert.equal(accountEvents[0].payload.current, true);
  assert.equal(accountEvents[0].payload.account.id, "codex_next");
  assert.equal(sent.some((item) => item.channel === "autoswitch:executed"), false);
});

test("daemon auto-switch broadcasts the new current account to other windows", async () => {
  const sent = [];
  const engine = {
    getTickIntervalMs: () => 10 * 60000,
    getTickIntervalMinutes: () => 10,
    loadAutoSwitchCfg: () => ({ enabled: true, sync_interval_minutes: 10 }),
    async runDaemonWorker() {
      return {
        completedAt: Date.now(),
        pausedReason: null,
        failures: [],
        autoSwitchResult: {
          switched: true,
          from: { id: "codex_keep", email: "keep@example.com" },
          to: { id: "codex_next", email: "next@example.com" },
        },
        authState: { status: "aligned", currentAccountId: "codex_next", requiresResolution: false },
      };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  const daemon = registerIpcHandlers(engine, {
    electron: {
      ipcMain: { handle() {} },
      BrowserWindow: {
        getAllWindows: () => [{
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send(channel, payload) { sent.push({ channel, payload }); },
          },
        }],
      },
      app: { getVersion: () => "2.0.4", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  await daemon.runDaemon();
  const executed = sent.filter((item) => item.channel === "autoswitch:executed");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].payload.to.id, "codex_next");
  const accountEvents = sent.filter((item) => item.channel === "account:updated");
  assert.equal(accountEvents.length, 1);
  assert.equal(accountEvents[0].payload.product, "codex");
  assert.equal(accountEvents[0].payload.current, true);
  assert.equal(accountEvents[0].payload.account.id, "codex_next");
});

test("adopt official IPC returns the post-adopt auth state", async () => {
  const handlers = new Map();
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const engine = {
    getTickIntervalMs: () => 10 * 60000,
    getTickIntervalMinutes: () => 10,
    loadAutoSwitchCfg: () => ({ enabled: false, sync_interval_minutes: 10 }),
    async adoptOfficialAuth() {
      return { account: { id: "codex_adopt", email: "adopt@example.com" }, updated: true };
    },
    inspectAuthState() {
      return { status: "aligned", currentAccountId: "codex_adopt", requiresResolution: false };
    },
    async reapplyManagedAuth() {
      return {
        already: false,
        account: { id: "codex_keep", email: "keep@example.com" },
        authState: { status: "aligned", currentAccountId: "codex_keep", requiresResolution: false },
      };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const adopted = await handlers.get("account:adoptOfficial")({});
  assert.equal(adopted.success, true);
  assert.equal(adopted.data.email, "adopt@example.com");
  assert.equal(adopted.data.authState.status, "aligned");
  assert.equal(adopted.data.authState.currentAccountId, "codex_adopt");
  const reapplied = await handlers.get("account:reapplyManaged")({}, "codex_keep");
  assert.equal(reapplied.success, true);
  assert.equal(reapplied.data.authState.status, "aligned");
  assert.equal(reapplied.data.authState.currentAccountId, "codex_keep");
});

test("adopt official IPC does not keep a conflict when auth.json is locked", async () => {
  const handlers = new Map();
  const sent = [];
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send(channel, payload) { sent.push({ channel, payload }); },
        },
      }],
    },
    app: {
      getVersion: () => "2.0.4",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const engine = {
    getTickIntervalMs: () => 10 * 60000,
    getTickIntervalMinutes: () => 10,
    loadAutoSwitchCfg: () => ({ enabled: false, sync_interval_minutes: 10 }),
    async adoptOfficialAuth() {
      return { account: { id: "codex_adopt", email: "adopt@example.com" }, updated: true };
    },
    inspectAuthState() {
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      error.transientIoError = true;
      throw error;
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const adopted = await handlers.get("account:adoptOfficial")({});
  assert.equal(adopted.success, true);
  assert.equal(adopted.data.authState.status, "aligned");
  assert.equal(adopted.data.authState.requiresResolution, false);
  assert.equal(adopted.data.authState.currentAccountId, "codex_adopt");
  assert.notEqual(adopted.data.authState.status, "conflict");
  const accountEvents = sent.filter((item) => item.channel === "account:updated");
  assert.equal(accountEvents.length, 1);
  assert.equal(accountEvents[0].payload.current, true);
  assert.equal(accountEvents[0].payload.account.id, "codex_adopt");
});

test("reapply managed IPC broadcasts the current account after a successful rewrite", async () => {
  const handlers = new Map();
  const sent = [];
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send(channel, payload) { sent.push({ channel, payload }); },
        },
      }],
    },
    app: {
      getVersion: () => "2.0.4",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const engine = {
    getTickIntervalMs: () => 10 * 60000,
    getTickIntervalMinutes: () => 10,
    loadAutoSwitchCfg: () => ({ enabled: false, sync_interval_minutes: 10 }),
    async reapplyManagedAuth() {
      return {
        already: false,
        account: { id: "codex_keep", email: "keep@example.com" },
        authState: { status: "aligned", currentAccountId: "codex_keep", requiresResolution: false },
      };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const reapplied = await handlers.get("account:reapplyManaged")({}, "codex_keep");
  assert.equal(reapplied.success, true);
  assert.equal(reapplied.data.authState.status, "aligned");
  const accountEvents = sent.filter((item) => item.channel === "account:updated");
  assert.equal(accountEvents.length, 1);
  assert.equal(accountEvents[0].payload.current, true);
  assert.equal(accountEvents[0].payload.account.id, "codex_keep");
});

test("OAuth account-saved does not mark a reauthorized other card as current", async () => {
  const sent = [];
  let savedHandler = null;
  const engine = {
    getTickIntervalMs: () => 10 * 60000,
    getTickIntervalMinutes: () => 10,
    loadAutoSwitchCfg: () => ({ enabled: false, sync_interval_minutes: 10 }),
    setOAuthAccountSavedHandler(handler) {
      savedHandler = handler;
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, {
    electron: {
      ipcMain: { handle() {} },
      BrowserWindow: {
        getAllWindows: () => [{
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send(channel, payload) { sent.push({ channel, payload }); },
          },
        }],
      },
      app: { getVersion: () => "2.0.4", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  assert.equal(typeof savedHandler, "function");
  savedHandler({
    account: { id: "codex_other", email: "other@example.com" },
    switched: false,
    alreadyCurrent: false,
    switchError: null,
  });
  const otherEvents = sent.filter((item) => item.channel === "account:updated");
  assert.equal(otherEvents.length, 1);
  assert.equal(otherEvents[0].payload.current, false);
  sent.length = 0;
  savedHandler({
    account: { id: "codex_new", email: "new@example.com" },
    switched: true,
    alreadyCurrent: false,
    switchError: null,
  });
  const switchedEvents = sent.filter((item) => item.channel === "account:updated");
  assert.equal(switchedEvents[0].payload.current, true);
  sent.length = 0;
  savedHandler({
    account: { id: "codex_same", email: "same@example.com" },
    switched: false,
    alreadyCurrent: true,
    switchError: null,
  });
  const sameEvents = sent.filter((item) => item.channel === "account:updated");
  assert.equal(sameEvents[0].payload.current, true);
});

test("Codex OAuth IPC returns official auth after add, reauth, and manual complete", async () => {
  const handlers = new Map();
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const authState = { status: "aligned", currentAccountId: "codex_oauth", requiresResolution: false };
  const engine = {
    getTickIntervalMs: () => 10 * 60000,
    getTickIntervalMinutes: () => 10,
    loadAutoSwitchCfg: () => ({ enabled: false, sync_interval_minutes: 10 }),
    listAccts: () => [{ id: "codex_oauth", email: "oauth@example.com" }],
    async oauthLoginFlow(options = {}) {
      return {
        account: { id: "codex_oauth", email: "oauth@example.com" },
        mismatch: false,
        targetAccountId: options.targetAccountId || null,
        switched: !options.targetAccountId,
        switchError: null,
        authState,
      };
    },
    async completeOAuthManually() {
      return {
        account: { id: "codex_oauth", email: "oauth@example.com" },
        mismatch: false,
        switched: true,
        switchError: null,
        authState,
      };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const added = await handlers.get("account:add")({});
  assert.equal(added.success, true);
  assert.equal(added.data.authState.status, "aligned");
  assert.equal(added.data.switched, true);
  const reauthed = await handlers.get("account:reauthorize")({}, "codex_oauth");
  assert.equal(reauthed.success, true);
  assert.equal(reauthed.data.targetAccountId, "codex_oauth");
  assert.equal(reauthed.data.authState.currentAccountId, "codex_oauth");
  const completed = await handlers.get("oauth:completeManual")({}, "https://example.com/?code=1");
  assert.equal(completed.success, true);
  assert.equal(completed.data.authState.status, "aligned");
  assert.equal(completed.data.switched, true);
});

test("adopt official IPC still returns the account if auth inspect fails", async () => {
  const handlers = new Map();
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.9",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const engine = {
    getTickIntervalMs: () => 10 * 60000,
    getTickIntervalMinutes: () => 10,
    loadAutoSwitchCfg: () => ({ enabled: false, sync_interval_minutes: 10 }),
    async adoptOfficialAuth() {
      return { account: { id: "codex_adopt2", email: "adopt2@example.com" }, updated: false };
    },
    inspectAuthState() {
      throw new Error("inspect failed");
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const adopted = await handlers.get("account:adoptOfficial")({});
  assert.equal(adopted.success, true);
  assert.equal(adopted.data.email, "adopt2@example.com");
  assert.equal(adopted.data.authState, null);
});

test("switch transaction commits on success and restores state when launch fails", async t => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "one@example.com", "acct-one", "one");
  const second = await addAccount(engine, "two@example.com", "acct-two", "two");
  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(first);
  engine.writeProjection(first, auth);

  let running = true;
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: () => running ? [{ name: "Codex.exe", pid: 99 }] : [],
    gracefulClose: () => { running = false; return true; },
    forceClose: () => { running = false; return true; },
    launch: () => { running = true; },
    sleep() {},
  });
  const switched = await engine.doSwitch(second);
  assert.equal(engine.loadIdx().current_account_id, second.id);
  assert.equal(engine.inspectAuthState().status, "aligned");
  assert.equal(switched.authState.status, "aligned");
  assert.equal(switched.authState.currentAccountId, second.id);

  first.requires_reauth = true;
  await assert.rejects(engine.doSwitch(first), /requires reauthorization/i);
  assert.equal(engine.loadIdx().current_account_id, second.id);
  first.requires_reauth = false;
  first.banned = true;
  await assert.rejects(engine.doSwitch(first), /banned and cannot be switched/i);
  assert.equal(engine.loadIdx().current_account_id, second.id);
  first.banned = false;

  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: () => running ? [{ name: "Codex.exe", pid: 99 }] : [],
    gracefulClose: () => { running = false; return true; },
    forceClose: () => { running = false; return true; },
    launch: () => { throw new Error("launch failed"); },
    sleep() {},
  });
  await assert.rejects(engine.doSwitch(first), /launch failed/);
  assert.equal(engine.loadIdx().current_account_id, second.id);
  assert.equal(engine.inspectAuthState().status, "aligned");
});

test("Codex switch rolls back when official auth does not match the target after write", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "verify-keep@example.com", "acct-verify-keep", "verify-keep");
  const target = await addAccount(engine, "verify-target@example.com", "acct-verify-target", "verify-target");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  let running = true;
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: () => running ? [{ name: "Codex.exe", pid: 99 }] : [],
    gracefulClose: () => { running = false; return true; },
    forceClose: () => { running = false; return true; },
    launch: () => { running = true; },
    sleep() {},
  });
  const authState = require("../engine/auth-state");
  const originalInspect = authState.inspectAuthState;
  authState.inspectAuthState = () => ({
    status: "conflict",
    currentAccountId: target.id,
    requiresResolution: true,
  });
  t.after(() => { authState.inspectAuthState = originalInspect; });
  await assert.rejects(engine.doSwitch(target), /核对失败/);
  authState.inspectAuthState = originalInspect;
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(engine.inspectAuthState().status, "aligned");
  assert.equal(engine.inspectAuthState().currentAccountId, current.id);
});

test("Codex switch skip stays put when leftover lock blocks already-current inspect", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "busy-skip-cur@example.com", "acct-busy-skip-cur", "busy-skip-cur");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  let launchCount = 0;
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: () => [],
    gracefulClose: () => true,
    forceClose: () => true,
    launch: () => { launchCount += 1; },
    sleep() {},
  });
  const authState = require("../engine/auth-state");
  const originalInspect = authState.inspectAuthState;
  authState.inspectAuthState = () => {
    const error = new Error("EPERM: operation not permitted");
    error.code = "EPERM";
    throw error;
  };
  t.after(() => { authState.inspectAuthState = originalInspect; });
  const skipped = await engine.doSwitch(engine.loadAcct(current.id));
  authState.inspectAuthState = originalInspect;
  assert.equal(skipped.already, true);
  assert.equal(skipped.authState.status, "unknown");
  assert.equal(skipped.authState.requiresResolution, false);
  assert.equal(launchCount, 0);
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(engine.inspectAuthState().status, "aligned");
  assert.equal(engine.inspectAuthState().currentAccountId, current.id);
});

test("Codex switch does not roll back when leftover lock blocks post-write inspect", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "busy-keep-cur@example.com", "acct-busy-keep-cur", "busy-keep-cur");
  const target = await addAccount(engine, "busy-keep-target@example.com", "acct-busy-keep-target", "busy-keep-target");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  let running = true;
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: () => running ? [{ name: "Codex.exe", pid: 99 }] : [],
    gracefulClose: () => { running = false; return true; },
    forceClose: () => { running = false; return true; },
    launch: () => { running = true; },
    sleep() {},
  });
  const authState = require("../engine/auth-state");
  const originalInspect = authState.inspectAuthState;
  authState.inspectAuthState = () => {
    const error = new Error("EPERM: operation not permitted");
    error.code = "EPERM";
    throw error;
  };
  t.after(() => { authState.inspectAuthState = originalInspect; });
  const result = await engine.doSwitch(target);
  authState.inspectAuthState = originalInspect;
  assert.equal(result.already, false);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, target.id);
  assert.equal(engine.loadIdx().current_account_id, target.id);
  assert.equal(engine.inspectAuthState().status, "aligned");
  assert.equal(engine.inspectAuthState().currentAccountId, target.id);
});

test("Codex switch still clears api_base_url when existsSync reports config.toml missing", (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  engine.ensureDir(config.CODEX_DIR);
  const configPath = path.join(config.CODEX_DIR, "config.toml");
  fs.writeFileSync(configPath, 'model = "gpt-5"\napi_base_url = "http://127.0.0.1:8080/v1"\nopenai_base_url = "http://127.0.0.1:8080/v1"\n');
  const originalExists = fs.existsSync;
  fs.existsSync = (target) => {
    if (path.resolve(String(target)) === path.resolve(configPath)) return false;
    return originalExists(target);
  };
  t.after(() => { fs.existsSync = originalExists; });
  assert.equal(engine.clearApiBaseUrl(), true);
  const text = fs.readFileSync(configPath, "utf8");
  assert.equal(text.includes("api_base_url"), false);
  assert.equal(text.includes("openai_base_url"), false);
  assert.match(text, /model = "gpt-5"/);
});

test("Codex switch rolls back to official files captured after kill", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "pre-kill@example.com", "acct-pre-kill", "pre-kill");
  const target = await addAccount(engine, "post-kill@example.com", "acct-post-kill", "post-kill");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const flushed = JSON.stringify({ tokens: { access_token: "flushed-on-exit", id_token: "", refresh_token: "" } });
  let living = [{ name: "Codex.exe", pid: 2147483646 }];
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: async () => living,
    gracefulClose: async () => {
      fs.writeFileSync(authPath, flushed, "utf8");
      living = [];
      return true;
    },
    forceClose: async () => {
      living = [];
      return true;
    },
    launch: () => { throw new Error("launch failed"); },
    sleep: async () => {},
  });
  await assert.rejects(() => engine.doSwitch(target), /launch failed/);
  assert.equal(fs.readFileSync(authPath, "utf8"), flushed);
  assert.equal(engine.loadIdx().current_account_id, current.id);
});

test("Codex switch rollback retries when restoring a locked official file", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "rollback-lock@example.com", "acct-rollback-lock", "rollback-lock");
  const target = await addAccount(engine, "rollback-lock-target@example.com", "acct-rollback-lock-target", "rollback-lock-target");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const flushed = JSON.stringify({ tokens: { access_token: "flushed-for-rollback-lock", id_token: "", refresh_token: "" } });
  let living = [{ name: "Codex.exe", pid: 2147483646 }];
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: async () => living,
    gracefulClose: async () => {
      fs.writeFileSync(authPath, flushed, "utf8");
      living = [];
      return true;
    },
    forceClose: async () => {
      living = [];
      return true;
    },
    launch: () => { throw new Error("launch failed"); },
    sleep: async () => {},
  });
  const originalOpen = fs.openSync;
  let failures = 0;
  fs.openSync = (target, ...rest) => {
    if (String(target).includes(".rollback.tmp") && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalOpen(target, ...rest);
  };
  t.after(() => { fs.openSync = originalOpen; });
  await assert.rejects(() => engine.doSwitch(target), /launch failed/);
  assert.equal(failures, 2);
  assert.equal(fs.readFileSync(authPath, "utf8"), flushed);
  assert.equal(engine.loadIdx().current_account_id, current.id);
});

test("Codex switch rollback fsyncs the restored official file before rename", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "rollback-fsync@example.com", "acct-rollback-fsync", "rollback-fsync");
  const target = await addAccount(engine, "rollback-fsync-target@example.com", "acct-rollback-fsync-target", "rollback-fsync-target");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const flushed = JSON.stringify({ tokens: { access_token: "flushed-for-rollback-fsync", id_token: "", refresh_token: "" } });
  let living = [{ name: "Codex.exe", pid: 2147483645 }];
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: async () => living,
    gracefulClose: async () => {
      fs.writeFileSync(authPath, flushed, "utf8");
      living = [];
      return true;
    },
    forceClose: async () => {
      living = [];
      return true;
    },
    launch: () => { throw new Error("launch failed"); },
    sleep: async () => {},
  });
  const originalFsync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  let fsyncs = 0;
  let renamedAuth = false;
  fs.fsyncSync = (fd) => {
    if (!renamedAuth) fsyncs += 1;
    return originalFsync(fd);
  };
  fs.renameSync = (fromPath, toPath) => {
    if (path.resolve(String(toPath)) === path.resolve(authPath)) {
      assert.ok(fsyncs >= 1, "rollback must fsync before replacing auth.json");
      renamedAuth = true;
    }
    return originalRename(fromPath, toPath);
  };
  t.after(() => {
    fs.fsyncSync = originalFsync;
    fs.renameSync = originalRename;
  });
  await assert.rejects(() => engine.doSwitch(target), /launch failed/);
  assert.ok(fsyncs >= 1);
  assert.equal(renamedAuth, true);
  assert.equal(fs.readFileSync(authPath, "utf8"), flushed);
  assert.equal(engine.loadIdx().current_account_id, current.id);
});

test("Codex switch snapshot retries a transient lock on official files", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "snap-lock-current@example.com", "acct-snap-lock-current", "snap-lock-current");
  const target = await addAccount(engine, "snap-lock-target@example.com", "acct-snap-lock-target", "snap-lock-target");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const flushed = JSON.stringify({ tokens: { access_token: "flushed-after-kill", id_token: "", refresh_token: "" } });
  let living = [{ name: "Codex.exe", pid: 2147483646 }];
  let lockAuthReads = false;
  const originalRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = (file, encoding) => {
    if (lockAuthReads && path.resolve(String(file)) === path.resolve(authPath) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: async () => living,
    gracefulClose: async () => {
      fs.writeFileSync(authPath, flushed, "utf8");
      lockAuthReads = true;
      living = [];
      return true;
    },
    forceClose: async () => {
      living = [];
      return true;
    },
    launch: () => { throw new Error("launch failed"); },
    sleep: async () => {},
  });
  await assert.rejects(() => engine.doSwitch(target), /launch failed/);
  assert.equal(failures, 2);
  assert.equal(fs.readFileSync(authPath, "utf8"), flushed);
  assert.equal(engine.loadIdx().current_account_id, current.id);
});

test("aligned current account skips rewrite unless switch is forced", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "current@example.com", "acct-current-reapply", "current-reapply");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  let running = true;
  let launchCount = 0;
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: () => running ? [{ name: "Codex.exe", pid: 99 }] : [],
    gracefulClose: () => { running = false; return true; },
    forceClose: () => { running = false; return true; },
    launch: () => {
      running = true;
      launchCount += 1;
    },
    sleep() {},
  });

  const skipped = await engine.doSwitch(engine.loadAcct(current.id));
  assert.equal(skipped.already, true);
  assert.equal(launchCount, 0);
  assert.equal(engine.inspectAuthState().status, "aligned");

  const account = engine.loadAcct(current.id);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const skippedAgain = await engine.doSwitch(account);
  assert.equal(skippedAgain.already, true);
  assert.equal(decrypts.count, 1);

  const forced = await engine.doSwitch(engine.loadAcct(current.id), { force: true });
  assert.equal(forced.already, false);
  assert.equal(launchCount, 1);
  assert.equal(engine.inspectAuthState().status, "aligned");

  const reapplied = await engine.reapplyManagedAuth(current.id);
  assert.equal(reapplied.already, false);
  assert.equal(launchCount, 2);
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(engine.inspectAuthState().status, "aligned");
  assert.equal(reapplied.authState.status, "aligned");
  assert.equal(reapplied.authState.currentAccountId, current.id);
});

test("process enumeration failure blocks credential switching", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "enumeration-current@example.com", "acct-enumeration-current", "enumeration-current");
  const target = await addAccount(engine, "enumeration-target@example.com", "acct-enumeration-target", "enumeration-target");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const { defaultListProcesses } = require("../engine/switch");
  const listProcesses = () => defaultListProcesses(async () => {
    throw new Error("CIM query unavailable");
  });
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses,
    launch() {
      throw new Error("rollback launch unavailable");
    },
    sleep() {},
  });

  await assert.rejects(engine.doSwitch(target), error => {
    assert.equal(error.code, "codex_process_enumeration_failed");
    assert.match(error.message, /CIM query unavailable/);
    return true;
  });
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(engine.inspectAuthState().status, "aligned");
});

test("official Codex launcher does not treat the explorer activation exit code as failure", t => {
  const { engine } = freshEngine(t);
  let command = null;
  let options = null;
  let unrefCalled = false;
  const childProcess = {
    spawn(file, args, spawnOptions) {
      command = [file, ...args];
      options = spawnOptions;
      return {
        once() {},
        unref() { unrefCalled = true; },
      };
    },
  };

  assert.equal(engine.launchOfficialCodex(childProcess), true);
  assert.deepEqual(command, [
    "explorer.exe",
    "shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App",
  ]);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(unrefCalled, true);
});

test("codex process listing uses Get-Process instead of a full Win32_Process scan", async () => {
  const { defaultListProcesses } = require("../engine/switch");
  let command = "";
  const processes = await defaultListProcesses(async (_file, args) => {
    command = String(args[args.length - 1] || "");
    return {
      stdout: JSON.stringify([
        {
          Name: "ChatGPT.exe",
          ProcessId: 4242,
          ExecutablePath: "C:\\\\Program Files\\\\WindowsApps\\\\OpenAI.Codex_1\\\\ChatGPT.exe",
          MainWindowTitle: "ChatGPT",
        },
        {
          Name: "node_repl.exe",
          ProcessId: 4243,
          ExecutablePath: "C:\\\\Windows\\\\System32\\\\node_repl.exe",
        },
      ]),
    };
  });
  assert.match(command, /Get-Process/);
  assert.doesNotMatch(command, /Get-CimInstance/);
  assert.doesNotMatch(command, /Win32_Process/);
  assert.equal(processes.length, 1);
  assert.equal(processes[0].pid, 4242);
  assert.equal(processes[0].name, "ChatGPT.exe");
  assert.equal(processes[0].windowTitle, "ChatGPT");
});

test("Codex start verification waits for the GUI process and rejects a crash window", async t => {
  const { engine } = freshEngine(t);
  const helperOnly = [{
    name: "codex.exe",
    pid: 10,
    executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\resources\\codex.exe",
  }];
  const crashGui = [{
    name: "ChatGPT.exe",
    pid: 11,
    executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe",
    windowTitle: "ChatGPT 意外停止",
  }];
  const healthyGui = [{
    name: "ChatGPT.exe",
    pid: 12,
    executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe",
    windowTitle: "ChatGPT",
  }];

  let ticks = 0;
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: () => {
      ticks += 1;
      return ticks < 3 ? helperOnly : healthyGui;
    },
    launch() {},
    sleep() {},
  });
  assert.equal(await engine.startCodex({ timeoutMs: 2000 }), true);
  assert.ok(ticks >= 3);

  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: () => crashGui,
    launch() {},
    sleep() {},
  });
  await assert.rejects(engine.startCodex({ timeoutMs: 400 }), /crash recovery window/i);
});

test("Codex start verification backs off the poll interval", async (t) => {
  const { engine } = freshEngine(t);
  const sleeps = [];
  engine.setSwitchRuntimeForTests({
    assertInstalled() {},
    listProcesses: () => [],
    launch() {},
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await assert.rejects(engine.startCodex({ timeoutMs: 250 }), /did not start/);
  assert.equal(sleeps[0], 50);
  assert.equal(sleeps[1], 100);
  assert.equal(sleeps[2], 200);
  assert.ok(sleeps.length >= 4);
  assert.ok(sleeps.slice(3).every((ms) => ms === 400));
});

test("OAuth browser open uses the injected opener and keeps the authorize query string", async t => {
  const { engine } = freshEngine(t);
  const opened = [];
  engine.setOpenUrlHandler((url) => {
    opened.push(url);
  });
  const pendingPromise = engine.oauthLoginFlow({
    exchangeCode: async () => tokens("browser@example.com", "acct-browser", "browser"),
  });
  const startedAt = Date.now();
  while (!opened.length && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  assert.match(opened[0], /response_type=code/);
  assert.match(opened[0], /client_id=/);
  assert.equal(engine.cancelOAuth(), true);
  await assert.rejects(pendingPromise, /cancelled/);
});

test("OAuth pending state is encrypted, recoverable, cancellable, and target mismatch is saved separately", async t => {
  const { engine, codec } = freshEngine(t);
  const original = await addAccount(engine, "original@example.com", "acct-original", "original");
  const renamed = await engine.upsert(tokens("renamed@example.com", "acct-original", "renamed"), {
    targetAccountId: original.id,
  });
  assert.equal(renamed.mismatch, false);
  assert.equal(renamed.account.id, original.id);
  assert.equal(engine.loadAcct(original.id).email, "renamed@example.com");
  assert.equal(engine.listAccts().length, 1);

  const result = await engine.upsert(tokens("different@example.com", "acct-different", "different"), {
    targetAccountId: original.id,
  });
  assert.equal(result.mismatch, true);
  assert.equal(engine.loadAcct(original.id).email, "renamed@example.com");
  assert.equal(engine.loadAcct(result.account.id).email, "different@example.com");

  const pendingPromise = engine.oauthLoginFlow({ openBrowser: false });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  assert.equal(fs.existsSync(pendingPath), true);
  const envelope = fs.readFileSync(pendingPath, "utf8");
  assert.equal(envelope.includes("verifier"), false);
  assert.equal(engine.cancelOAuth(), true);
  await assert.rejects(pendingPromise, /cancelled/);
  assert.equal(fs.existsSync(pendingPath), false);

  fs.writeFileSync(pendingPath, envelope, "utf8");
  await new Promise(resolve => setTimeout(resolve, 50));
  clearEngineModules();
  const restoredEngine = require("../engine");
  restoredEngine.setSecretCodec(codec);
  assert.equal(restoredEngine.restorePendingOAuth(), true);
  assert.equal(restoredEngine.getOAuthStatus().pending, true);
  await assert.rejects(restoredEngine.completeOAuthManually("not-a-url"), /complete OAuth callback URL/);
  assert.equal(restoredEngine.cancelOAuth(), true);
});

test("pending OAuth still restores when existsSync reports the file missing", async (t) => {
  const { engine, codec } = freshEngine(t);
  const pendingPromise = engine.oauthLoginFlow({ openBrowser: false });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const envelope = fs.readFileSync(pendingPath, "utf8");
  engine.cancelOAuth();
  await assert.rejects(pendingPromise, /cancelled/);

  fs.writeFileSync(pendingPath, envelope, "utf8");
  const originalExists = fs.existsSync;
  fs.existsSync = (target) => {
    if (path.resolve(String(target)) === path.resolve(pendingPath)) return false;
    return originalExists(target);
  };
  t.after(() => { fs.existsSync = originalExists; });
  clearEngineModules();
  const restoredEngine = require("../engine");
  restoredEngine.setSecretCodec(codec);
  assert.equal(restoredEngine.restorePendingOAuth(), true);
  assert.equal(restoredEngine.getOAuthStatus().pending, true);
  assert.equal(originalExists(pendingPath), true, "a locked pending file must not be cleared");
  assert.equal(restoredEngine.cancelOAuth(), true);
});

test("pending OAuth still restores when the first JSON parse sees a torn write", async (t) => {
  const { engine, codec } = freshEngine(t);
  const pendingPromise = engine.oauthLoginFlow({ openBrowser: false });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const envelope = fs.readFileSync(pendingPath, "utf8");
  engine.cancelOAuth();
  await assert.rejects(pendingPromise, /cancelled/);

  fs.writeFileSync(pendingPath, envelope, "utf8");
  stubTornJsonReads(t, pendingPath);
  clearEngineModules();
  const restoredEngine = require("../engine");
  restoredEngine.setSecretCodec(codec);
  assert.equal(restoredEngine.restorePendingOAuth(), true);
  assert.equal(restoredEngine.getOAuthStatus().pending, true);
  assert.equal(fs.existsSync(pendingPath), true, "a briefly torn pending file must not be cleared");
  assert.equal(restoredEngine.cancelOAuth(), true);
});

test("readJsonWithBackup does not promote a backup on a non-JSON filesystem error", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-json-backup-"));
  const filePath = path.join(root, "probe.json");
  fs.writeFileSync(filePath, `${JSON.stringify({ keep: true })}\n`, "utf8");
  fs.writeFileSync(`${filePath}.bak`, `${JSON.stringify({ keep: false })}\n`, "utf8");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(filePath)) {
      const error = new Error("EISDIR: illegal operation on a directory");
      error.code = "EISDIR";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => {
    fs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { readJsonWithBackup } = require("../engine/atomic-file");
  assert.throws(
    () => readJsonWithBackup(filePath),
    (error) => error.code === "EISDIR",
  );
  fs.readFileSync = originalRead;
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).keep, true);
  assert.equal(JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8")).keep, false);
});

test("pending OAuth is not cleared on a non-JSON filesystem error", async (t) => {
  const { engine, codec } = freshEngine(t);
  const pendingPromise = engine.oauthLoginFlow({ openBrowser: false });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const envelope = fs.readFileSync(pendingPath, "utf8");
  engine.cancelOAuth();
  await assert.rejects(pendingPromise, /cancelled/);

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
  clearEngineModules();
  const restoredEngine = require("../engine");
  restoredEngine.setSecretCodec(codec);
  assert.equal(restoredEngine.restorePendingOAuth(), false);
  fs.readFileSync = originalRead;
  assert.equal(fs.readFileSync(pendingPath, "utf8"), envelope);
  assert.equal(restoredEngine.restorePendingOAuth(), true);
  assert.equal(restoredEngine.getOAuthStatus().pending, true);
  assert.equal(restoredEngine.cancelOAuth(), true);
});

test("pending OAuth still restores from backup after persistent corruption", async (t) => {
  const { engine, codec } = freshEngine(t);
  const pendingPromise = engine.oauthLoginFlow({ openBrowser: false });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const envelope = fs.readFileSync(pendingPath, "utf8");
  engine.cancelOAuth();
  await assert.rejects(pendingPromise, /cancelled/);

  fs.writeFileSync(`${pendingPath}.bak`, envelope, "utf8");
  fs.writeFileSync(pendingPath, "{ corrupted", "utf8");
  clearEngineModules();
  const restoredEngine = require("../engine");
  restoredEngine.setSecretCodec(codec);
  assert.equal(restoredEngine.restorePendingOAuth(), true);
  try {
    assert.equal(restoredEngine.getOAuthStatus().pending, true);
    assert.equal(JSON.parse(fs.readFileSync(pendingPath, "utf8")).protected_payload.length > 0, true);
  } finally {
    assert.equal(restoredEngine.cancelOAuth(), true);
  }
});

test("pending OAuth does not resurrect a leftover backup after the pending file is gone", async (t) => {
  const { engine, codec } = freshEngine(t);
  const pendingPromise = engine.oauthLoginFlow({ openBrowser: false });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const envelope = fs.readFileSync(pendingPath, "utf8");
  engine.cancelOAuth();
  await assert.rejects(pendingPromise, /cancelled/);

  fs.writeFileSync(`${pendingPath}.bak`, envelope, "utf8");
  clearEngineModules();
  const restoredEngine = require("../engine");
  restoredEngine.setSecretCodec(codec);
  assert.equal(restoredEngine.restorePendingOAuth(), false);
  assert.equal(restoredEngine.getOAuthStatus().pending, false);
  assert.equal(fs.existsSync(pendingPath), false);
});

test("pending OAuth still fails when both the pending file and its backup are corrupt", async (t) => {
  const { engine, codec } = freshEngine(t);
  const pendingPromise = engine.oauthLoginFlow({ openBrowser: false });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  engine.cancelOAuth();
  await assert.rejects(pendingPromise, /cancelled/);

  fs.writeFileSync(pendingPath, "{ corrupted", "utf8");
  fs.writeFileSync(`${pendingPath}.bak`, "{ also corrupted", "utf8");
  clearEngineModules();
  const restoredEngine = require("../engine");
  restoredEngine.setSecretCodec(codec);
  assert.equal(restoredEngine.restorePendingOAuth(), false);
  assert.equal(restoredEngine.getOAuthStatus().pending, false);
  assert.equal(fs.existsSync(pendingPath), false, "a persistently corrupt pending file must still be cleared");
});

test("cancelling OAuth retries when the pending file is transiently locked", async (t) => {
  const { engine } = freshEngine(t);
  const pendingPromise = engine.oauthLoginFlow({ openBrowser: false });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const originalUnlink = fs.unlinkSync;
  let failures = 0;
  fs.unlinkSync = (target) => {
    if (path.resolve(String(target)) === path.resolve(pendingPath) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalUnlink(target);
  };
  t.after(() => { fs.unlinkSync = originalUnlink; });
  assert.equal(engine.cancelOAuth(), true);
  assert.equal(failures, 2);
  assert.equal(fs.existsSync(pendingPath), false);
  await assert.rejects(pendingPromise, /cancelled/);
});

test("OAuth manual callback waits for completion and honors cancellation", async t => {
  const { engine, codec } = freshEngine(t);
  const pendingPromise = engine.oauthLoginFlow({
    openBrowser: false,
    exchangeCode: async () => tokens("manual@example.com", "acct-manual", "manual"),
  });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const envelope = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  const pending = JSON.parse(codec.decrypt(envelope.protected_payload));
  const callbackUrl = `${pending.redirectUri}?code=oauth-code&state=${pending.state}`;

  const manualResult = await engine.completeOAuthManually(callbackUrl);
  const flowResult = await pendingPromise;
  assert.equal(manualResult.account.email, "manual@example.com");
  assert.equal(flowResult.account.id, manualResult.account.id);
  assert.equal(engine.loadAcct(manualResult.account.id).email, "manual@example.com");
  assert.equal(engine.getOAuthStatus().pending, false);
  assert.equal(fs.existsSync(pendingPath), false);

  const second = freshEngine(t);
  let releaseExchange;
  const blockedFlow = second.engine.oauthLoginFlow({
    openBrowser: false,
    exchangeCode: async () => {
      await new Promise(resolve => { releaseExchange = resolve; });
      return tokens("cancelled@example.com", "acct-cancelled", "cancelled");
    },
  });
  const secondEnvelope = JSON.parse(fs.readFileSync(require("../engine/oauth").PENDING_PATH, "utf8"));
  const secondPending = JSON.parse(second.codec.decrypt(secondEnvelope.protected_payload));
  const blockedManual = second.engine.completeOAuthManually(`${secondPending.redirectUri}?code=late-code&state=${secondPending.state}`);
  assert.equal(second.engine.cancelOAuth(), true);
  releaseExchange();
  await assert.rejects(blockedFlow, /cancelled/);
  await assert.rejects(blockedManual, /cancelled/);
  assert.equal(second.engine.listAccts().some(account => account.email === "cancelled@example.com"), false);
});

test("OAuth callback page waits for token save and uses Chinese copy", async t => {
  const { engine, codec } = freshEngine(t);
  const pendingPromise = engine.oauthLoginFlow({
    openBrowser: false,
    exchangeCode: async () => tokens("callback-page@example.com", "acct-callback-page", "callback"),
  });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const startedAt = Date.now();
  while (!fs.existsSync(pendingPath) && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const envelope = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  const pending = JSON.parse(codec.decrypt(envelope.protected_payload));
  const callbackUrl = `${pending.redirectUri}?code=oauth-code&state=${pending.state}`;

  let html = "";
  const fetchStarted = Date.now();
  while (Date.now() - fetchStarted < 4000) {
    try {
      const response = await fetch(callbackUrl);
      html = await response.text();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.match(html, /授权已保存/);
  assert.match(html, /可以回到 Quota Switcher/);
  assert.equal(html.includes("Authorization received"), false);
  const result = await pendingPromise;
  assert.equal(result.account.email, "callback-page@example.com");
});

test("Codex OAuth add switches the new account into official Codex", async t => {
  const { engine, codec } = freshEngine(t);
  const previous = await addAccount(engine, "ham@example.com", "acct-ham", "ham");
  await engine.doSwitch(previous);
  assert.equal(engine.currentAcct().id, previous.id);

  const pendingPromise = engine.oauthLoginFlow({
    openBrowser: false,
    exchangeCode: async () => tokens("tra@example.com", "acct-tra", "tra"),
  });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const startedAt = Date.now();
  while (!fs.existsSync(pendingPath) && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const envelope = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  const decoded = JSON.parse(codec.decrypt(envelope.protected_payload));
  const callbackUrl = `${decoded.redirectUri}?code=oauth-code&state=${decoded.state}`;
  const result = await engine.completeOAuthManually(callbackUrl);
  await pendingPromise;
  assert.equal(result.account.email, "tra@example.com");
  assert.equal(engine.currentAcct().id, result.account.id);
  assert.notEqual(engine.currentAcct().id, previous.id);
  assert.equal(result.switched, true);
  assert.equal(result.switchError || null, null);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, result.account.id);
  assert.equal(engine.getOAuthStatus().result.authState.status, "aligned");
});

test("Codex OAuth add still reports official auth when the follow-up switch fails", async t => {
  const { engine, codec } = freshEngine(t);
  const previous = await addAccount(engine, "keep-oauth@example.com", "acct-keep-oauth", "keep-oauth");
  await engine.doSwitch(previous);
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  switchModule.doSwitch = async () => {
    throw new Error("launch failed");
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });
  const pendingPromise = engine.oauthLoginFlow({
    openBrowser: false,
    exchangeCode: async () => tokens("new-oauth@example.com", "acct-new-oauth", "new-oauth"),
  });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const startedAt = Date.now();
  while (!fs.existsSync(pendingPath) && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const envelope = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  const decoded = JSON.parse(codec.decrypt(envelope.protected_payload));
  const callbackUrl = `${decoded.redirectUri}?code=oauth-code&state=${decoded.state}`;
  const result = await engine.completeOAuthManually(callbackUrl);
  await pendingPromise;
  assert.equal(result.switched, false);
  assert.match(result.switchError, /launch failed/);
  assert.equal(engine.currentAcct().id, previous.id);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, previous.id);
  assert.equal(engine.getOAuthStatus().result.authState.status, "aligned");
  assert.equal(engine.getOAuthStatus().result.authState.currentAccountId, previous.id);
});

test("Codex OAuth switch failure does not invent a conflict when auth.json is locked", async t => {
  const { engine, codec } = freshEngine(t);
  const previous = await addAccount(engine, "keep-oauth-lock@example.com", "acct-keep-oauth-lock", "keep-oauth-lock");
  await engine.doSwitch(previous);
  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  switchModule.doSwitch = async () => {
    throw new Error("launch failed");
  };
  const authState = require("../engine/auth-state");
  const originalInspect = authState.inspectAuthState;
  authState.inspectAuthState = () => {
    const error = new Error("EPERM: operation not permitted");
    error.code = "EPERM";
    error.transientIoError = true;
    throw error;
  };
  t.after(() => {
    switchModule.doSwitch = originalSwitch;
    authState.inspectAuthState = originalInspect;
  });
  const pendingPromise = engine.oauthLoginFlow({
    openBrowser: false,
    exchangeCode: async () => tokens("new-oauth-lock@example.com", "acct-new-oauth-lock", "new-oauth-lock"),
  });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const startedAt = Date.now();
  while (!fs.existsSync(pendingPath) && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const envelope = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  const decoded = JSON.parse(codec.decrypt(envelope.protected_payload));
  const callbackUrl = `${decoded.redirectUri}?code=oauth-code&state=${decoded.state}`;
  const result = await engine.completeOAuthManually(callbackUrl);
  await pendingPromise;
  assert.equal(result.switched, false);
  assert.match(result.switchError, /launch failed/);
  assert.equal(engine.currentAcct().id, previous.id);
  assert.equal(result.authState.status, "unknown");
  assert.equal(result.authState.requiresResolution, false);
  assert.notEqual(result.authState.status, "conflict");
});

test("Codex OAuth reauth of the same account does not switch away", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "ham@example.com", "acct-ham", "ham");
  const other = await addAccount(engine, "other@example.com", "acct-other", "other");
  await engine.doSwitch(current);
  assert.equal(engine.currentAcct().id, current.id);

  const pendingPromise = engine.oauthLoginFlow({
    openBrowser: false,
    targetAccountId: other.id,
    exchangeCode: async () => tokens("other@example.com", "acct-other", "other-reauth"),
  });
  const pendingPath = require("../engine/oauth").PENDING_PATH;
  const startedAt = Date.now();
  while (!fs.existsSync(pendingPath) && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const envelope = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  const decoded = JSON.parse(Buffer.from(envelope.protected_payload, "base64").toString("utf8"));
  const callbackUrl = `${decoded.redirectUri}?code=oauth-code&state=${decoded.state}`;
  const result = await engine.completeOAuthManually(callbackUrl);
  await pendingPromise;
  assert.equal(result.account.id, other.id);
  assert.equal(result.mismatch, false);
  assert.equal(engine.currentAcct().id, current.id);
  assert.equal(!!result.switched, false);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, current.id);
  assert.equal(engine.getOAuthStatus().result.authState.status, "aligned");
});

test("persistent logger removes credentials and personal email from messages", t => {
  freshEngine(t);
  const { sanitizeMessage } = require("../engine/logger");
  const value = sanitizeMessage("Bearer secret access_token=abc user@example.com code=oauth-code");
  assert.equal(value.includes("secret"), false);
  assert.equal(value.includes("abc"), false);
  assert.equal(value.includes("user@example.com"), false);
  assert.equal(value.includes("oauth-code"), false);
});

test("old log files still expire after a transient stat lock", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const logDir = path.join(config.DATA_DIR, "logs");
  engine.ensureDir(logDir);
  const oldPath = path.join(logDir, "app-2020-01-01.log");
  const keepPath = path.join(logDir, "app-2020-01-02.log");
  fs.writeFileSync(oldPath, "stale-log");
  fs.writeFileSync(keepPath, "recent-log");
  const past = (Date.now() - 4 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(oldPath, past, past);
  const originalStat = fs.statSync;
  let failures = 0;
  fs.statSync = (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(oldPath) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalStat(file, ...args);
  };
  t.after(() => { fs.statSync = originalStat; });
  const { cleanupLogs } = require("../engine/logger");
  cleanupLogs();
  assert.equal(failures, 2);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(keepPath), true);
});

test("old log files still expire after a transient directory listing lock", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const logDir = path.join(config.DATA_DIR, "logs");
  engine.ensureDir(logDir);
  const oldPath = path.join(logDir, "app-2020-01-01.log");
  const keepPath = path.join(logDir, "app-2020-01-02.log");
  fs.writeFileSync(oldPath, "stale-log");
  fs.writeFileSync(keepPath, "recent-log");
  const past = (Date.now() - 4 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(oldPath, past, past);
  const originalReaddir = fs.readdirSync;
  let failures = 0;
  fs.readdirSync = (dir, options) => {
    if (path.resolve(String(dir)) === path.resolve(logDir) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalReaddir(dir, options);
  };
  t.after(() => { fs.readdirSync = originalReaddir; });
  const { cleanupLogs } = require("../engine/logger");
  cleanupLogs();
  assert.equal(failures, 2);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(keepPath), true);
});

test("old log files still expire when existsSync reports the log directory missing", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const logDir = path.join(config.DATA_DIR, "logs");
  engine.ensureDir(logDir);
  const oldPath = path.join(logDir, "app-2020-01-01.log");
  const keepPath = path.join(logDir, "app-2020-01-02.log");
  fs.writeFileSync(oldPath, "stale-log");
  fs.writeFileSync(keepPath, "recent-log");
  const past = (Date.now() - 4 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(oldPath, past, past);
  const originalExists = fs.existsSync;
  fs.existsSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(logDir)) return false;
    return originalExists(file);
  };
  t.after(() => { fs.existsSync = originalExists; });
  const { cleanupLogs } = require("../engine/logger");
  cleanupLogs();
  fs.existsSync = originalExists;
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(keepPath), true);
});

test("app logs still start when creating the log directory is transiently locked", (t) => {
  freshEngine(t);
  const config = require("../engine/config");
  const logDir = path.join(config.DATA_DIR, "logs");
  const originalMkdir = fs.mkdirSync;
  let failures = 0;
  fs.mkdirSync = (dir, options) => {
    if (path.resolve(String(dir)) === path.resolve(logDir) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalMkdir(dir, options);
  };
  t.after(() => { fs.mkdirSync = originalMkdir; });
  const { logInfo, getLogDir } = require("../engine/logger");
  logInfo("mkdir-retry-ok");
  assert.equal(failures, 2);
  assert.equal(path.resolve(getLogDir()), path.resolve(logDir));
  const files = fs.readdirSync(logDir).filter((name) => name.startsWith("app-"));
  assert.ok(files.some((name) => fs.readFileSync(path.join(logDir, name), "utf8").includes("mkdir-retry-ok")));
});

test("app logs still write after a transient append lock", (t) => {
  freshEngine(t);
  const { logInfo, getLogDir } = require("../engine/logger");
  const logDir = getLogDir();
  const originalAppend = fs.appendFileSync;
  let failures = 0;
  fs.appendFileSync = (file, ...rest) => {
    if (path.dirname(path.resolve(String(file))) === path.resolve(logDir) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalAppend(file, ...rest);
  };
  t.after(() => { fs.appendFileSync = originalAppend; });
  logInfo("append-retry-ok");
  assert.equal(failures, 2);
  const files = fs.readdirSync(logDir).filter((name) => name.startsWith("app-"));
  assert.ok(files.some((name) => fs.readFileSync(path.join(logDir, name), "utf8").includes("append-retry-ok")));
});

test("auto-switch config normalization clamps user-edited values", t => {
  freshEngine(t);
  const { loadAutoSwitchCfg, saveAutoSwitchCfg } = require("../engine/config-manager");
  saveAutoSwitchCfg({
    enabled: 1,
    primary_threshold: 999,
    secondary_threshold: "not-a-number",
    account_scope_mode: "selected",
    selected_account_ids: ["  ", null, 42, "codex_valid"],
    sync_interval_minutes: -5,
  });
  const cfg = loadAutoSwitchCfg();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.primary_threshold, 100);
  assert.equal(cfg.secondary_threshold, 30);
  assert.equal(cfg.account_scope_mode, "selected");
  assert.deepEqual(cfg.selected_account_ids, ["42", "codex_valid"]);
  assert.equal(cfg.sync_interval_minutes, 1);
});

test("auto-switch default sync interval is one minute", t => {
  freshEngine(t);
  const { loadAutoSwitchCfg } = require("../engine/config-manager");
  assert.equal(loadAutoSwitchCfg().sync_interval_minutes, 1);
});

test("config resolves CODEX_HOME with quotes stripped and manager override first", t => {
  freshEngine(t);
  const config = require("../engine/config");
  const originalCodexHome = process.env.CODEX_HOME;
  t.after(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  process.env.CODEX_HOME = '"C:\\custom home\\codex"';
  assert.equal(config.resolveCodexHomeFromEnv(), "C:\\custom home\\codex");
  process.env.CODEX_HOME = "   ";
  assert.equal(config.resolveCodexHomeFromEnv(), null);
  delete process.env.CODEX_HOME;
  assert.equal(config.resolveCodexHomeFromEnv(), null);
  assert.equal(config.CODEX_DIR, process.env.CODEX_MANAGER_CODEX_DIR);
});

test("jwt identity extraction supports new claim key names", t => {
  freshEngine(t);
  const { extractChatgptAccountId, extractChatgptOrganizationId } = require("../engine/crypto-utils");
  const token = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-new-key",
      organizations: [{ id: "org-first" }, { id: "org-default", is_default: true }],
    },
  });
  assert.equal(extractChatgptAccountId(token), "acct-new-key");
  assert.equal(extractChatgptOrganizationId(token), "org-default");

  const explicitOrg = jwt({
    "https://api.openai.com/auth": { account_id: "acct-old", chatgpt_org_id: "org-explicit" },
  });
  assert.equal(extractChatgptAccountId(explicitOrg), "acct-old");
  assert.equal(extractChatgptOrganizationId(explicitOrg), "org-explicit");
});

test("error code extraction reads FastAPI-style detail objects", t => {
  freshEngine(t);
  const { extractErrorCode } = require("../engine/http-client");
  assert.equal(extractErrorCode(JSON.stringify({ detail: { code: "usage_not_found" } })), "usage_not_found");
  assert.equal(extractErrorCode(JSON.stringify({ error: { code: "token_revoked" } })), "token_revoked");
  assert.equal(extractErrorCode(JSON.stringify({ detail: "plain text" })), null);
});

test("token refresh sends a form-encoded OAuth request", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "form@example.com", "acct-form", "form");
  let captured = null;
  const refreshed = tokens("form@example.com", "acct-form", "form-next");
  const { refreshOneTok } = require("../engine/token-refresh");
  const result = await refreshOneTok(account, {
    force: true,
    httpJson: async (url, options) => {
      captured = { url, options };
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          id_token: refreshed.id_token,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
        }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.options.headers["Content-Type"], "application/x-www-form-urlencoded");
  const params = new URLSearchParams(captured.options.body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.ok(params.get("refresh_token"));
});

test("token refresh keeps the old refresh token when the new one is blank", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "blank-rt@example.com", "acct-blank-rt", "blank-rt");
  const previousRefresh = account.tokens.refresh_token;
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  const nextAccess = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const { refreshOneTok } = require("../engine/token-refresh");
  const result = await refreshOneTok(engine.loadAcct(account.id), {
    force: true,
    httpJson: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ access_token: nextAccess, refresh_token: "   " }),
    }),
  });
  assert.equal(result.ok, true);
  const stored = engine.loadAcct(account.id);
  assert.equal(stored.tokens.access_token, nextAccess);
  assert.equal(stored.tokens.refresh_token, previousRefresh);
  assert.notEqual(stored.tokens.refresh_token, "   ");
  assert.equal(stored.requires_reauth, false);
});

test("token refresh still rotates when a new refresh token is present", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "rotate-rt@example.com", "acct-rotate-rt", "rotate-rt");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  const next = tokens("rotate-rt@example.com", "acct-rotate-rt", "rotate-rt-next");
  const { refreshOneTok } = require("../engine/token-refresh");
  const result = await refreshOneTok(engine.loadAcct(account.id), {
    force: true,
    httpJson: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        id_token: next.id_token,
        access_token: next.access_token,
        refresh_token: next.refresh_token,
      }),
    }),
  });
  assert.equal(result.ok, true);
  const stored = engine.loadAcct(account.id);
  assert.equal(stored.tokens.refresh_token, "refresh-rotate-rt-next");
  assert.equal(stored.requires_reauth, false);
});

test("token refresh backs off after a network miss and does not replay until then", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "token-net-retry@example.com", "acct-token-net-retry", "token-net-retry");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  let calls = 0;
  const { refreshOneTok } = require("../engine/token-refresh");
  const request = async () => {
    calls += 1;
    const error = new Error("getaddrinfo ENOTFOUND auth.openai.com");
    error.code = "ENOTFOUND";
    throw error;
  };
  const first = await refreshOneTok(engine.loadAcct(account.id), { force: true, httpJson: request });
  assert.equal(first.ok, false);
  assert.equal(first.revoked, false);
  assert.match(first.error, /ENOTFOUND/);
  const stored = engine.loadAcct(account.id);
  assert.equal(stored.requires_reauth, false);
  assert.ok(Number(stored.token_next_retry_at) > Math.floor(Date.now() / 1000));
  const second = await refreshOneTok(engine.loadAcct(account.id), { force: false, httpJson: request });
  assert.equal(second.ok, false);
  assert.match(second.error, /ENOTFOUND/);
  assert.equal(calls, 1);
});

test("token refresh backs off after HTTP 500 and does not replay until then", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "token-500-retry@example.com", "acct-token-500-retry", "token-500-retry");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  let calls = 0;
  const { refreshOneTok } = require("../engine/token-refresh");
  const request = async () => {
    calls += 1;
    return { status: 500, headers: {}, body: JSON.stringify({ error: "temporarily_unavailable" }) };
  };
  const first = await refreshOneTok(engine.loadAcct(account.id), { force: true, httpJson: request });
  assert.equal(first.ok, false);
  assert.equal(first.revoked, false);
  assert.match(first.error, /500/);
  const stored = engine.loadAcct(account.id);
  assert.equal(stored.requires_reauth, false);
  assert.ok(Number(stored.token_next_retry_at) > Math.floor(Date.now() / 1000));
  const second = await refreshOneTok(engine.loadAcct(account.id), { force: false, httpJson: request });
  assert.equal(second.ok, false);
  assert.match(second.error, /500/);
  assert.equal(calls, 1);
});

test("token refresh honors Retry-After on HTTP 429 and does not replay until then", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "token-429@example.com", "acct-token-429", "token-429");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  let calls = 0;
  const { refreshOneTok } = require("../engine/token-refresh");
  const request = async () => {
    calls += 1;
    return { status: 429, headers: { "retry-after": "45" }, body: "rate limited" };
  };
  const first = await refreshOneTok(engine.loadAcct(account.id), { force: true, httpJson: request });
  assert.equal(first.ok, false);
  assert.equal(first.revoked, false);
  assert.match(first.error, /429/);
  const stored = engine.loadAcct(account.id);
  assert.equal(stored.requires_reauth, false);
  const delay = Number(stored.token_next_retry_at) - Math.floor(Date.now() / 1000);
  assert.ok(delay >= 45 && delay <= 90, `Retry-After 45s should beat the 15-minute default, got ${delay}s`);
  const second = await refreshOneTok(engine.loadAcct(account.id), { force: false, httpJson: request });
  assert.equal(second.ok, false);
  assert.match(second.error, /429/);
  assert.equal(calls, 1);
  const third = await refreshOneTok(engine.loadAcct(account.id), { force: true, httpJson: request });
  assert.equal(third.ok, false);
  assert.equal(calls, 2);
});

test("token refresh honors a fractional Retry-After on HTTP 429", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "token-429-frac@example.com", "acct-token-429-frac", "token-429-frac");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  let calls = 0;
  const { refreshOneTok } = require("../engine/token-refresh");
  const request = async () => {
    calls += 1;
    return { status: 429, headers: { "retry-after": "45.2" }, body: "rate limited" };
  };
  const first = await refreshOneTok(engine.loadAcct(account.id), { force: true, httpJson: request });
  assert.equal(first.ok, false);
  assert.equal(first.revoked, false);
  const stored = engine.loadAcct(account.id);
  const delay = Number(stored.token_next_retry_at) - Math.floor(Date.now() / 1000);
  assert.ok(delay >= 45 && delay <= 90, `fractional Retry-After 45.2s should beat the 15-minute default, got ${delay}s`);
  const second = await refreshOneTok(engine.loadAcct(account.id), { force: false, httpJson: request });
  assert.equal(second.ok, false);
  assert.equal(calls, 1);
});

test("token refresh treats an HTML interstitial as a temporary miss", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "html-token@example.com", "acct-html-token", "html-token");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  const { refreshOneTok } = require("../engine/token-refresh");
  const result = await refreshOneTok(engine.loadAcct(account.id), {
    force: true,
    httpJson: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<!DOCTYPE html><html><body>captive portal</body></html>",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.revoked, false);
  assert.equal(result.reauthRequired, undefined);
  assert.match(result.error, /响应不是 JSON/);
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.requires_reauth, false);
  assert.ok(Number(persisted.token_next_retry_at) > Math.floor(Date.now() / 1000));
  let calls = 0;
  const again = await refreshOneTok(engine.loadAcct(account.id), {
    force: false,
    httpJson: async () => {
      calls += 1;
      return { status: 200, body: "<html></html>" };
    },
  });
  assert.equal(again.ok, false);
  assert.equal(calls, 0);
});

test("token refresh backs off after an empty JSON 200 and does not replay until then", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "empty-token@example.com", "acct-empty-token", "empty-token");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  let calls = 0;
  const { refreshOneTok } = require("../engine/token-refresh");
  const request = async () => {
    calls += 1;
    return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
  };
  const first = await refreshOneTok(engine.loadAcct(account.id), { force: true, httpJson: request });
  assert.equal(first.ok, false);
  assert.equal(first.revoked, false);
  assert.equal(first.reauthRequired, undefined);
  assert.match(first.error, /响应无 access_token/);
  const stored = engine.loadAcct(account.id);
  assert.equal(stored.requires_reauth, false);
  assert.ok(Number(stored.token_next_retry_at) > Math.floor(Date.now() / 1000));
  const second = await refreshOneTok(engine.loadAcct(account.id), { force: false, httpJson: request });
  assert.equal(second.ok, false);
  assert.match(second.error, /响应无 access_token/);
  assert.equal(calls, 1);
});

test("token refresh treats a blank access_token as a temporary miss", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "blank-token@example.com", "acct-blank-token", "blank-token");
  const expired = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  account.tokens.access_token = expired;
  engine.saveAcct(account);
  let calls = 0;
  const { refreshOneTok } = require("../engine/token-refresh");
  const request = async () => {
    calls += 1;
    return { status: 200, headers: {}, body: JSON.stringify({ access_token: "   " }) };
  };
  const first = await refreshOneTok(engine.loadAcct(account.id), { force: true, httpJson: request });
  assert.equal(first.ok, false);
  assert.equal(first.revoked, false);
  assert.match(first.error, /响应无 access_token/);
  const stored = engine.loadAcct(account.id);
  assert.equal(stored.requires_reauth, false);
  assert.equal(stored.tokens.access_token, expired);
  assert.ok(Number(stored.token_next_retry_at) > Math.floor(Date.now() / 1000));
  const second = await refreshOneTok(engine.loadAcct(account.id), { force: false, httpJson: request });
  assert.equal(second.ok, false);
  assert.equal(calls, 1);
});

test("token refresh still marks reauth when HTTP 200 JSON carries invalid_grant", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "empty-grant@example.com", "acct-empty-grant", "empty-grant");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  const { refreshOneTok } = require("../engine/token-refresh");
  const result = await refreshOneTok(engine.loadAcct(account.id), {
    force: true,
    httpJson: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ error: "invalid_grant" }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.revoked, true);
  assert.equal(result.reauthRequired, true);
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.requires_reauth, true);
  assert.ok(!persisted.token_next_retry_at);
});

test("an invalid_refresh_token error marks the account for reauthorization", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "invalid-rt@example.com", "acct-invalid-rt", "invalid-rt");
  const { refreshOneTok } = require("../engine/token-refresh");
  const result = await refreshOneTok(account, {
    force: true,
    httpJson: async () => ({
      status: 401,
      headers: {},
      body: JSON.stringify({ error: "invalid_refresh_token" }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.revoked, true);
  assert.equal(result.reauthRequired, true);
  assert.equal(result.code, "invalid_refresh_token");
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.requires_reauth, true);
  assert.equal(persisted.quota_error.code, "invalid_refresh_token");
});

test("token refresh treats invalidated-token text errors as reauthorization", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "text-reauth@example.com", "acct-text-reauth", "text-reauth");
  const { refreshOneTok } = require("../engine/token-refresh");
  const result = await refreshOneTok(account, {
    force: true,
    httpJson: async () => ({
      status: 400,
      headers: {},
      body: JSON.stringify({ message: "Authentication token has been invalidated." }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.revoked, true);
  assert.equal(engine.loadAcct(account.id).requires_reauth, true);
});

test("a missing refresh token flag clears once a refresh token is available", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "heal@example.com", "acct-heal", "heal");
  account.tokens.refresh_token = null;
  engine.saveAcct(account);
  const { refreshOneTok } = require("../engine/token-refresh");
  const failed = await refreshOneTok(account, {
    force: true,
    httpJson: async () => { throw new Error("refresh endpoint should not be called"); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "missing_refresh_token");
  assert.equal(engine.loadAcct(account.id).requires_reauth, true);

  const healedAccount = engine.loadAcct(account.id);
  healedAccount.tokens.refresh_token = "refresh-restored";
  engine.saveAcct(healedAccount);
  const refreshed = tokens("heal@example.com", "acct-heal", "heal-next");
  const result = await refreshOneTok(healedAccount, {
    force: true,
    httpJson: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        id_token: refreshed.id_token,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
      }),
    }),
  });
  assert.equal(result.ok, true);
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.requires_reauth, false);
  assert.equal(persisted.quota_error, null);
});

test("adding the same identity merges into the existing account record", async t => {
  const { engine } = freshEngine(t);
  const original = (await engine.upsert(tokens("merge@example.com", "acct-merge", "merge-one"))).account;
  const payload = {
    email: "merge@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      account_id: "acct-merge",
      chatgpt_org_id: "org-merge",
      organizations: [],
    },
  };
  const orgTokens = { id_token: jwt(payload), access_token: jwt(payload), refresh_token: "refresh-merge-two" };
  const result = await engine.upsert(orgTokens);
  assert.equal(result.account.id, original.id);
  assert.equal(engine.listAccts().length, 1);
});

test("JSON pending reads retry when the file is transiently locked", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { readJsonWithRetry } = require("../engine/atomic-file");
  const target = path.join(config.DATA_DIR, "pending-retry.json");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(target, JSON.stringify({ ok: true }), "utf8");

  const originalRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(target) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });

  assert.deepEqual(readJsonWithRetry(target), { ok: true });
  assert.equal(failures, 2);

  fs.readFileSync = () => {
    const error = new Error("ENOSPC: no space");
    error.code = "ENOSPC";
    throw error;
  };
  assert.throws(() => readJsonWithRetry(target), /ENOSPC/);
});

test("file captures retry when the source is transiently locked", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { captureFile, readFileWithRetry } = require("../engine/atomic-file");
  const target = path.join(config.DATA_DIR, "capture-retry.bin");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(target, "snapshot-bytes");

  const originalRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(target) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });

  assert.equal(captureFile(target).toString("utf8"), "snapshot-bytes");
  assert.equal(failures, 2);
  assert.equal(readFileWithRetry(target, "utf8"), "snapshot-bytes");

  fs.readFileSync = () => {
    const error = new Error("ENOSPC: no space");
    error.code = "ENOSPC";
    throw error;
  };
  assert.throws(() => captureFile(target), /ENOSPC/);
});

test("file captures still snapshot when existsSync reports the source missing", (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { captureFile } = require("../engine/atomic-file");
  const target = path.join(config.DATA_DIR, "capture-exists-lie.bin");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(target, "snapshot-bytes");
  const originalExists = fs.existsSync;
  fs.existsSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(target)) return false;
    return originalExists(file);
  };
  t.after(() => { fs.existsSync = originalExists; });
  assert.equal(captureFile(target).toString("utf8"), "snapshot-bytes");
});

test("pathExists retries transient stat locks and ignores existsSync", (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { pathExists } = require("../engine/atomic-file");
  const target = path.join(config.DATA_DIR, "path-exists-retry.bin");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(target, "present");
  const originalExists = fs.existsSync;
  const originalStat = fs.statSync;
  let failures = 0;
  fs.existsSync = () => false;
  fs.statSync = (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(target) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalStat(file, ...args);
  };
  t.after(() => {
    fs.existsSync = originalExists;
    fs.statSync = originalStat;
  });
  assert.equal(pathExists(target), true);
  assert.equal(failures, 2);
});

test("Cursor account index retries a transient lock instead of rebuilding", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "idx-retry@example.com",
    auth_id: "user_idx_retry",
    access_token: jwt({
      email: "idx-retry@example.com",
      sub: "user_idx_retry",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-idx-retry",
  });
  const config = require("../engine/config");
  const rawIndex = JSON.parse(fs.readFileSync(config.CURSOR_IDX_PATH, "utf8"));
  rawIndex.accounts.push({ id: "cursor_marker_not_a_file", email: "marker@example.com" });
  fs.writeFileSync(config.CURSOR_IDX_PATH, `${JSON.stringify(rawIndex, null, 2)}\n`);
  const originalRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(config.CURSOR_IDX_PATH) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const index = engine.loadCursorIdx();
  assert.equal(index.accounts.some((item) => item.id === created.account.id), true);
  assert.equal(index.accounts.some((item) => item.id === "cursor_marker_not_a_file"), true);
  assert.equal(failures, 2);
});

test("auto-switch config does not restore a stale backup after a leftover lock", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(config.CFG_FILE, JSON.stringify({ enabled: true, primary_threshold: 15 }), "utf8");
  fs.writeFileSync(`${config.CFG_FILE}.bak`, JSON.stringify({ enabled: false, primary_threshold: 99 }), "utf8");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(config.CFG_FILE)) {
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  assert.throws(
    () => engine.loadAutoSwitchCfg(),
    (error) => error.code === "EPERM" && error.transientIoError === true,
  );
  fs.readFileSync = originalRead;
  assert.equal(JSON.parse(fs.readFileSync(config.CFG_FILE, "utf8")).enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(config.CFG_FILE, "utf8")).primary_threshold, 15);
  assert.equal(JSON.parse(fs.readFileSync(`${config.CFG_FILE}.bak`, "utf8")).enabled, false);
});

test("auto-switch config does not restore a stale backup on a non-JSON filesystem error", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(config.CFG_FILE, JSON.stringify({ enabled: true, primary_threshold: 15 }), "utf8");
  fs.writeFileSync(`${config.CFG_FILE}.bak`, JSON.stringify({ enabled: false, primary_threshold: 99 }), "utf8");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(config.CFG_FILE)) {
      const error = new Error("EISDIR: illegal operation on a directory");
      error.code = "EISDIR";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  assert.throws(
    () => engine.loadAutoSwitchCfg(),
    (error) => error.code === "EISDIR",
  );
  fs.readFileSync = originalRead;
  assert.equal(JSON.parse(fs.readFileSync(config.CFG_FILE, "utf8")).enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(config.CFG_FILE, "utf8")).primary_threshold, 15);
  assert.equal(JSON.parse(fs.readFileSync(`${config.CFG_FILE}.bak`, "utf8")).enabled, false);
});

test("auto-switch config retries a transient lock instead of resetting", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(config.CFG_FILE, JSON.stringify({ enabled: true, primary_threshold: 15 }), "utf8");
  const originalRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(config.CFG_FILE) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const cfg = engine.loadAutoSwitchCfg();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.primary_threshold, 15);
  assert.equal(failures, 2);
});

test("network proxy state retries a transient lock instead of dropping lastGood", t => {
  const { engine } = freshEngine(t);
  const { loadNetworkState, NETWORK_FILE } = require("../engine/proxy-resolve");
  engine.ensureDir(path.dirname(NETWORK_FILE));
  fs.writeFileSync(NETWORK_FILE, JSON.stringify({ lastGood: { source: "env", proxyUrl: "http://127.0.0.1:7890" } }), "utf8");
  const originalRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(NETWORK_FILE) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const state = loadNetworkState();
  assert.equal(state.lastGood.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(failures, 2);
});

test("network proxy state still loads lastGood when the first JSON parse is torn", (t) => {
  const { engine } = freshEngine(t);
  const { loadNetworkState, NETWORK_FILE } = require("../engine/proxy-resolve");
  engine.ensureDir(path.dirname(NETWORK_FILE));
  fs.writeFileSync(NETWORK_FILE, JSON.stringify({ lastGood: { source: "env", proxyUrl: "http://127.0.0.1:7890" } }), "utf8");
  stubTornJsonReads(t, NETWORK_FILE);
  const state = loadNetworkState();
  assert.equal(state.lastGood.proxyUrl, "http://127.0.0.1:7890");
});

test("network proxy state restores lastGood from backup after persistent corruption", (t) => {
  const { engine } = freshEngine(t);
  const { loadNetworkState, NETWORK_FILE } = require("../engine/proxy-resolve");
  engine.ensureDir(path.dirname(NETWORK_FILE));
  const good = { lastGood: { source: "env", proxyUrl: "http://127.0.0.1:7890" } };
  fs.writeFileSync(`${NETWORK_FILE}.bak`, JSON.stringify(good), "utf8");
  fs.writeFileSync(NETWORK_FILE, "{ corrupted", "utf8");
  const state = loadNetworkState();
  assert.equal(state.lastGood.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(JSON.parse(fs.readFileSync(NETWORK_FILE, "utf8")).lastGood.proxyUrl, "http://127.0.0.1:7890");
});

test("network proxy state does not restore a stale backup on a non-JSON filesystem error", (t) => {
  const { engine } = freshEngine(t);
  const { loadNetworkState, persistLastGood, NETWORK_FILE } = require("../engine/proxy-resolve");
  engine.ensureDir(path.dirname(NETWORK_FILE));
  const good = { lastGood: { source: "env", proxyUrl: "http://127.0.0.1:7890" }, keep: "primary" };
  fs.writeFileSync(NETWORK_FILE, JSON.stringify(good), "utf8");
  fs.writeFileSync(`${NETWORK_FILE}.bak`, JSON.stringify({
    lastGood: { source: "env", proxyUrl: "http://127.0.0.1:1" },
    keep: "stale",
  }), "utf8");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(NETWORK_FILE)) {
      const error = new Error("EISDIR: illegal operation on a directory");
      error.code = "EISDIR";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const state = loadNetworkState();
  assert.equal(state.lastGood, undefined);
  persistLastGood({ source: "env", proxyUrl: "http://127.0.0.1:9" });
  fs.readFileSync = originalRead;
  assert.deepEqual(JSON.parse(fs.readFileSync(NETWORK_FILE, "utf8")), good);
  assert.equal(JSON.parse(fs.readFileSync(`${NETWORK_FILE}.bak`, "utf8")).keep, "stale");
});

test("a failed lastGood proxy is forgotten so the next resolve can go elsewhere", (t) => {
  const { engine } = freshEngine(t);
  const { persistLastGood, markProxyFailed, loadNetworkState, resetFailedProxiesForTests, NETWORK_FILE } = require("../engine/proxy-resolve");
  engine.ensureDir(path.dirname(NETWORK_FILE));
  persistLastGood({ source: "env", proxyUrl: "http://127.0.0.1:7890" });
  assert.equal(loadNetworkState().lastGood.proxyUrl, "http://127.0.0.1:7890");
  markProxyFailed("http://127.0.0.1:7890");
  assert.equal(loadNetworkState().lastGood, null);
  resetFailedProxiesForTests();
});

test("network proxy state ignores a stale backup when the file is missing", (t) => {
  const { engine } = freshEngine(t);
  const { loadNetworkState, NETWORK_FILE } = require("../engine/proxy-resolve");
  engine.ensureDir(path.dirname(NETWORK_FILE));
  fs.writeFileSync(`${NETWORK_FILE}.bak`, JSON.stringify({
    lastGood: { source: "env", proxyUrl: "http://127.0.0.1:1" },
  }), "utf8");
  const state = loadNetworkState();
  assert.equal(state.lastGood, undefined);
});

test("Cursor http.proxy survives a transient settings lock", async (t) => {
  const { engine } = freshEngine(t);
  const previousAppdata = process.env.APPDATA;
  const config = require("../engine/config");
  const appdata = path.join(config.DATA_DIR, "appdata-cursor-proxy");
  const settingsDir = path.join(appdata, "Cursor", "User");
  engine.ensureDir(settingsDir);
  const settingsPath = path.join(settingsDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ "http.proxy": "http://127.0.0.1:17890" }), "utf8");
  process.env.APPDATA = appdata;
  t.after(() => {
    process.env.APPDATA = previousAppdata;
  });
  const originalRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(settingsPath) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const { collectCandidates } = require("../engine/proxy-resolve");
  const found = await collectCandidates("https://chatgpt.com/", {
    windows: { enabled: false, server: "" },
    extraPorts: [],
    pacRule: "",
  });
  assert.ok(found.some((item) => item.source === "cursor" && item.proxyUrl === "http://127.0.0.1:17890"));
  assert.equal(failures, 2);
});

test("Cursor http.proxy still loads when the first JSON parse sees a torn write", async (t) => {
  const { engine } = freshEngine(t);
  const previousAppdata = process.env.APPDATA;
  const config = require("../engine/config");
  const appdata = path.join(config.DATA_DIR, "appdata-cursor-proxy-torn");
  const settingsDir = path.join(appdata, "Cursor", "User");
  engine.ensureDir(settingsDir);
  const settingsPath = path.join(settingsDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ "http.proxy": "http://127.0.0.1:17890" }), "utf8");
  process.env.APPDATA = appdata;
  t.after(() => {
    process.env.APPDATA = previousAppdata;
  });
  stubTornJsonReads(t, settingsPath);
  const { collectCandidates } = require("../engine/proxy-resolve");
  const found = await collectCandidates("https://chatgpt.com/", {
    windows: { enabled: false, server: "" },
    extraPorts: [],
    pacRule: "",
  });
  assert.ok(found.some((item) => item.source === "cursor" && item.proxyUrl === "http://127.0.0.1:17890"));
});

test("Cursor http.proxy still reads JSONC settings after parse retries", async (t) => {
  const { engine } = freshEngine(t);
  const previousAppdata = process.env.APPDATA;
  const config = require("../engine/config");
  const appdata = path.join(config.DATA_DIR, "appdata-cursor-proxy-jsonc");
  const settingsDir = path.join(appdata, "Cursor", "User");
  engine.ensureDir(settingsDir);
  const settingsPath = path.join(settingsDir, "settings.json");
  fs.writeFileSync(settingsPath, `{
  // Cursor JSONC
  "http.proxy": "http://127.0.0.1:17890",
}`, "utf8");
  process.env.APPDATA = appdata;
  t.after(() => {
    process.env.APPDATA = previousAppdata;
  });
  const { collectCandidates } = require("../engine/proxy-resolve");
  const found = await collectCandidates("https://chatgpt.com/", {
    windows: { enabled: false, server: "" },
    extraPorts: [],
    pacRule: "",
  });
  assert.ok(found.some((item) => item.source === "cursor" && item.proxyUrl === "http://127.0.0.1:17890"));
});

test("atomic writes retry when the target file is transiently locked", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { writeTextAtomic } = require("../engine/atomic-file");
  const target = path.join(config.DATA_DIR, "retry-target.json");
  engine.ensureDir(config.DATA_DIR);

  const originalRename = fs.renameSync;
  let failures = 0;
  fs.renameSync = (from, to) => {
    if (path.resolve(to) === path.resolve(target) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRename(from, to);
  };
  t.after(() => { fs.renameSync = originalRename; });

  writeTextAtomic(target, "retried content");
  assert.equal(failures, 2);
  assert.equal(fs.readFileSync(target, "utf8"), "retried content");

  fs.renameSync = () => {
    const error = new Error("ENOSPC: no space");
    error.code = "ENOSPC";
    throw error;
  };
  assert.throws(() => writeTextAtomic(target, "should fail"), /ENOSPC/);
});

test("atomic writes retry when creating the parent directory is transiently locked", (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { writeTextAtomic } = require("../engine/atomic-file");
  engine.ensureDir(config.DATA_DIR);
  const target = path.join(config.DATA_DIR, "mkdir-lock", "target.json");
  const parent = path.dirname(target);
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
  writeTextAtomic(target, "mkdir-retried");
  assert.equal(failures, 2);
  assert.equal(fs.readFileSync(target, "utf8"), "mkdir-retried");
});

test("atomic writes retry when opening the temp file is transiently locked", (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { writeTextAtomic } = require("../engine/atomic-file");
  const target = path.join(config.DATA_DIR, "open-retry-target.json");
  engine.ensureDir(config.DATA_DIR);
  const originalOpen = fs.openSync;
  let failures = 0;
  fs.openSync = (file, flags, ...rest) => {
    if (String(file).includes(`${path.basename(target)}.tmp.`) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalOpen(file, flags, ...rest);
  };
  t.after(() => { fs.openSync = originalOpen; });
  writeTextAtomic(target, "open-retried");
  assert.equal(failures, 2);
  assert.equal(fs.readFileSync(target, "utf8"), "open-retried");
});

test("atomic writes retry when closing the temp file is transiently locked", (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { writeTextAtomic } = require("../engine/atomic-file");
  const target = path.join(config.DATA_DIR, "close-retry-target.json");
  engine.ensureDir(config.DATA_DIR);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let tempFd = null;
  let failures = 0;
  fs.openSync = (file, flags, ...rest) => {
    const fd = originalOpen(file, flags, ...rest);
    if (String(file).includes(`${path.basename(target)}.tmp.`)) tempFd = fd;
    return fd;
  };
  fs.closeSync = (fd) => {
    if (fd === tempFd && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalClose(fd);
  };
  t.after(() => {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  });
  writeTextAtomic(target, "close-retried");
  assert.equal(failures, 2);
  assert.equal(fs.readFileSync(target, "utf8"), "close-retried");
});

test("Codex auth.json still writes when creating the Codex home is transiently locked", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "mkdir-auth@example.com", "acct-mkdir-auth", "mkdir-auth");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  const originalMkdir = fs.mkdirSync;
  let failures = 0;
  fs.mkdirSync = (dir, options) => {
    if (path.resolve(String(dir)) === path.resolve(config.CODEX_DIR) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalMkdir(dir, options);
  };
  t.after(() => { fs.mkdirSync = originalMkdir; });
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  assert.equal(failures, 2);
  assert.equal(engine.inspectAuthState({ migrateProjection: false }).status, "aligned");
});

test("a Codex account still saves quota when creating the accounts directory is transiently locked", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "mkdir-acct@example.com", "acct-mkdir-acct", "mkdir-acct");
  const config = require("../engine/config");
  const originalMkdir = fs.mkdirSync;
  let failures = 0;
  fs.mkdirSync = (dir, options) => {
    if (path.resolve(String(dir)) === path.resolve(config.ACCTS_DIR) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalMkdir(dir, options);
  };
  t.after(() => { fs.mkdirSync = originalMkdir; });
  account.quota = {
    hourly_remaining_percentage: null,
    hourly_window_present: false,
    weekly_remaining_percentage: 70,
    weekly_window_present: true,
  };
  engine.saveAcct(account);
  assert.equal(failures, 2);
  assert.equal(engine.loadAcct(account.id).quota.weekly_remaining_percentage, 70);
});

test("atomic write cleanup retries a locked temp file instead of leaving it behind", (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { writeTextAtomic } = require("../engine/atomic-file");
  const target = path.join(config.DATA_DIR, "cleanup-target.json");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(target, "keep-me", "utf8");

  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  let unlinkFailures = 0;
  fs.renameSync = (from, to) => {
    if (path.resolve(to) === path.resolve(target)) {
      const error = new Error("ENOSPC: no space");
      error.code = "ENOSPC";
      throw error;
    }
    return originalRename(from, to);
  };
  fs.unlinkSync = (file) => {
    if (String(file).includes(`${path.basename(target)}.tmp.`) && unlinkFailures < 2) {
      unlinkFailures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalUnlink(file);
  };
  t.after(() => {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
  });

  assert.throws(() => writeTextAtomic(target, "should fail"), (error) => error.code === "ENOSPC");
  assert.equal(unlinkFailures, 2);
  const leftover = fs.readdirSync(config.DATA_DIR).filter((name) => name.includes(".tmp."));
  assert.deepEqual(leftover, []);
  assert.equal(fs.readFileSync(target, "utf8"), "keep-me");
});

test("atomic writes retry when the backup copy is transiently locked", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { writeTextAtomic } = require("../engine/atomic-file");
  const target = path.join(config.DATA_DIR, "copy-retry-target.json");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(target, "original");

  const originalCopy = fs.copyFileSync;
  let failures = 0;
  fs.copyFileSync = (from, to, ...rest) => {
    if (path.resolve(from) === path.resolve(target) && String(to).endsWith(".bak") && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalCopy(from, to, ...rest);
  };
  t.after(() => { fs.copyFileSync = originalCopy; });

  writeTextAtomic(target, "updated");
  assert.equal(failures, 2);
  assert.equal(fs.readFileSync(target, "utf8"), "updated");
  assert.equal(fs.readFileSync(`${target}.bak`, "utf8"), "original");
});

test("atomic writes still back up the previous file when existsSync reports it missing", (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  const { writeTextAtomic } = require("../engine/atomic-file");
  const target = path.join(config.DATA_DIR, "copy-exists-lie.json");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(target, "original");
  const originalExists = fs.existsSync;
  fs.existsSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(target)) return false;
    return originalExists(file);
  };
  t.after(() => { fs.existsSync = originalExists; });
  writeTextAtomic(target, "updated");
  assert.equal(fs.readFileSync(target, "utf8"), "updated");
  assert.equal(fs.readFileSync(`${target}.bak`, "utf8"), "original");
});

test("auth state reports an official agent identity as unsupported with identity details", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "agent@example.com", "acct-agent", "agent");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  fs.mkdirSync(config.CODEX_DIR, { recursive: true });
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify({
    agentIdentity: {
      agentRuntimeId: "runtime-1",
      agentPrivateKey: "private-key",
      accountId: "acct-agent-official",
      chatgptUserId: "user-agent",
      email: "agent-official@example.com",
    },
  }), "utf8");

  const state = engine.inspectAuthState();
  assert.equal(state.status, "unsupported_official_auth");
  assert.equal(state.requiresResolution, true);
  assert.match(state.message, /agent identity/i);
  assert.equal(state.officialIdentity.email, "agent-official@example.com");
  assert.equal(state.officialIdentity.accountId, "acct-agent-official");
});

test("transient read errors do not quarantine account files or drop them from the index", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "locked@example.com", "acct-locked", "locked");
  engine.listAccts();
  const filePath = engine.accountFilePath(account.id);

  const originalRead = fs.readFileSync;
  fs.readFileSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(filePath)) {
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(target, ...rest);
  };
  t.after(() => { fs.readFileSync = originalRead; });

  assert.equal(engine.loadAcct(account.id), null);
  assert.equal(fs.existsSync(filePath), true, "a locked file must not be quarantined");
  const accounts = engine.listAccts();
  assert.equal(accounts.some(item => item.id === account.id), false);
  assert.ok(engine.loadIdx().accounts.some(item => item.id === account.id),
    "a transiently locked account must stay in the index");

  fs.readFileSync = originalRead;
  assert.equal(engine.loadAcct(account.id).email, "locked@example.com");
});

test("a non-JSON filesystem error does not quarantine a Codex account file", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "acct-fs@example.com", "acct-acct-fs", "acct-fs");
  const filePath = engine.accountFilePath(account.id);
  const original = fs.readFileSync(filePath, "utf8");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(filePath)) {
      const error = new Error("EISDIR: illegal operation on a directory");
      error.code = "EISDIR";
      throw error;
    }
    return originalRead(target, ...rest);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  assert.equal(engine.loadAcct(account.id), null);
  fs.readFileSync = originalRead;
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
  assert.equal(engine.loadAcct(account.id).email, "acct-fs@example.com");
  assert.ok(engine.loadIdx().accounts.some((item) => item.id === account.id));
});

test("a present Codex account still loads when existsSync reports it missing", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "exists-lie@example.com", "acct-exists-lie", "exists-lie");
  const filePath = engine.accountFilePath(account.id);
  const originalExists = fs.existsSync;
  fs.existsSync = (target) => {
    if (path.resolve(String(target)) === path.resolve(filePath)) return false;
    return originalExists(target);
  };
  t.after(() => { fs.existsSync = originalExists; });
  const loaded = engine.loadAcct(account.id);
  assert.equal(loaded.email, "exists-lie@example.com");
  assert.equal(engine.loadIdx().accounts.some((item) => item.id === account.id), true);
});

test("a locked Codex index is not treated as missing and rebuilt empty", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "idx-lock@example.com", "acct-idx-lock", "idx-lock");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  const originalExists = fs.existsSync;
  fs.existsSync = (target) => {
    if (path.resolve(String(target)) === path.resolve(config.IDX_PATH)) return false;
    return originalExists(target);
  };
  t.after(() => { fs.existsSync = originalExists; });
  const loaded = engine.loadIdx();
  assert.equal(loaded.current_account_id, account.id);
  assert.ok(loaded.accounts.some((item) => item.id === account.id));
});

test("a Codex index rebuild retries a locked accounts directory", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "readdir-lock@example.com", "acct-readdir-lock", "readdir-lock");
  const config = require("../engine/config");
  fs.unlinkSync(config.IDX_PATH);
  try { fs.unlinkSync(`${config.IDX_PATH}.bak`); } catch {}
  const originalReaddir = fs.readdirSync;
  let failures = 0;
  fs.readdirSync = (dir, options) => {
    if (path.resolve(String(dir)) === path.resolve(config.ACCTS_DIR) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalReaddir(dir, options);
  };
  t.after(() => { fs.readdirSync = originalReaddir; });
  const loaded = engine.loadIdx();
  assert.equal(failures, 2);
  assert.ok(loaded.accounts.some((item) => item.id === account.id));
  assert.equal(engine.loadAcct(account.id).email, "readdir-lock@example.com");
});

test("upserting the first Codex account does not mark it current", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "idx-first-upsert@example.com", "acct-idx-first-upsert", "idx-first-upsert");
  assert.equal(engine.currentAcct(), null);
  assert.equal(engine.loadIdx().current_account_id, null);
  assert.ok(engine.loadIdx().accounts.some((item) => item.id === account.id));
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.notEqual(result.authState?.status, "missing_official_auth");
});

test("re-upserting after a corrupt Codex index does not invent current", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "idx-corrupt-upsert@example.com", "acct-idx-corrupt-upsert", "idx-corrupt-upsert");
  assert.equal(engine.loadIdx().current_account_id, null);
  const config = require("../engine/config");
  try { fs.unlinkSync(`${config.IDX_PATH}.bak`); } catch {}
  fs.writeFileSync(config.IDX_PATH, "{ corrupted", "utf8");
  const again = await addAccount(engine, "idx-corrupt-upsert@example.com", "acct-idx-corrupt-upsert", "idx-corrupt-upsert");
  assert.equal(again.id, account.id);
  assert.equal(engine.loadIdx().current_account_id, null);
  assert.equal(engine.currentAcct(), null);
  assert.ok(engine.loadIdx().accounts.some((item) => item.id === account.id));
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.notEqual(result.authState?.status, "missing_official_auth");
});

test("re-upserting after a corrupt Cursor index does not invent current", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "idx-corrupt-cursor@example.com",
    auth_id: "user_idx_corrupt_cursor",
    access_token: jwt({
      email: "idx-corrupt-cursor@example.com",
      sub: "user_idx_corrupt_cursor",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-idx-corrupt-cursor",
  });
  assert.equal(engine.currentCursorAcct(), null);
  const config = require("../engine/config");
  try { fs.unlinkSync(`${config.CURSOR_IDX_PATH}.bak`); } catch {}
  fs.writeFileSync(config.CURSOR_IDX_PATH, "{ corrupted", "utf8");
  const again = await engine.upsertCursorAccount({
    email: "idx-corrupt-cursor@example.com",
    auth_id: "user_idx_corrupt_cursor",
    access_token: jwt({
      email: "idx-corrupt-cursor@example.com",
      sub: "user_idx_corrupt_cursor",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-idx-corrupt-cursor",
  });
  assert.equal(again.account.id, created.account.id);
  assert.equal(engine.currentCursorAcct(), null);
  assert.equal(engine.loadCursorIdx().current_cursor_account_id, null);
});

test("a missing Codex index rebuilds the current account from last_used", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "idx-rebuild-a@example.com", "acct-idx-rebuild-a", "idx-rebuild-a");
  const second = await addAccount(engine, "idx-rebuild-b@example.com", "acct-idx-rebuild-b", "idx-rebuild-b");
  first.last_used = 100;
  engine.saveAcct(first);
  second.last_used = 200;
  engine.saveAcct(second);
  const index = engine.loadIdx();
  index.current_account_id = second.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  fs.unlinkSync(config.IDX_PATH);
  try { fs.unlinkSync(`${config.IDX_PATH}.bak`); } catch {}
  const loaded = engine.loadIdx();
  assert.equal(loaded.current_account_id, second.id);
  assert.ok(loaded.accounts.some((item) => item.id === first.id));
  assert.ok(loaded.accounts.some((item) => item.id === second.id));
});

test("an unreadable Codex index without backup keeps the most recently used current account", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "idx-unreadable-a@example.com", "acct-idx-unreadable-a", "idx-unreadable-a");
  const second = await addAccount(engine, "idx-unreadable-b@example.com", "acct-idx-unreadable-b", "idx-unreadable-b");
  first.last_used = 300;
  engine.saveAcct(first);
  second.last_used = 100;
  engine.saveAcct(second);
  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  try { fs.unlinkSync(`${config.IDX_PATH}.bak`); } catch {}
  fs.writeFileSync(config.IDX_PATH, "{ corrupted", "utf8");
  const loaded = engine.loadIdx();
  assert.equal(loaded.current_account_id, first.id);
  assert.ok(loaded.accounts.some((item) => item.id === first.id));
  assert.ok(loaded.accounts.some((item) => item.id === second.id));
});

test("the daemon does not pause as an auth conflict after a missing index rebuilds current", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "idx-daemon-rebuild@example.com", "acct-idx-daemon-rebuild", "idx-daemon-rebuild");
  current.last_used = 400;
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  fs.unlinkSync(config.IDX_PATH);
  try { fs.unlinkSync(`${config.IDX_PATH}.bak`); } catch {}
  const result = await engine.runDaemonWorker();
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(result.pausedReason, null);
  assert.notEqual(result.authState?.status, "unmanaged_official_auth");
  assert.notEqual(result.authState?.status, "auth_conflict");
});

test("a missing Codex index rebuilds from account files instead of a stale backup", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "idx-stale-a@example.com", "acct-idx-stale-a", "idx-stale-a");
  const second = await addAccount(engine, "idx-stale-b@example.com", "acct-idx-stale-b", "idx-stale-b");
  const index = engine.loadIdx();
  index.current_account_id = second.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  const stale = JSON.parse(fs.readFileSync(config.IDX_PATH, "utf8"));
  stale.accounts = stale.accounts.filter((item) => item.id === first.id);
  stale.current_account_id = first.id;
  fs.writeFileSync(`${config.IDX_PATH}.bak`, JSON.stringify(stale), "utf8");
  fs.unlinkSync(config.IDX_PATH);
  const loaded = engine.loadIdx();
  assert.ok(loaded.accounts.some((item) => item.id === first.id));
  assert.ok(loaded.accounts.some((item) => item.id === second.id), "a stale index backup must not hide a remaining account file");
  assert.equal(engine.loadAcct(second.id).email, "idx-stale-b@example.com");
});

test("a corrupt Codex index does not resurrect a deleted account from backup", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "idx-ghost-a@example.com", "acct-idx-ghost-a", "idx-ghost-a");
  const second = await addAccount(engine, "idx-ghost-b@example.com", "acct-idx-ghost-b", "idx-ghost-b");
  const index = engine.loadIdx();
  index.current_account_id = second.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  fs.writeFileSync(`${config.IDX_PATH}.bak`, fs.readFileSync(config.IDX_PATH, "utf8"), "utf8");
  engine.deleteAcct(second.id, { allowCurrent: true });
  fs.writeFileSync(config.IDX_PATH, "{ corrupted", "utf8");
  const loaded = engine.loadIdx();
  assert.equal(loaded.accounts.some((item) => item.id === second.id), false);
  assert.ok(loaded.accounts.some((item) => item.id === first.id));
  assert.notEqual(loaded.current_account_id, second.id);
  assert.equal(engine.loadAcct(second.id), null);
});

test("a non-JSON filesystem error does not restore a stale Codex index backup", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "idx-fs-a@example.com", "acct-idx-fs-a", "idx-fs-a");
  const second = await addAccount(engine, "idx-fs-b@example.com", "acct-idx-fs-b", "idx-fs-b");
  const index = engine.loadIdx();
  index.current_account_id = second.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  const good = fs.readFileSync(config.IDX_PATH, "utf8");
  const stale = JSON.parse(good);
  stale.current_account_id = first.id;
  stale.accounts = stale.accounts.filter((item) => item.id === first.id);
  fs.writeFileSync(`${config.IDX_PATH}.bak`, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(config.IDX_PATH)) {
      const error = new Error("EISDIR: illegal operation on a directory");
      error.code = "EISDIR";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  assert.throws(() => engine.loadIdx(), (error) => error.code === "EISDIR");
  fs.readFileSync = originalRead;
  const loaded = JSON.parse(fs.readFileSync(config.IDX_PATH, "utf8"));
  assert.equal(loaded.current_account_id, second.id);
  assert.ok(loaded.accounts.some((item) => item.id === second.id));
  assert.equal(JSON.parse(fs.readFileSync(`${config.IDX_PATH}.bak`, "utf8")).current_account_id, first.id);
});

test("a non-JSON filesystem error does not rebuild a Cursor index", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "idx-fs-cursor@example.com",
    auth_id: "user_idx_fs_cursor",
    access_token: jwt({
      email: "idx-fs-cursor@example.com",
      sub: "user_idx_fs_cursor",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-idx-fs-cursor",
  });
  const config = require("../engine/config");
  const rawIndex = JSON.parse(fs.readFileSync(config.CURSOR_IDX_PATH, "utf8"));
  rawIndex.current_cursor_account_id = created.account.id;
  rawIndex.accounts.push({ id: "cursor_marker_not_a_file", email: "marker@example.com" });
  fs.writeFileSync(config.CURSOR_IDX_PATH, `${JSON.stringify(rawIndex, null, 2)}\n`);
  const good = fs.readFileSync(config.CURSOR_IDX_PATH, "utf8");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(config.CURSOR_IDX_PATH)) {
      const error = new Error("EISDIR: illegal operation on a directory");
      error.code = "EISDIR";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  assert.throws(() => engine.loadCursorIdx(), (error) => error.code === "EISDIR");
  fs.readFileSync = originalRead;
  const loaded = JSON.parse(fs.readFileSync(config.CURSOR_IDX_PATH, "utf8"));
  assert.equal(loaded.current_cursor_account_id, created.account.id);
  assert.equal(loaded.accounts.some((item) => item.id === "cursor_marker_not_a_file"), true);
  assert.equal(fs.readFileSync(config.CURSOR_IDX_PATH, "utf8"), good);
});

test("a corrupt Codex index still restores from backup", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "idx-bak@example.com", "acct-idx-bak", "idx-bak");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  fs.writeFileSync(`${config.IDX_PATH}.bak`, fs.readFileSync(config.IDX_PATH, "utf8"), "utf8");
  fs.writeFileSync(config.IDX_PATH, "{ corrupted", "utf8");
  const loaded = engine.loadIdx();
  assert.equal(loaded.current_account_id, account.id);
  assert.ok(loaded.accounts.some((item) => item.id === account.id));
  assert.equal(JSON.parse(fs.readFileSync(config.IDX_PATH, "utf8")).current_account_id, account.id);
});

test("a corrupt Cursor index still restores from backup", async (t) => {
  const { engine } = freshEngine(t);
  const created = await engine.upsertCursorAccount({
    email: "idx-cursor-bak@example.com",
    auth_id: "user_idx_cursor_bak",
    access_token: jwt({
      email: "idx-cursor-bak@example.com",
      sub: "user_idx_cursor_bak",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-idx-cursor-bak",
  });
  engine.setCurrentCursorAccountId(created.account.id);
  const config = require("../engine/config");
  fs.writeFileSync(`${config.CURSOR_IDX_PATH}.bak`, fs.readFileSync(config.CURSOR_IDX_PATH, "utf8"), "utf8");
  fs.writeFileSync(config.CURSOR_IDX_PATH, "{ corrupted", "utf8");
  const loaded = engine.loadCursorIdx();
  assert.equal(loaded.current_cursor_account_id, created.account.id);
  assert.ok(loaded.accounts.some((item) => item.id === created.account.id));
  assert.equal(JSON.parse(fs.readFileSync(config.CURSOR_IDX_PATH, "utf8")).current_cursor_account_id, created.account.id);
});

test("a corrupt Cursor index does not resurrect a deleted account from backup", async (t) => {
  const { engine } = freshEngine(t);
  const first = await engine.upsertCursorAccount({
    email: "idx-cursor-ghost-a@example.com",
    auth_id: "user_idx_cursor_ghost_a",
    access_token: jwt({
      email: "idx-cursor-ghost-a@example.com",
      sub: "user_idx_cursor_ghost_a",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-idx-cursor-ghost-a",
  });
  const second = await engine.upsertCursorAccount({
    email: "idx-cursor-ghost-b@example.com",
    auth_id: "user_idx_cursor_ghost_b",
    access_token: jwt({
      email: "idx-cursor-ghost-b@example.com",
      sub: "user_idx_cursor_ghost_b",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-idx-cursor-ghost-b",
  });
  engine.setCurrentCursorAccountId(second.account.id);
  const config = require("../engine/config");
  fs.writeFileSync(`${config.CURSOR_IDX_PATH}.bak`, fs.readFileSync(config.CURSOR_IDX_PATH, "utf8"), "utf8");
  engine.deleteCursorAcct(second.account.id, { allowCurrent: true });
  fs.writeFileSync(config.CURSOR_IDX_PATH, "{ corrupted", "utf8");
  const loaded = engine.loadCursorIdx();
  assert.equal(loaded.accounts.some((item) => item.id === second.account.id), false);
  assert.ok(loaded.accounts.some((item) => item.id === first.account.id));
  assert.notEqual(loaded.current_cursor_account_id, second.account.id);
  assert.equal(engine.loadCursorAcct(second.account.id), null);
});

test("a Codex account still loads when the first JSON parse sees a torn write", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "torn-acct@example.com", "acct-torn-acct", "torn-acct");
  const filePath = engine.accountFilePath(account.id);
  const staleBackup = JSON.parse(fs.readFileSync(filePath, "utf8"));
  staleBackup.email = "stale-backup@example.com";
  fs.writeFileSync(`${filePath}.bak`, JSON.stringify(staleBackup), "utf8");
  stubTornJsonReads(t, filePath);
  const loaded = engine.loadAcct(account.id);
  assert.equal(loaded.email, "torn-acct@example.com");
  assert.equal(fs.existsSync(filePath), true, "a briefly torn account file must not be quarantined");
  assert.equal(JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8")).email, "stale-backup@example.com");
});

test("a torn Codex index is not rebuilt without the current account", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "torn-idx@example.com", "acct-torn-idx", "torn-idx");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const config = require("../engine/config");
  const staleIndex = JSON.parse(fs.readFileSync(config.IDX_PATH, "utf8"));
  staleIndex.current_account_id = null;
  fs.writeFileSync(`${config.IDX_PATH}.bak`, JSON.stringify(staleIndex), "utf8");
  stubTornJsonReads(t, config.IDX_PATH);
  const loaded = engine.loadIdx();
  assert.equal(loaded.current_account_id, account.id);
  assert.ok(loaded.accounts.some((item) => item.id === account.id));
  assert.equal(fs.existsSync(config.IDX_PATH), true, "a briefly torn index must not be quarantined");
});

test("a corrupt Codex auth.json still restores from backup instead of pausing", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "auth-bak@example.com", "acct-auth-bak", "auth-bak");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  fs.writeFileSync(`${authPath}.bak`, fs.readFileSync(authPath, "utf8"), "utf8");
  fs.writeFileSync(authPath, "{ corrupted", "utf8");
  const state = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(state.status, "aligned");
  assert.equal(state.requiresResolution, false);
  assert.ok(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.access_token);
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.pausedReason, null);
  assert.notEqual(worker.authState?.status, "missing_official_auth");
});

test("a torn Codex auth.json is not treated as missing official auth", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "torn-auth@example.com", "acct-torn-auth", "torn-auth");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  stubTornJsonReads(t, path.join(config.CODEX_DIR, "auth.json"));
  const state = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(state.status, "aligned");
  assert.equal(state.requiresResolution, false);
});

test("auto-switch does not treat a torn auth.json as a login conflict", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "torn-as-auth@example.com", "acct-torn-as-auth", "torn-as-auth");
  current.quota = {
    hourly_remaining_percentage: null,
    hourly_window_present: false,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  current.usage_updated_at = engine.ts();
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  stubTornJsonReads(t, path.join(config.CODEX_DIR, "auth.json"));
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "quota_sufficient");
});

test("auto-switch does not treat a locked auth.json as a login conflict", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "lock-as-auth@example.com", "acct-lock-as-auth", "lock-as-auth");
  current.quota = {
    hourly_remaining_percentage: null,
    hourly_window_present: false,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  current.usage_updated_at = engine.ts();
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(authPath)) {
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, false);
  assert.notEqual(result.reason, "auth_conflict");
  assert.equal(result.reason, "current_quota_refresh_failed");
  assert.equal(result.error, "Read authentication state timed out");
  assert.equal(result.authState, null);
});

test("auto-switch does not throw when the pre-switch auth recheck hits a leftover lock", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "recheck-lock@example.com", "acct-recheck-lock", "recheck-lock");
  const candidate = await addAccount(engine, "recheck-ready@example.com", "acct-recheck-ready", "recheck-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const aligned = engine.inspectAuthState({ migrateProjection: false });
  const authState = require("../engine/auth-state");
  const originalInspect = authState.inspectAuthState;
  authState.inspectAuthState = () => {
    const error = new Error("EPERM: operation not permitted");
    error.code = "EPERM";
    error.transientIoError = true;
    throw error;
  };
  t.after(() => { authState.inspectAuthState = originalInspect; });
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  }, { authState: aligned });
  assert.equal(result.switched, false);
  assert.notEqual(result.reason, "auth_conflict");
  assert.equal(result.reason, "current_quota_refresh_failed");
  assert.equal(result.error, "Read authentication state timed out");
  assert.equal(engine.loadIdx().current_account_id, current.id);
});

test("the daemon does not treat a leftover lock during auto-switch as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-recheck-lock@example.com", "acct-daemon-recheck-lock", "daemon-recheck-lock");
  const candidate = await addAccount(engine, "daemon-recheck-ready@example.com", "acct-daemon-recheck-ready", "daemon-recheck-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  engine.saveAutoSwitchCfg({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  quotaModule.refreshQuota = async account => account.quota;
  switchModule.doSwitch = async account => {
    switchedTo = account.id;
    return { account };
  };
  const authState = require("../engine/auth-state");
  const originalInspect = authState.inspectAuthState;
  let looks = 0;
  authState.inspectAuthState = () => {
    looks += 1;
    const error = new Error("EPERM: operation not permitted");
    error.code = "EPERM";
    throw error;
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
    authState.inspectAuthState = originalInspect;
  });
  const worker = await engine.runDaemonWorker();
  assert.ok(looks >= 1);
  assert.equal(worker.autoSwitchResult?.reason, "current_quota_refresh_failed");
  assert.equal(worker.autoSwitchResult?.error, "Read authentication state timed out");
  assert.equal(switchedTo, null);
  assert.ok(!worker.failures.some((item) => item.stage === "auto_switch"));
  assert.ok(!worker.failures.some((item) => item.stage === "auth_inspect"));
  assert.equal(engine.loadIdx().current_account_id, current.id);
});

test("the daemon still records a real current quota refresh failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-quota-fail@example.com", "acct-daemon-quota-fail", "daemon-quota-fail");
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_window_present: false,
  };
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  engine.saveAutoSwitchCfg({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => { throw new Error("network unavailable"); };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult?.reason, "current_quota_refresh_failed");
  assert.ok(worker.failures.some((item) => item.stage === "auto_switch" && /network unavailable/.test(item.message)));
});

test("the daemon does not toast a transient quota network miss as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-quota-net@example.com", "acct-daemon-quota-net", "daemon-quota-net");
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:7890"); };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult, null);
  assert.ok(!worker.failures.some((item) => item.stage === "quota_refresh"));
  assert.equal(worker.failures.length, 0);
});

test("the daemon does not toast an IPv6 unreachable quota miss as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-quota-v6@example.com", "acct-daemon-quota-v6", "daemon-quota-v6");
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => { throw new Error("connect ENETUNREACH 2606:4700::1:443"); };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult, null);
  assert.ok(!worker.failures.some((item) => item.stage === "quota_refresh"));
  assert.equal(worker.failures.length, 0);
});

test("the daemon does not toast an engine worker timeout as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-quota-worker@example.com", "acct-daemon-quota-worker", "daemon-quota-worker");
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  const workerTimeout = new Error("Engine worker timed out");
  workerTimeout.code = "engine_worker_down";
  quotaModule.refreshQuota = async () => { throw workerTimeout; };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult, null);
  assert.ok(!worker.failures.some((item) => item.stage === "quota_refresh"));
  assert.equal(worker.failures.length, 0);
});

test("the daemon does not toast an HTTP 500 quota miss as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-quota-500@example.com", "acct-daemon-quota-500", "daemon-quota-500");
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => { throw new Error("HTTP 500 temporarily_unavailable"); };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult, null);
  assert.ok(!worker.failures.some((item) => item.stage === "quota_refresh"));
  assert.equal(worker.failures.length, 0);
});

test("the daemon does not toast a not-JSON quota miss as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-quota-json@example.com", "acct-daemon-quota-json", "daemon-quota-json");
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => { throw new Error("这次没查清额度，请稍后重试。"); };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult, null);
  assert.ok(!worker.failures.some((item) => item.stage === "quota_refresh"));
  assert.equal(worker.failures.length, 0);
});

test("the daemon does not toast an empty token JSON miss as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-empty-token@example.com", "acct-daemon-empty-token", "daemon-empty-token");
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => { throw new Error("响应无 access_token"); };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult, null);
  assert.ok(!worker.failures.some((item) => item.stage === "quota_refresh"));
  assert.equal(worker.failures.length, 0);
});

test("the daemon does not toast an HTML token miss as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-html-token@example.com", "acct-daemon-html-token", "daemon-html-token");
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => { throw new Error("响应不是 JSON"); };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult, null);
  assert.ok(!worker.failures.some((item) => item.stage === "quota_refresh"));
  assert.equal(worker.failures.length, 0);
});

test("the daemon does not toast an HTTP 429 quota miss as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-quota-429@example.com", "acct-daemon-quota-429", "daemon-quota-429");
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => { throw new Error("HTTP 429"); };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult, null);
  assert.ok(!worker.failures.some((item) => item.stage === "quota_refresh"));
  assert.equal(worker.failures.length, 0);
});

test("the daemon does not toast an undici proxy socket miss as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-quota-undici@example.com", "acct-daemon-quota-undici", "daemon-quota-undici");
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => {
    const error = new Error("UND_ERR_SOCKET: other side closed");
    error.code = "UND_ERR_SOCKET";
    throw error;
  };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult, null);
  assert.ok(!worker.failures.some((item) => item.stage === "quota_refresh"));
  assert.equal(worker.failures.length, 0);
});

test("the daemon does not toast a dropped proxy pipe as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-quota-pipe@example.com", "acct-daemon-quota-pipe", "daemon-quota-pipe");
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async () => { throw new Error("write EPIPE"); };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.autoSwitchResult, null);
  assert.ok(!worker.failures.some((item) => item.stage === "quota_refresh"));
  assert.equal(worker.failures.length, 0);
});

test("the daemon does not toast a transient token network miss as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-token-net@example.com", "acct-daemon-token-net", "daemon-token-net");
  current.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const tokenRefresh = require("../engine/token-refresh");
  const originalRefresh = tokenRefresh.refreshOneTok;
  tokenRefresh.refreshOneTok = async () => ({
    ok: false,
    error: "网络请求失败 (auth.openai.com)。详情：请求超时",
  });
  t.after(() => { tokenRefresh.refreshOneTok = originalRefresh; });
  const worker = await engine.runDaemonWorker();
  assert.ok(!worker.failures.some((item) => item.stage === "token_refresh"));
});

test("the daemon does not toast a transient ban-probe network miss as a worker failure", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-probe-net@example.com", "acct-daemon-probe-net", "daemon-probe-net");
  account.requires_reauth = true;
  account.quota_error = { code: "refresh_token_invalidated", message: "keep me", timestamp: engine.ts() };
  engine.saveAcct(account);
  const quotaModule = require("../engine/quota");
  const originalProbe = quotaModule.probeUsageOnly;
  quotaModule.probeUsageOnly = async () => {
    throw new Error("网络请求失败 (chatgpt.com)。详情：请求超时");
  };
  t.after(() => { quotaModule.probeUsageOnly = originalProbe; });
  const worker = await engine.runDaemonWorker();
  assert.equal(worker.failures.filter((item) => item.stage === "ban_probe").length, 0);
});

test("auto-switch config still keeps the primary file when the first JSON parse is torn", (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  engine.ensureDir(config.DATA_DIR);
  engine.saveAutoSwitchCfg({
    enabled: true,
    primary_threshold: 15,
    secondary_threshold: 25,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  fs.writeFileSync(`${config.CFG_FILE}.bak`, JSON.stringify({ enabled: false, primary_threshold: 99 }), "utf8");
  stubTornJsonReads(t, config.CFG_FILE);
  const cfg = engine.loadAutoSwitchCfg();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.primary_threshold, 15);
  assert.equal(JSON.parse(fs.readFileSync(config.CFG_FILE, "utf8")).enabled, true);
});

test("legacy backup recovery keeps the backup usable and migrates without plaintext residue", async t => {
  const { engine, codec } = freshEngine(t);
  const account = await addAccount(engine, "legacy@example.com", "acct-legacy", "legacy");
  const filePath = engine.accountFilePath(account.id);

  const legacyRecord = { ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
  delete legacyRecord.tokens_encrypted;
  legacyRecord.tokens = {
    id_token: "legacy-id-token",
    access_token: account.tokens.access_token,
    refresh_token: "legacy-refresh-token",
    account_id: "acct-legacy",
  };

  // Corrupt primary + legacy plaintext backup: the recovery chain used to
  // copy the corrupt primary over the backup via the migration side effect.
  fs.writeFileSync(`${filePath}.bak`, JSON.stringify(legacyRecord), "utf8");
  fs.writeFileSync(filePath, "{ corrupted", "utf8");

  const recovered = engine.loadAcct(account.id);
  assert.equal(recovered.email, "legacy@example.com");
  assert.equal(recovered.tokens.refresh_token, "legacy-refresh-token");

  const primaryRaw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.ok(primaryRaw.tokens_encrypted, "the migrated primary must be encrypted");
  assert.equal(primaryRaw.tokens, undefined);
  const backupRaw = JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8"));
  assert.ok(backupRaw.tokens_encrypted, "the refreshed backup must be encrypted, not plaintext");
  assert.equal(fs.readFileSync(`${filePath}.bak`, "utf8").includes("legacy-refresh-token"), false);
  assert.equal(codec.decrypt(backupRaw.tokens_encrypted).includes("legacy-refresh-token"), true);
});

test("legacy account migration retries a transient backup copy lock", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "legacy-copy@example.com", "acct-legacy-copy", "legacy-copy");
  const filePath = engine.accountFilePath(account.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.tokens_encrypted;
  raw.tokens = { ...account.tokens, refresh_token: "plain-copy-token" };
  fs.writeFileSync(filePath, JSON.stringify(raw));

  const originalCopy = fs.copyFileSync;
  let failures = 0;
  fs.copyFileSync = (from, to, ...rest) => {
    if (path.resolve(from) === path.resolve(filePath) && String(to).endsWith(".bak") && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalCopy(from, to, ...rest);
  };
  t.after(() => { fs.copyFileSync = originalCopy; });

  engine.listAccts();
  await engine.flushPendingAccountRewrites();
  assert.equal(failures, 2);
  const backupRaw = JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8"));
  assert.ok(backupRaw.tokens_encrypted);
  assert.equal(fs.readFileSync(`${filePath}.bak`, "utf8").includes("plain-copy-token"), false);
  assert.equal(engine.loadAcct(account.id).tokens.refresh_token, "plain-copy-token");
});

test("token refresh posts opt out of retries and cross-stack replays", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "replay@example.com", "acct-replay", "replay");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 10 });
  engine.saveAcct(account);

  let observedOptions = null;
  const result = await engine.refreshOneTok(account, {
    force: true,
    httpJson: async (url, options) => {
      observedOptions = options;
      return { status: 200, body: JSON.stringify({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(observedOptions.idempotent, false,
    "the token endpoint must be marked non-idempotent so httpJson never replays it");
});

test("normalizeQuota keeps fetch-time reset times instead of recomputing them", t => {
  freshEngine(t);
  const { normalizeQuota } = require("../engine/quota");
  const fetchTimeReset = 1_700_000_000;
  const stale = {
    hourly_remaining_percentage: 41,
    hourly_window_present: true,
    hourly_window_minutes: 10080,
    hourly_reset_time: fetchTimeReset,
    weekly_remaining_percentage: null,
    weekly_window_present: false,
    raw_data: {
      rate_limit: {
        primary_window: { used_percent: 59, limit_window_seconds: 604800, reset_after_seconds: 86400 },
      },
    },
  };
  const normalized = normalizeQuota(stale);
  assert.equal(normalized.weekly_window_present, true);
  assert.equal(normalized.weekly_remaining_percentage, 41);
  assert.equal(normalized.weekly_reset_time, fetchTimeReset,
    "the reset time computed at fetch time must carry over to the corrected slot");
});

test("the daemon leaves reauth-required current accounts alone", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "reauth-current@example.com", "acct-reauth-current", "reauth-current");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);

  account.requires_reauth = true;
  account.reauth_reason = "refresh_token needs re-authorization";
  account.quota_error = { code: "missing_refresh_token", message: "no refresh token", timestamp: engine.ts() };
  account.probe = { status: "active", error_code: null, http_status: 200, checked_at: engine.ts() };
  engine.saveAcct(account);

  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.length, 0);
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.quota_error.code, "missing_refresh_token",
    "the self-heal marker must survive daemon ticks");
});

test("the daemon leaves banned current accounts alone", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "banned-daemon@example.com", "acct-banned-daemon", "banned-daemon");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);

  account.banned = true;
  account.probe = { status: "banned", error_code: "account_deactivated", http_status: 401, checked_at: engine.ts() };
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);

  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.deepEqual(result.tokenRefreshes, []);
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.banned, true);
  assert.equal(persisted.tokens.refresh_token, account.tokens.refresh_token);
});

test("the daemon skips ban-probe decrypts for ordinary accounts", async t => {
  const { engine } = freshEngine(t);
  const accounts = [];
  for (const suffix of ["a", "b", "c", "d", "e"]) {
    accounts.push(await addAccount(
      engine,
      `daemon-ordinary-${suffix}@example.com`,
      `acct-daemon-ordinary-${suffix}`,
      `daemon-ordinary-${suffix}`,
    ));
  }
  const index = engine.loadIdx();
  index.current_account_id = null;
  engine.saveIdx(index);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(engine.listAccts({ secrets: false }).length, 5);
  assert.equal(result.tokenRefreshes.length, 0);
  // Unexpired listed tokens skip the token loop without decrypting.
  // Probing all five would make this 5.
  assert.equal(decrypts.count, 0);
});

test("the daemon still decrypts expired tokens that have a refresh token", async t => {
  const { engine } = freshEngine(t);
  const expired = await addAccount(engine, "daemon-expired@example.com", "acct-daemon-expired", "daemon-expired");
  await addAccount(engine, "daemon-fresh-skip@example.com", "acct-daemon-fresh-skip", "daemon-fresh-skip");
  expired.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(expired);
  const index = engine.loadIdx();
  index.current_account_id = null;
  engine.saveIdx(index);
  const tokenModule = require("../engine/token-refresh");
  const originalRefresh = tokenModule.refreshOneTok;
  let refreshedId = null;
  tokenModule.refreshOneTok = async (account, options = {}) => {
    refreshedId = account.id;
    return originalRefresh(account, {
      ...options,
      httpJson: async () => ({
        status: 200,
        body: JSON.stringify({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: account.tokens.refresh_token,
          id_token: account.tokens.id_token,
        }),
      }),
    });
  };
  t.after(() => { tokenModule.refreshOneTok = originalRefresh; });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(decrypts.count, 1);
  assert.equal(refreshedId, expired.id);
  assert.equal(result.tokenRefreshes.length, 1);
  assert.equal(result.tokenRefreshes[0].ok, true);
});

test("the daemon keeps finished refresh work when auto-switch config is briefly locked", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-cfg-lock@example.com", "acct-daemon-cfg-lock", "daemon-cfg-lock");
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);
  engine.saveAutoSwitchCfg({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  const tokenRefresh = require("../engine/token-refresh");
  const originalRefresh = tokenRefresh.refreshOneTok;
  tokenRefresh.refreshOneTok = async (acct) => {
    acct.token_generation = Number(acct.token_generation || 0) + 1;
    return { ok: true, skipped: false, gen: acct.token_generation };
  };
  const config = require("../engine/config");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(config.CFG_FILE)) {
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => {
    tokenRefresh.refreshOneTok = originalRefresh;
    fs.readFileSync = originalRead;
  });
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.ok(result.tokenRefreshes.some((item) => item.ok === true));
  assert.ok(result.failures.some((item) => item.stage === "auto_switch_config"));
  assert.equal(result.autoSwitchResult, null);
});

test("the daemon keeps quota work when a later index read hits a non-JSON filesystem error", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-idx-late@example.com", "acct-daemon-idx-late", "daemon-idx-late");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);
  const config = require("../engine/config");
  const good = fs.readFileSync(config.IDX_PATH, "utf8");
  const stale = JSON.parse(good);
  stale.current_account_id = null;
  fs.writeFileSync(`${config.IDX_PATH}.bak`, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
  const quotaModule = require("../engine/quota");
  const originalFetch = quotaModule.fetchQuotaWithTokenRepair;
  let allowIndex = true;
  quotaModule.fetchQuotaWithTokenRepair = async () => {
    allowIndex = false;
    return {
      hourly_remaining_percentage: null,
      hourly_window_present: false,
      weekly_remaining_percentage: 80,
      weekly_window_present: true,
    };
  };
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, encoding) => {
    if (!allowIndex && path.resolve(String(file)) === path.resolve(config.IDX_PATH)) {
      const error = new Error("EISDIR: illegal operation on a directory");
      error.code = "EISDIR";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => {
    quotaModule.fetchQuotaWithTokenRepair = originalFetch;
    fs.readFileSync = originalRead;
  });
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.ok(result.accountsUpdated >= 1);
  assert.equal(result.failures.some((item) => item.stage === "account_index" && item.code === "EISDIR"), true);
  fs.readFileSync = originalRead;
  assert.equal(JSON.parse(fs.readFileSync(config.IDX_PATH, "utf8")).current_account_id, account.id);
  assert.equal(JSON.parse(fs.readFileSync(`${config.IDX_PATH}.bak`, "utf8")).current_account_id, null);
});

test("the daemon writes the current auth projection without a second decrypt after quota refresh", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-proj@example.com", "acct-daemon-proj", "daemon-proj");
  const index = engine.loadIdx();
  index.current_account_id = account.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(account);
  engine.writeProjection(account, auth);

  const quotaModule = require("../engine/quota");
  const originalFetch = quotaModule.fetchQuotaWithTokenRepair;
  quotaModule.fetchQuotaWithTokenRepair = async () => ({
    hourly_remaining_percentage: null,
    hourly_window_present: false,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  });
  t.after(() => { quotaModule.fetchQuotaWithTokenRepair = originalFetch; });

  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.length, 0);
  // inspectAuthState at start, quota-lock load, inspectAuthState after quota.
  // The token loop used to decrypt the unexpired current account too.
  assert.equal(decrypts.count, 3);
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.quota.weekly_remaining_percentage, 80);
});

test("the daemon skips decrypts for reauth accounts without leftover tokens", async (t) => {
  const { engine } = freshEngine(t);
  const reauth = await addAccount(engine, "daemon-reauth-empty@example.com", "acct-daemon-reauth-empty", "daemon-reauth-empty");
  reauth.requires_reauth = true;
  reauth.tokens.refresh_token = "";
  reauth.tokens.access_token = "";
  engine.saveAcct(reauth);
  await addAccount(engine, "daemon-live-empty@example.com", "acct-daemon-live-empty", "daemon-live-empty");
  const index = engine.loadIdx();
  index.current_account_id = null;
  engine.saveIdx(index);
  const listed = engine.listAccts({ secrets: false }).find((item) => item.id === reauth.id);
  assert.equal(listed.has_refresh, false);
  assert.equal(listed.has_access, false);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(decrypts.count, 0);
});

test("the daemon does not treat reauth token skips as worker failures", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "reauth-expired@example.com", "acct-reauth-expired", "reauth-expired");
  account.requires_reauth = true;
  account.reauth_reason = "refresh_token needs re-authorization";
  account.quota_error = { code: "refresh_token_invalidated", message: "keep me", timestamp: engine.ts() };
  account.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  engine.saveAcct(account);

  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.filter((item) => item.stage === "token_refresh").length, 0);
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.requires_reauth, true);
  assert.equal(persisted.quota_error.code, "refresh_token_invalidated");
});

test("token refreshAll skips banned accounts without counting them as passed", async t => {
  const { engine } = freshEngine(t);
  const banned = await addAccount(engine, "banned-token@example.com", "acct-banned-token", "banned-token");
  banned.banned = true;
  engine.saveAcct(banned);
  const live = await addAccount(engine, "live-token@example.com", "acct-live-token", "live-token");

  const summary = await engine.refreshAll(false);
  const bannedResult = summary.results.find((item) => item.email === banned.email);
  const liveResult = summary.results.find((item) => item.email === live.email);
  assert.equal(bannedResult.ok, false);
  assert.equal(bannedResult.skipped, true);
  assert.equal(bannedResult.banned, true);
  assert.equal(liveResult.ok, true);
  assert.equal(summary.okCount, 1);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const again = await engine.refreshAll(false);
  assert.equal(again.results.find((item) => item.email === banned.email).banned, true);
  assert.equal(again.okCount, 1);
  assert.ok(decrypts.count < 3);
});

test("token refreshAll skips reauth accounts without a refresh token", async (t) => {
  const { engine } = freshEngine(t);
  const reauth = await addAccount(engine, "reauth-norefresh@example.com", "acct-reauth-norefresh", "reauth-norefresh");
  reauth.requires_reauth = true;
  reauth.tokens.refresh_token = "";
  engine.saveAcct(reauth);
  const live = await addAccount(engine, "live-refresh@example.com", "acct-live-refresh", "live-refresh");
  const listed = engine.listAccts({ secrets: false }).find((item) => item.id === reauth.id);
  assert.equal(listed.requires_reauth, true);
  assert.equal(listed.has_refresh, false);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const summary = await engine.refreshAll(false);
  assert.equal(summary.results.find((item) => item.email === reauth.email).reauthRequired, true);
  assert.equal(summary.results.find((item) => item.email === live.email).ok, true);
  assert.equal(decrypts.count, 0);
});

test("token refreshAll skips unexpired accounts without decrypting them", async (t) => {
  const { engine } = freshEngine(t);
  await addAccount(engine, "fresh-batch-a@example.com", "acct-fresh-batch-a", "fresh-batch-a");
  await addAccount(engine, "fresh-batch-b@example.com", "acct-fresh-batch-b", "fresh-batch-b");
  const index = engine.loadIdx();
  index.current_account_id = null;
  engine.saveIdx(index);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const summary = await engine.refreshAll(false);
  assert.equal(summary.okCount, 2);
  assert.equal(summary.results.every((item) => item.skipped === true), true);
  assert.equal(decrypts.count, 0);
});

test("token refreshAll does not decrypt the current account after skipping unexpired tokens", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "fresh-current-skip@example.com", "acct-fresh-current-skip", "fresh-current-skip");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const config = require("../engine/config");
  const authPath = path.join(config.CODEX_DIR, "auth.json");
  const before = fs.readFileSync(authPath, "utf8");
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const summary = await engine.refreshAll(false);
  assert.equal(summary.okCount, 1);
  assert.equal(summary.results[0].skipped, true);
  assert.equal(decrypts.count, 0);
  assert.equal(fs.readFileSync(authPath, "utf8"), before);
});

test("the daemon probes leftover access tokens on reauth accounts to detect bans", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-probe@example.com", "acct-daemon-probe", "daemon-probe");
  account.requires_reauth = true;
  account.quota_error = { code: "refresh_token_invalidated", message: "keep me", timestamp: engine.ts() };
  engine.saveAcct(account);
  const quotaModule = require("../engine/quota");
  const originalFetch = quotaModule.fetchQuota;
  quotaModule.fetchQuota = async () => {
    const error = new Error("HTTP 401 account_deactivated");
    error.probe = {
      status: "banned",
      error_code: "account_deactivated",
      http_status: 401,
      message: "账号已封号，无法继续使用。",
      ok: false,
    };
    throw error;
  };
  t.after(() => {
    quotaModule.fetchQuota = originalFetch;
  });

  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.filter((item) => item.stage === "ban_probe").length, 0);
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.banned, true);
  assert.equal(persisted.requires_reauth, true);
  assert.equal(persisted.quota_error.code, "account_deactivated");
});

test("daemon ban probe keeps the in-memory account after leftover usage errors", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "daemon-probe-mem@example.com", "acct-daemon-probe-mem", "daemon-probe-mem");
  await addAccount(engine, "daemon-probe-spare@example.com", "acct-daemon-probe-spare", "daemon-probe-spare");
  account.requires_reauth = true;
  account.quota_error = { code: "refresh_token_invalidated", message: "keep me", timestamp: engine.ts() };
  engine.saveAcct(account);
  const index = engine.loadIdx();
  index.current_account_id = null;
  engine.saveIdx(index);
  const quotaModule = require("../engine/quota");
  const originalFetch = quotaModule.fetchQuota;
  quotaModule.fetchQuota = async () => {
    const error = new Error("HTTP 401 account_deactivated");
    error.probe = {
      status: "banned",
      error_code: "account_deactivated",
      http_status: 401,
      message: "账号已封号，无法继续使用。",
      ok: false,
    };
    throw error;
  };
  t.after(() => {
    quotaModule.fetchQuota = originalFetch;
  });
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await engine.runDaemonWorker();
  assert.equal(result.pausedReason, null);
  assert.equal(result.failures.filter((item) => item.stage === "ban_probe").length, 0);
  // Ban-probe decrypt of the leftover-token account. The spare unexpired
  // account and the reauth leftover access used to decrypt in the token loop.
  assert.equal(decrypts.count, 1);
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.banned, true);
  assert.equal(persisted.requires_reauth, true);
});

test("the daemon reports official auth after an auto-switch, not the pre-switch inspect", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-pre@example.com", "acct-daemon-pre", "daemon-pre");
  const candidate = await addAccount(engine, "daemon-post@example.com", "acct-daemon-post", "daemon-post");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  engine.saveAutoSwitchCfg({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async account => account.quota;
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });
  const before = engine.inspectAuthState({ migrateProjection: false });
  assert.equal(before.currentAccountId, current.id);
  const result = await engine.runDaemonWorker();
  assert.equal(result.autoSwitchResult?.switched, true);
  assert.equal(result.autoSwitchResult?.to?.id, candidate.id);
  assert.equal(result.authState.status, "aligned");
  assert.equal(result.authState.currentAccountId, candidate.id);
  assert.equal(engine.currentAcct().id, candidate.id);
});

test("the daemon marks auto-switch as paused when official Codex login is missing", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-missing@example.com", "acct-daemon-missing", "daemon-missing");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  engine.saveAutoSwitchCfg({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const result = await engine.runDaemonWorker();
  assert.equal(result.authState.status, "missing_official_auth");
  assert.equal(result.autoSwitchResult?.reason, "missing_official_auth");
  assert.equal(result.pausedReason, "missing_official_auth");
});

test("the daemon marks auto-switch as paused while Codex OAuth is pending", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-oauth-cur@example.com", "acct-daemon-oauth-cur", "daemon-oauth-cur");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  engine.saveAutoSwitchCfg({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const oauth = require("../engine/oauth");
  const originalStatus = oauth.getOAuthStatus;
  oauth.getOAuthStatus = () => ({ pending: true });
  t.after(() => { oauth.getOAuthStatus = originalStatus; });
  const result = await engine.runDaemonWorker();
  assert.equal(result.autoSwitchResult?.reason, "oauth_pending");
  assert.equal(result.pausedReason, "oauth_pending");
});

test("the daemon marks auto-switch as paused when the switch verify fails", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "daemon-verify-cur@example.com", "acct-daemon-verify-cur", "daemon-verify-cur");
  const candidate = await addAccount(engine, "daemon-verify-ready@example.com", "acct-daemon-verify-ready", "daemon-verify-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  engine.saveAutoSwitchCfg({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
    sync_interval_minutes: 60,
  });
  const quotaModule = require("../engine/quota");
  const switchModule = require("../engine/switch");
  const originalRefresh = quotaModule.refreshQuota;
  const originalSwitch = switchModule.doSwitch;
  quotaModule.refreshQuota = async account => account.quota;
  switchModule.doSwitch = async () => {
    const error = new Error("official write did not stick");
    error.code = "codex_switch_verify_failed";
    throw error;
  };
  t.after(() => {
    quotaModule.refreshQuota = originalRefresh;
    switchModule.doSwitch = originalSwitch;
  });
  const result = await engine.runDaemonWorker();
  assert.equal(result.autoSwitchResult?.reason, "switch_verify_failed");
  assert.equal(result.pausedReason, "switch_verify_failed");
  assert.equal(engine.currentAcct().id, current.id);
});

test("auto-switch trusts fresh cached quota instead of refreshing the current account again", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "fresh-current@example.com", "acct-fresh-current", "fresh-current");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: null,
    hourly_window_present: false,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  let refreshCalls = 0;
  quotaModule.refreshQuota = async () => { refreshCalls += 1; };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });

  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.reason, "quota_sufficient");
  assert.equal(refreshCalls, 0,
    "a quota refreshed moments ago must not trigger a second usage request");
});

test("auto-switch keeps the refreshed current account without decrypting it again", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "stale-current@example.com", "acct-stale-current", "stale-current");
  current.quota = {
    hourly_remaining_percentage: null,
    hourly_window_present: false,
    weekly_remaining_percentage: 80,
    weekly_window_present: true,
  };
  current.usage_updated_at = engine.ts() - 601;
  engine.saveAcct(current);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const quotaModule = require("../engine/quota");
  const originalRefresh = quotaModule.refreshQuota;
  quotaModule.refreshQuota = async (account) => {
    account.quota = {
      hourly_remaining_percentage: null,
      hourly_window_present: false,
      weekly_remaining_percentage: 80,
      weekly_window_present: true,
    };
    account.quota_error = null;
    account.usage_updated_at = engine.ts();
    engine.saveAcct(account);
    return account.quota;
  };
  t.after(() => { quotaModule.refreshQuota = originalRefresh; });

  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.reason, "quota_sufficient");
  // inspectAuthState plus the quota-refresh load. Reloading the same account
  // after refreshQuota mutated it in place would make this 3.
  assert.equal(decrypts.count, 2);
});

test("auto-switch does not decrypt a fresh-quota candidate until the actual switch", async t => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "fresh-cand-current@example.com", "acct-fresh-cand-current", "fresh-cand-current");
  const candidate = await addAccount(engine, "fresh-cand-ready@example.com", "acct-fresh-cand-ready", "fresh-cand-ready");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
  candidate.quota = {
    hourly_remaining_percentage: 90,
    hourly_window_present: true,
    weekly_remaining_percentage: 90,
    weekly_window_present: true,
  };
  candidate.usage_updated_at = now;
  engine.saveAcct(current);
  engine.saveAcct(candidate);
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);

  const switchModule = require("../engine/switch");
  const originalSwitch = switchModule.doSwitch;
  let switchedTo = null;
  switchModule.doSwitch = async (account) => {
    switchedTo = account.id;
    return { account };
  };
  t.after(() => { switchModule.doSwitch = originalSwitch; });

  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const result = await engine.autoSwitchTick({
    enabled: true,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: "all",
    selected_account_ids: [],
  });
  assert.equal(result.switched, true);
  assert.equal(switchedTo, candidate.id);
  // Start inspect (current), switch-lock loads of current and the winner,
  // plus one more current inspect immediately before doSwitch. Decrypting
  // the listed candidate just to read cached quota would make this 5.
  assert.equal(decrypts.count, 4);
});

test("auto-switch config recovery ignores stale backups on ENOENT and survives double corruption", t => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  engine.ensureDir(config.DATA_DIR);

  // Deleting the config is a reset: a stale backup must not resurrect it.
  fs.writeFileSync(`${config.CFG_FILE}.bak`, JSON.stringify({ enabled: true }), "utf8");
  assert.equal(engine.loadAutoSwitchCfg().enabled, false);

  // Corrupt primary with a good backup restores and rewrites the primary.
  fs.writeFileSync(config.CFG_FILE, "{ corrupted", "utf8");
  assert.equal(engine.loadAutoSwitchCfg().enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(config.CFG_FILE, "utf8")).enabled, true);

  // Both corrupt: quarantine the primary and fall back to defaults loudly.
  fs.writeFileSync(config.CFG_FILE, "{ corrupted", "utf8");
  fs.writeFileSync(`${config.CFG_FILE}.bak`, "{ also corrupted", "utf8");
  assert.equal(engine.loadAutoSwitchCfg().enabled, false);
  assert.equal(fs.existsSync(config.CFG_FILE), false, "the corrupt primary must be quarantined");
  const quarantined = fs.readdirSync(config.DATA_DIR).filter(name => name.includes("invalid-json"));
  assert.ok(quarantined.length >= 1);
});

test("auto-switch config still restores from backup when existsSync reports it missing", (t) => {
  const { engine } = freshEngine(t);
  const config = require("../engine/config");
  engine.ensureDir(config.DATA_DIR);
  fs.writeFileSync(config.CFG_FILE, "{ corrupted", "utf8");
  fs.writeFileSync(`${config.CFG_FILE}.bak`, JSON.stringify({ enabled: true, primary_threshold: 15 }), "utf8");
  const originalExists = fs.existsSync;
  fs.existsSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(`${config.CFG_FILE}.bak`)) return false;
    return originalExists(file);
  };
  t.after(() => { fs.existsSync = originalExists; });
  const cfg = engine.loadAutoSwitchCfg();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.primary_threshold, 15);
  assert.equal(JSON.parse(fs.readFileSync(config.CFG_FILE, "utf8")).enabled, true);
});

test("a mismatched reauthorization still merges into an existing same-identity record", async t => {
  const { engine } = freshEngine(t);
  const target = await addAccount(engine, "target@example.com", "acct-target", "target");
  const existing = await addAccount(engine, "existing@example.com", "acct-existing", "existing");

  // The authorized identity matches `existing` but derives a different
  // storage id (organization claim appeared); it must merge, not duplicate.
  const payload = {
    email: "existing@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      account_id: "acct-existing",
      chatgpt_org_id: "org-existing",
      organizations: [],
    },
  };
  const orgTokens = { id_token: jwt(payload), access_token: jwt(payload), refresh_token: "refresh-mismatch" };
  const result = await engine.upsert(orgTokens, { targetAccountId: target.id });
  assert.equal(result.mismatch, true);
  assert.equal(result.account.id, existing.id);
  assert.equal(engine.listAccts().length, 2);
});

test("codex same email different account ids stay two accounts", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "same@example.com", "acct-one", "one");
  const second = await addAccount(engine, "same@example.com", "acct-two", "two");
  assert.notEqual(first.id, second.id);
  assert.equal(engine.listAccts().length, 2);
});

test("codex same email merges when one side has no account id", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "merge-email@example.com", "acct-keep", "keep");
  const thin = {
    email: "merge-email@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const result = await engine.upsert({
    id_token: jwt(thin),
    access_token: jwt(thin),
    refresh_token: "refresh-thin",
  });
  assert.equal(result.account.id, first.id);
  assert.equal(result.updated, true);
  assert.equal(engine.listAccts().length, 1);
});

test("codex collapse after a corrupt index does not invent current", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "fold-corrupt@example.com", "acct-fold-corrupt", "fold-corrupt");
  const extra = {
    ...first,
    id: engine.buildId("fold-corrupt@example.com", "acct-fold-corrupt", "org-extra"),
    created_at: first.created_at + 10,
  };
  engine.saveAcct(extra);
  assert.equal(engine.loadIdx().current_account_id, null);
  const config = require("../engine/config");
  try { fs.unlinkSync(`${config.IDX_PATH}.bak`); } catch {}
  fs.writeFileSync(config.IDX_PATH, "{ corrupted", "utf8");
  engine.collapseDuplicateCodexAccounts();
  const remaining = engine.listAccts();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, first.id);
  assert.equal(engine.loadIdx().current_account_id, null);
  assert.equal(engine.currentAcct(), null);
});

test("codex collapse folds same-identity files and keeps current", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "fold@example.com", "acct-fold", "fold");
  const index = engine.loadIdx();
  index.current_account_id = first.id;
  engine.saveIdx(index);
  const extra = {
    ...first,
    id: engine.buildId("fold@example.com", "acct-fold", "org-extra"),
    created_at: first.created_at + 10,
  };
  engine.saveAcct(extra);
  assert.equal(engine.listAccts().length, 2);
  engine.collapseDuplicateCodexAccounts();
  const remaining = engine.listAccts();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, first.id);
  assert.equal(engine.loadIdx().current_account_id, first.id);
});

test("codex collapse does not decrypt unique accounts", async (t) => {
  const { engine } = freshEngine(t);
  await addAccount(engine, "unique-a@example.com", "acct-unique-a", "unique-a");
  await addAccount(engine, "unique-b@example.com", "acct-unique-b", "unique-b");
  await addAccount(engine, "unique-c@example.com", "acct-unique-c", "unique-c");
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  engine.collapseDuplicateCodexAccounts();
  assert.equal(engine.listAccts({ secrets: false }).length, 3);
  assert.equal(decrypts.count, 0);
});

test("codex upsert of a unique account does not decrypt spare vault files", async (t) => {
  const { engine } = freshEngine(t);
  await addAccount(engine, "spare-a@example.com", "acct-spare-a", "spare-a");
  await addAccount(engine, "spare-b@example.com", "acct-spare-b", "spare-b");
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  const created = await addAccount(engine, "unique-new@example.com", "acct-unique-new", "unique-new");
  assert.equal(created.email, "unique-new@example.com");
  assert.equal(engine.listAccts({ secrets: false }).length, 3);
  assert.equal(decrypts.count, 0);
});

test("codex unknown emails do not merge without account ids", () => {
  const { engine } = { engine: require("../engine/oauth") };
  assert.equal(engine.sameAccountIdentity({ email: "unknown" }, { email: "unknown" }), false);
  assert.equal(engine.sameAccountIdentity({ email: "one@example.com" }, { email: "unknown" }), false);
});

test("codex collapse remaps selected auto-switch ids onto the keeper", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "fold-sel@example.com", "acct-fold-sel", "fold-sel");
  const extra = {
    ...first,
    id: engine.buildId("fold-sel@example.com", "acct-fold-sel", "org-extra"),
    created_at: first.created_at + 10,
  };
  engine.saveAcct(extra);
  engine.saveAutoSwitchCfg({
    ...engine.loadAutoSwitchCfg(),
    account_scope_mode: "selected",
    selected_account_ids: [extra.id, "unrelated-id"],
  });
  engine.collapseDuplicateCodexAccounts();
  assert.deepEqual(engine.loadAutoSwitchCfg().selected_account_ids, [first.id, "unrelated-id"]);
  assert.equal(engine.listAccts().length, 1);
});

test("codex upsert keeps quota_error when no new windows arrive", async (t) => {
  const { engine } = freshEngine(t);
  const first = await addAccount(engine, "keep-error@example.com", "acct-keep-error", "keep-error");
  const stored = engine.loadAcct(first.id);
  stored.quota_error = { code: "probe_failed", message: "这次没查清额度，请稍后重试。" };
  stored.probe = { status: "probe_failed" };
  engine.saveAcct(stored);
  const result = await engine.upsert(tokens("keep-error@example.com", "acct-keep-error", "keep-error-2"));
  assert.equal(result.updated, true);
  assert.equal(result.account.quota_error.code, "probe_failed");
  assert.equal(engine.loadAcct(first.id).quota_error.code, "probe_failed");
});

test("account lists do not fold duplicates and still return accounts", async () => {
  const handlers = new Map();
  const warnings = [];
  let foldCalls = 0;
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.29",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const engine = {
    collapseDuplicateCodexAccounts() { foldCalls += 1; throw new Error("codex fold boom"); },
    collapseDuplicateCursorAccounts() { foldCalls += 1; throw new Error("cursor fold boom"); },
    collapseDuplicateAntigravityAccounts() { foldCalls += 1; throw new Error("ag fold boom"); },
    listAccts: () => [{ id: "codex_one", email: "one@example.com" }],
    listCursorAccts: () => [{ id: "cursor_one", email: "cursor@example.com", tokens: {} }],
    listAntigravityAccts: () => [{ id: "antigravity_one", email: "ag@example.com", tokens: {} }],
    withAccountLock: async (_id, task) => task(),
    logWarn: (message) => warnings.push(message),
    jwtExp: () => null,
    jwtPayload: () => null,
    ts: () => 1,
    isTokenExpired: () => true,
    isExpiryStale: () => true,
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const listed = await handlers.get("account:list")({});
  assert.equal(listed.success, true);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].tokens, undefined);
  const cursor = await handlers.get("cursor:list")({}, { skipOfficialSync: true });
  assert.equal(cursor.success, true);
  assert.equal(cursor.data.length, 1);
  const antigravity = await handlers.get("antigravity:list")({}, { skipOfficialSync: true });
  assert.equal(antigravity.success, true);
  assert.equal(antigravity.data.length, 1);
  assert.equal(foldCalls, 0);
  assert.equal(warnings.length, 0);
});

test("secrets:false account lists skip decrypt when token metadata is present", async (t) => {
  const { engine, codec } = freshEngine(t);
  const account = await addAccount(engine, "meta@example.com", "acct-meta", "meta");
  const filePath = engine.accountFilePath(account.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.ok(raw.tokens_encrypted);
  assert.equal(typeof raw.token_exp, "number");
  assert.equal(raw.has_refresh, true);
  assert.equal(raw.has_access, true);
  assert.equal(raw.tokens, undefined);

  let decrypts = 0;
  const originalDecrypt = codec.decrypt.bind(codec);
  engine.setSecretCodec({
    name: codec.name,
    encrypt: codec.encrypt,
    decrypt: (value) => {
      decrypts += 1;
      return originalDecrypt(value);
    },
  });
  fs.utimesSync(filePath, new Date(), new Date());
  const listed = engine.listAccts({ secrets: false });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, account.id);
  assert.equal(listed[0].tokens, null);
  assert.equal(listed[0].has_refresh, true);
  assert.equal(listed[0].email, "meta@example.com");
  assert.equal(decrypts, 0);

  const loaded = engine.loadAcct(account.id);
  assert.ok(loaded.tokens.access_token);
  assert.ok(decrypts >= 1);
});

test("secrets:false lists can still synchronize the account index", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "sync-index@example.com", "acct-sync-index", "sync-index");
  const index = engine.loadIdx();
  index.accounts.push({ id: "codex_marker_not_a_file", email: "marker@example.com" });
  engine.saveIdx(index);
  const decrypts = countDecrypts(engine);
  decrypts.reset();
  engine.listAccts({ secrets: false });
  assert.equal(engine.loadIdx().accounts.some((item) => item.id === "codex_marker_not_a_file"), true);
  assert.equal(decrypts.count, 0);
  engine.listAccts({ secrets: false, syncIndex: true });
  assert.equal(engine.loadIdx().accounts.some((item) => item.id === "codex_marker_not_a_file"), false);
  assert.equal(engine.loadIdx().accounts.some((item) => item.id === account.id), true);
  assert.equal(decrypts.count, 0);
});

test("secrets:false lists decrypt as a fallback and do not rewrite the file", async (t) => {
  const { engine, codec } = freshEngine(t);
  const account = await addAccount(engine, "legacy-meta@example.com", "acct-legacy-meta", "legacy-meta");
  const filePath = engine.accountFilePath(account.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.token_exp;
  delete raw.token_iat;
  delete raw.has_refresh;
  delete raw.has_access;
  fs.writeFileSync(filePath, JSON.stringify(raw));

  let decrypts = 0;
  const originalDecrypt = codec.decrypt.bind(codec);
  engine.setSecretCodec({
    name: codec.name,
    encrypt: codec.encrypt,
    decrypt: (value) => {
      decrypts += 1;
      return originalDecrypt(value);
    },
  });
  const listed = engine.listAccts({ secrets: false });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokens, null);
  assert.ok(decrypts >= 1);
  const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(after.token_exp, undefined);
  assert.equal(after.has_refresh, undefined);
});

test("path locks serialize overlapping writers", async (t) => {
  const { engine } = freshEngine(t);
  const order = [];
  await Promise.all([
    engine.withPathLock("accounts-index.json", async () => {
      order.push("a");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("a-done");
    }),
    engine.withPathLock("accounts-index.json", async () => {
      order.push("b");
      order.push("b-done");
    }),
  ]);
  assert.deepEqual(order, ["a", "a-done", "b", "b-done"]);
});

test("token refresh skips when observed generation is behind and access is still valid", async (t) => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "gen@example.com", "acct-gen", "gen");
  account.token_generation = 2;
  engine.saveAcct(account);
  let calls = 0;
  const { refreshOneTok } = require("../engine/token-refresh");
  const result = await refreshOneTok(engine.loadAcct(account.id), {
    observedGeneration: 1,
    httpJson: async () => {
      calls += 1;
      throw new Error("should not refresh");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.gen, 2);
  assert.equal(calls, 0);
});

test("mapLimit caps concurrent mappers", async (t) => {
  const { engine } = freshEngine(t);
  let inflight = 0;
  let max = 0;
  await engine.mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    inflight += 1;
    max = Math.max(max, inflight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inflight -= 1;
  });
  assert.equal(max, 3);
});

test("quota refreshAll still refreshes accounts waiting to retry", async () => {
  const handlers = new Map();
  let quotaRefreshCount = 0;
  const electron = {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: {
      getVersion: () => "0.1.0-beta.34",
      isPackaged: false,
    },
    shell: {
      async openExternal() {},
      async openPath() { return ""; },
    },
  };
  const waiting = {
    id: "waiting-account",
    email: "waiting@example.com",
    quota_next_retry_at: Math.floor(Date.now() / 1000) + 600,
  };
  const ready = {
    id: "ready-account",
    email: "ready@example.com",
  };
  const accounts = new Map([[waiting.id, waiting], [ready.id, ready]]);
  const engine = {
    ts: () => Math.floor(Date.now() / 1000),
    listAccts: () => [waiting, ready],
    loadAcct: (id) => accounts.get(id) || null,
    withAccountLock: async (_id, task) => task(),
    mapLimit: async (items, limit, mapper) => {
      const { mapLimit } = require("../engine/operation-locks");
      return mapLimit(items, limit, mapper);
    },
    async refreshQuota() {
      quotaRefreshCount += 1;
      return { hourly_remaining_percentage: 50 };
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const allQuotas = await handlers.get("quota:refreshAll")({});
  assert.equal(allQuotas.success, true);
  assert.equal(allQuotas.data[0].id, waiting.id);
  assert.equal(allQuotas.data[0].skipped, undefined);
  assert.equal(allQuotas.data[0].quota.hourly_remaining_percentage, 50);
  assert.equal(allQuotas.data[1].id, ready.id);
  assert.equal(quotaRefreshCount, 2);
});

test("desktop snapshot IPC returns public accounts without secrets", async (t) => {
  const { engine } = freshEngine(t);
  await addAccount(engine, "snap@example.com", "acct-snap", "snap");
  const handlers = new Map();
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, {
    electron: {
      ipcMain: {
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      BrowserWindow: { getAllWindows: () => [] },
      app: {
        getVersion: () => "0.1.0-beta.34",
        isPackaged: false,
      },
      shell: {
        async openExternal() {},
        async openPath() { return ""; },
      },
    },
  });
  const snapshot = await handlers.get("desktop:snapshot")({}, { skipOfficialSync: true });
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.data.accounts.length, 1);
  assert.equal(snapshot.data.accounts[0].email, "snap@example.com");
  assert.equal(snapshot.data.accounts[0].tokens, undefined);
  assert.equal(Array.isArray(snapshot.data.cursorAccounts), true);
  assert.equal(Array.isArray(snapshot.data.antigravityAccounts), true);
});

test("a locked official auth.json does not fail auth inspect as a conflict", async () => {
  const handlers = new Map();
  const engine = {
    getTickIntervalMs: () => 10 * 60000,
    getTickIntervalMinutes: () => 10,
    loadAutoSwitchCfg: () => ({ enabled: false, sync_interval_minutes: 10 }),
    loadIdx: () => ({ current_account_id: "codex_keep" }),
    listAccts: () => [],
    listCursorAccts: () => [],
    listAntigravityAccts: () => [],
    getOAuthStatus: () => null,
    getCursorOAuthStatus: () => null,
    getAntigravityOAuthStatus: () => null,
    async withAccountLock(_id, task) {
      return task();
    },
    inspectAuthState() {
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    },
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, {
    electron: {
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      BrowserWindow: { getAllWindows: () => [] },
      app: { getVersion: () => "2.0.4", isPackaged: false },
      shell: { async openExternal() {}, async openPath() { return ""; } },
    },
  });
  const auth = await handlers.get("account:authState")({});
  assert.equal(auth.success, true);
  assert.equal(auth.data.status, "unknown");
  assert.equal(auth.data.requiresResolution, false);
  const snapshot = await handlers.get("desktop:snapshot")({}, { skipOfficialSync: true });
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.data.authState.status, "unknown");
  assert.equal(snapshot.data.authState.requiresResolution, false);
  assert.equal(snapshot.data.authError, null);
});

test("desktop snapshot reuses listed current accounts without extra decrypts", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "snap-current@example.com", "acct-snap-current", "snap-current");
  await addAccount(engine, "snap-spare@example.com", "acct-snap-spare", "snap-spare");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const auth = engine.writeAuthJson(current);
  engine.writeProjection(current, auth);
  const handlers = new Map();
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
  const snapshot = await handlers.get("desktop:snapshot")({}, { skipOfficialSync: true });
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.data.currentAccount.id, current.id);
  assert.equal(snapshot.data.currentAccount.email, "snap-current@example.com");
  assert.equal(snapshot.data.accounts.length, 2);
  assert.equal(decrypts.count, 1);
});

test("account current IPC reuses listed accounts without extra decrypts", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "ipc-current@example.com", "acct-ipc-current", "ipc-current");
  await addAccount(engine, "ipc-spare@example.com", "acct-ipc-spare", "ipc-spare");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const handlers = new Map();
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
  const result = await handlers.get("account:current")({});
  assert.equal(result.success, true);
  assert.equal(result.data.id, current.id);
  assert.equal(result.data.email, "ipc-current@example.com");
  assert.equal(result.data.tokens, undefined);
  assert.equal(decrypts.count, 0);
});

test("account switch IPC decrypts the target once and still accepts email", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "switch-current@example.com", "acct-switch-current", "switch-current");
  const target = await addAccount(engine, "switch-target@example.com", "acct-switch-target", "switch-target");
  await addAccount(engine, "switch-spare@example.com", "acct-switch-spare", "switch-spare");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const switched = [];
  engine.doSwitch = async (account) => {
    switched.push(account);
    return { already: false, account };
  };
  const handlers = new Map();
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
  const missing = await handlers.get("account:switch")({}, "missing-account");
  assert.equal(missing.success, false);
  assert.equal(switched.length, 0);
  assert.equal(decrypts.count, 0);

  decrypts.reset();
  const byEmail = await handlers.get("account:switch")({}, "switch-target@example.com");
  assert.equal(byEmail.success, true);
  assert.equal(byEmail.data.account.id, target.id);
  assert.equal(switched.length, 1);
  assert.ok(switched[0].tokens?.access_token);
  assert.equal(decrypts.count, 1);
});

test("account get IPC reuses listed accounts without extra decrypts", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "get-current@example.com", "acct-get-current", "get-current");
  await addAccount(engine, "get-spare@example.com", "acct-get-spare", "get-spare");
  const handlers = new Map();
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
  const missing = await handlers.get("account:get")({}, "acct-missing");
  assert.equal(missing.success, false);
  assert.equal(decrypts.count, 0);

  decrypts.reset();
  const result = await handlers.get("account:get")({}, current.id);
  assert.equal(result.success, true);
  assert.equal(result.data.id, current.id);
  assert.equal(result.data.email, "get-current@example.com");
  assert.equal(result.data.tokens, undefined);
  assert.equal(decrypts.count, 0);
});

test("account reauthorize IPC does not decrypt before starting OAuth", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "reauth-current@example.com", "acct-reauth-current", "reauth-current");
  await addAccount(engine, "reauth-spare@example.com", "acct-reauth-spare", "reauth-spare");
  const started = [];
  engine.oauthLoginFlow = async (options) => {
    started.push(options?.targetAccountId || null);
    return { account: current, mismatch: false, targetAccountId: current.id };
  };
  const handlers = new Map();
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
  const missing = await handlers.get("account:reauthorize")({}, "missing-account");
  assert.equal(missing.success, false);
  assert.equal(started.length, 0);
  assert.equal(decrypts.count, 0);

  decrypts.reset();
  const byEmail = await handlers.get("account:reauthorize")({}, "reauth-current@example.com");
  assert.equal(byEmail.success, true);
  assert.equal(byEmail.data.targetAccountId, current.id);
  assert.deepEqual(started, [current.id]);
  assert.equal(decrypts.count, 0);
});

test("account delete IPC removes a spare account without decrypting", async (t) => {
  const { engine } = freshEngine(t);
  const current = await addAccount(engine, "del-current@example.com", "acct-del-current", "del-current");
  const spare = await addAccount(engine, "del-spare@example.com", "acct-del-spare", "del-spare");
  const index = engine.loadIdx();
  index.current_account_id = current.id;
  engine.saveIdx(index);
  const handlers = new Map();
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
  const blocked = await handlers.get("account:delete")({}, current.id);
  assert.equal(blocked.success, false);
  assert.match(String(blocked.error), /Switch to another account/);
  assert.equal(engine.listAccts({ secrets: false }).length, 2);
  assert.equal(decrypts.count, 0);

  decrypts.reset();
  const removed = await handlers.get("account:delete")({}, "del-spare@example.com");
  assert.equal(removed.success, true);
  assert.equal(engine.listAccts({ secrets: false }).map((account) => account.id).join(","), current.id);
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(decrypts.count, 0);
});

test("legacy plaintext rewrite is deferred off the list hot path", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "defer-list@example.com", "acct-defer-list", "defer-list");
  const filePath = engine.accountFilePath(account.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.tokens_encrypted;
  raw.tokens = { ...account.tokens, refresh_token: "plain-refresh-token" };
  fs.writeFileSync(filePath, JSON.stringify(raw));

  const listed = engine.listAccts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokens.refresh_token, "plain-refresh-token");
  const afterList = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.ok(afterList.tokens, "list must not rewrite plaintext on the hot path");
  assert.equal(afterList.tokens_encrypted, undefined);

  await engine.flushPendingAccountRewrites();
  const afterFlush = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.ok(afterFlush.tokens_encrypted, "deferred rewrite must encrypt the record");
  assert.equal(afterFlush.tokens, undefined);
  assert.equal(fs.readFileSync(filePath, "utf8").includes("plain-refresh-token"), false);
});

test("deferred plaintext rewrite retries a transient stat lock", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "defer-stat@example.com", "acct-defer-stat", "defer-stat");
  const filePath = engine.accountFilePath(account.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.tokens_encrypted;
  raw.tokens = { ...account.tokens, refresh_token: "plain-stat-token" };
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const originalStat = fs.statSync;
  let failures = 0;
  fs.statSync = (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(filePath) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalStat(file, ...args);
  };
  t.after(() => { fs.statSync = originalStat; });
  engine.listAccts();
  assert.equal(failures, 2);
  await engine.flushPendingAccountRewrites();
  const afterFlush = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.ok(afterFlush.tokens_encrypted, "deferred rewrite must still encrypt after a transient stat lock");
  assert.equal(afterFlush.tokens, undefined);
  assert.equal(fs.readFileSync(filePath, "utf8").includes("plain-stat-token"), false);
});

test("deferred plaintext rewrite does not clobber a newer saveAcct", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "defer-save@example.com", "acct-defer-save", "defer-save");
  const filePath = engine.accountFilePath(account.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.tokens_encrypted;
  raw.tokens = { ...account.tokens, refresh_token: "plain-before-save" };
  fs.writeFileSync(filePath, JSON.stringify(raw));

  engine.listAccts();
  const fresh = engine.loadAcct(account.id);
  fresh.tokens.refresh_token = "saved-after-list";
  fresh.token_generation = Number(fresh.token_generation || 0) + 5;
  engine.saveAcct(fresh);
  await engine.flushPendingAccountRewrites();
  const loaded = engine.loadAcct(account.id);
  assert.equal(loaded.tokens.refresh_token, "saved-after-list");
  assert.equal(loaded.token_generation, fresh.token_generation);
});

test("deferred plaintext rewrite is discarded when the file changes first", async t => {
  const { engine } = freshEngine(t);
  const account = await addAccount(engine, "defer-drop@example.com", "acct-defer-drop", "defer-drop");
  const filePath = engine.accountFilePath(account.id);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.tokens_encrypted;
  raw.tokens = { ...account.tokens };
  fs.writeFileSync(filePath, JSON.stringify(raw));

  engine.listAccts();
  fs.writeFileSync(filePath, "{ not-json", "utf8");
  await engine.flushPendingAccountRewrites();
  assert.equal(fs.existsSync(filePath), true, "a changed file must not be quarantined by a stale rewrite");
  assert.equal(fs.readFileSync(filePath, "utf8"), "{ not-json");
});

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
  t.after(() => {
    try { engine.cancelOAuth(); } catch {}
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

function addAccount(engine, email, accountId, suffix) {
  return engine.upsert(tokens(email, accountId, suffix)).account;
}

test("quota parsing preserves window absence, clamps percentages, and applies weekly blocking", t => {
  freshEngine(t);
  const { parseQuotaPayload } = require("../engine/quota");

  const missingWeekly = parseQuotaPayload({
    rate_limit: { primary_window: { used_percent: -20, limit_window_seconds: 18000 } },
    rate_limit_reset_credits: { available_count: 0 },
  });
  assert.equal(missingWeekly.hourly_remaining_percentage, 100);
  assert.equal(missingWeekly.weekly_remaining_percentage, null);
  assert.equal(missingWeekly.weekly_window_present, false);
  assert.equal(missingWeekly.reset_credits_available, 0);

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

test("reset credit parsing retains an explicit zero balance", t => {
  freshEngine(t);
  const { parseResetCreditsPayload } = require("../engine/reset-credits");
  const snapshot = parseResetCreditsPayload({
    available_count: 0,
    credits: [{ id: "stale", status: "available" }],
  });
  assert.equal(snapshot.available_count, 0);
});

test("reset credit consumption stays successful when the balance refresh fails", async t => {
  const { engine } = freshEngine(t);
  const account = addAccount(engine, "reset@example.com", "acct-reset", "reset");
  account.reset_credits = { available_count: 1, credits: [], next_expires_at: null };
  let persisted = 0;

  const { consumeResetCredit } = require("../engine/reset-credits");
  const result = await consumeResetCredit(account, {
    httpJson: async () => ({ status: 200, headers: {}, body: "{}" }),
    fetchResetCredits: async () => { throw new Error("balance endpoint unavailable"); },
    saveAcct: () => { persisted += 1; },
  });

  assert.equal(result.consumed, true);
  assert.equal(result.balance_refreshed, false);
  assert.equal(result.refresh_error, "balance endpoint unavailable");
  assert.equal(account.reset_credits_error.message, "balance endpoint unavailable");
  assert.equal(account.reset_credits.available_count, 0);
  assert.equal(account.reset_credit_pending_redeem_id, null);
  assert.equal(persisted, 3);
});

test("reset credit retry reuses the pending redemption request id", async t => {
  const { engine } = freshEngine(t);
  const account = addAccount(engine, "retry-reset@example.com", "acct-retry-reset", "retry-reset");
  account.reset_credits = { available_count: 1, credits: [], next_expires_at: null };
  const requestIds = [];

  const { consumeResetCredit } = require("../engine/reset-credits");
  await assert.rejects(
    consumeResetCredit(account, {
      httpJson: async (_url, options) => {
        requestIds.push(JSON.parse(options.body).redeem_request_id);
        throw new Error("socket disconnected");
      },
      saveAcct: () => {},
    }),
    /Retrying will reuse the same request id/,
  );
  assert.equal(account.reset_credit_pending_redeem_id, requestIds[0]);

  const result = await consumeResetCredit(account, {
    httpJson: async (_url, options) => {
      requestIds.push(JSON.parse(options.body).redeem_request_id);
      return { status: 200, headers: {}, body: "{}" };
    },
    fetchResetCredits: async () => ({ available_count: 0, credits: [], next_expires_at: null }),
    saveAcct: () => {},
  });

  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[1], requestIds[0]);
  assert.equal(result.consumed, true);
  assert.equal(result.balance_refreshed, true);
  assert.equal(account.reset_credit_pending_redeem_id, null);
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
});

test("subscription retry state blocks background attempts but force bypasses it", t => {
  freshEngine(t);
  const { shouldAttemptSubscriptionRefresh } = require("../engine/subscription");
  const now = 1000;
  const account = { subscription_query_next_retry_at: 1200, subscription_active_until: null };
  assert.equal(shouldAttemptSubscriptionRefresh(account, false, now), false);
  assert.equal(shouldAttemptSubscriptionRefresh(account, true, now), true);
});

test("subscription selection never falls back to a different known account", t => {
  freshEngine(t);
  const { selectSubscriptionAccount } = require("../engine/subscription");
  const records = [
    { account: { account_id: "acct-other" }, entitlement: { subscription_plan: "team" } },
    { account: { account_id: "acct-expected" }, entitlement: { subscription_plan: "plus" } },
  ];

  assert.equal(
    selectSubscriptionAccount(records, "acct-expected").account.account_id,
    "acct-expected",
  );
  assert.equal(selectSubscriptionAccount(records, null), records[0]);
  assert.equal(selectSubscriptionAccount([], "acct-expected"), null);
  assert.throws(
    () => selectSubscriptionAccount(records, "acct-missing"),
    error => error.code === "subscription_account_mismatch",
  );
});

test("storage restores valid backups and preserves DPAPI failures", t => {
  const { engine, codec } = freshEngine(t);
  const account = addAccount(engine, "alpha@example.com", "acct-alpha", "alpha");
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
  assert.equal(engine.loadAcct(account.id), null);
  assert.equal(fs.existsSync(accountPath), true);
  assert.ok(engine.getStorageDiagnostics().some(item => item.type === "account_credentials"));
  engine.setSecretCodec(codec);
});

test("account file access rejects unsafe ids and delete rolls back on index failure", t => {
  const { engine } = freshEngine(t);
  const first = addAccount(engine, "delete-one@example.com", "acct-delete-one", "delete-one");
  const second = addAccount(engine, "delete-two@example.com", "acct-delete-two", "delete-two");
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

test("auth state detects drift, migrates legacy projections, and adopts official login", t => {
  const { engine } = freshEngine(t);
  const first = addAccount(engine, "first@example.com", "acct-first", "first");
  const second = addAccount(engine, "second@example.com", "acct-second", "second");
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

  const adopted = engine.adoptOfficialAuth();
  assert.equal(adopted.id, second.id);
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
});

test("auth state accepts and synchronizes token rotation for the same official identity", t => {
  const { engine } = freshEngine(t);
  const account = addAccount(engine, "same@example.com", "acct-same", "first-token");
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

test("auto-switch refuses to use stale quota after current refresh failure", async t => {
  const { engine } = freshEngine(t);
  const account = addAccount(engine, "current@example.com", "acct-current", "current");
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
});

test("auto-switch cancellation prevents switching after a daemon stop", async t => {
  const { engine } = freshEngine(t);
  const current = addAccount(engine, "cancel-current@example.com", "acct-cancel-current", "cancel-current");
  const candidate = addAccount(engine, "cancel-candidate@example.com", "acct-cancel-candidate", "cancel-candidate");
  const now = engine.ts();
  current.quota = {
    hourly_remaining_percentage: 0,
    hourly_window_present: true,
    weekly_remaining_percentage: 0,
    weekly_window_present: true,
  };
  current.usage_updated_at = now;
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
});

test("auto-switch revalidates failed candidates and excludes accounts requiring reauthorization", async t => {
  const { engine } = freshEngine(t);
  const current = addAccount(engine, "candidate-current@example.com", "acct-candidate-current", "candidate-current");
  const candidate = addAccount(engine, "candidate-ready@example.com", "acct-candidate-ready", "candidate-ready");
  const revoked = addAccount(engine, "candidate-revoked@example.com", "acct-candidate-revoked", "candidate-revoked");
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

test("daemon pauses before network work when official authentication conflicts", async t => {
  const { engine } = freshEngine(t);
  const account = addAccount(engine, "daemon@example.com", "acct-daemon", "daemon");
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

test("switch transaction commits on success and restores state when launch fails", async t => {
  const { engine } = freshEngine(t);
  const first = addAccount(engine, "one@example.com", "acct-one", "one");
  const second = addAccount(engine, "two@example.com", "acct-two", "two");
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
  await engine.doSwitch(second);
  assert.equal(engine.loadIdx().current_account_id, second.id);
  assert.equal(engine.inspectAuthState().status, "aligned");

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

test("process enumeration failure blocks credential switching", async t => {
  const { engine } = freshEngine(t);
  const current = addAccount(engine, "enumeration-current@example.com", "acct-enumeration-current", "enumeration-current");
  const target = addAccount(engine, "enumeration-target@example.com", "acct-enumeration-target", "enumeration-target");
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

test("OAuth pending state is encrypted, recoverable, cancellable, and target mismatch is saved separately", async t => {
  const { engine, codec } = freshEngine(t);
  const original = addAccount(engine, "original@example.com", "acct-original", "original");
  const result = engine.upsert(tokens("different@example.com", "acct-different", "different"), {
    targetAccountId: original.id,
  });
  assert.equal(result.mismatch, true);
  assert.equal(engine.loadAcct(original.id).email, "original@example.com");
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

test("persistent logger removes credentials and personal email from messages", t => {
  freshEngine(t);
  const { sanitizeMessage } = require("../engine/logger");
  const value = sanitizeMessage("Bearer secret access_token=abc user@example.com code=oauth-code");
  assert.equal(value.includes("secret"), false);
  assert.equal(value.includes("abc"), false);
  assert.equal(value.includes("user@example.com"), false);
  assert.equal(value.includes("oauth-code"), false);
});

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
  assert.match(background.error, /authentication changed/i);
  assert.equal(refreshCount, 0);

  const manual = await handlers.get("quota:refresh")({}, account.id, true);
  assert.equal(manual.success, true);
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
  });
  assert.equal(allQuotas.data[1].id, active.id);
  assert.equal(quotaRefreshCount, 1);
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
  engine.inspectAuthState();
  const logPath = path.join(config.DATA_DIR, "logs", `app-${new Date().toISOString().slice(0, 10)}.log`);
  const conflictWarnings = () => fs.readFileSync(logPath, "utf8")
    .split("\n")
    .filter(line => line.includes("Official Codex authentication differs from the managed current account"));
  assert.equal(conflictWarnings().length, 1);

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
  fs.writeFileSync(path.join(config.CODEX_DIR, "auth.json"), JSON.stringify(secondAuth), "utf8");
  assert.equal(engine.inspectAuthState().status, "conflict");
  assert.equal(conflictWarnings().length, 2);
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

test("token refresh rechecks official auth before writing refreshed credentials", async t => {
  const { engine } = freshEngine(t);
  const current = addAccount(engine, "race-current@example.com", "acct-race-current", "race-current");
  const external = addAccount(engine, "race-external@example.com", "acct-race-external", "race-external");
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
  const account = addAccount(engine, "revoked-token@example.com", "acct-revoked-token", "revoked-token");
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

  first.requires_reauth = true;
  await assert.rejects(engine.doSwitch(first), /requires reauthorization/i);
  assert.equal(engine.loadIdx().current_account_id, second.id);
  first.requires_reauth = false;

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
  const renamed = engine.upsert(tokens("renamed@example.com", "acct-original", "renamed"), {
    targetAccountId: original.id,
  });
  assert.equal(renamed.mismatch, false);
  assert.equal(renamed.account.id, original.id);
  assert.equal(engine.loadAcct(original.id).email, "renamed@example.com");
  assert.equal(engine.listAccts().length, 1);

  const result = engine.upsert(tokens("different@example.com", "acct-different", "different"), {
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
  const account = addAccount(engine, "form@example.com", "acct-form", "form");
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

test("an invalid_refresh_token error marks the account for reauthorization", async t => {
  const { engine } = freshEngine(t);
  const account = addAccount(engine, "invalid-rt@example.com", "acct-invalid-rt", "invalid-rt");
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
  assert.equal(result.code, "invalid_refresh_token");
  const persisted = engine.loadAcct(account.id);
  assert.equal(persisted.requires_reauth, true);
  assert.equal(persisted.quota_error.code, "invalid_refresh_token");
});

test("token refresh treats invalidated-token text errors as reauthorization", async t => {
  const { engine } = freshEngine(t);
  const account = addAccount(engine, "text-reauth@example.com", "acct-text-reauth", "text-reauth");
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
  const account = addAccount(engine, "heal@example.com", "acct-heal", "heal");
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

test("adding the same identity merges into the existing account record", t => {
  const { engine } = freshEngine(t);
  const original = engine.upsert(tokens("merge@example.com", "acct-merge", "merge-one")).account;
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
  const result = engine.upsert(orgTokens);
  assert.equal(result.account.id, original.id);
  assert.equal(engine.listAccts().length, 1);
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

test("auth state reports an official agent identity as unsupported with identity details", t => {
  const { engine } = freshEngine(t);
  const account = addAccount(engine, "agent@example.com", "acct-agent", "agent");
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

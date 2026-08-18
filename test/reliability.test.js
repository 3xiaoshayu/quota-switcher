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

async function addAccount(engine, email, accountId, suffix) {
  return (await engine.upsert(tokens(email, accountId, suffix))).account;
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
  await engine.doSwitch(second);
  assert.equal(engine.loadIdx().current_account_id, second.id);
  assert.equal(engine.inspectAuthState().status, "aligned");

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

  const forced = await engine.doSwitch(engine.loadAcct(current.id), { force: true });
  assert.equal(forced.already, false);
  assert.equal(launchCount, 1);
  assert.equal(engine.inspectAuthState().status, "aligned");

  const reapplied = await engine.reapplyManagedAuth(current.id);
  assert.equal(reapplied.already, false);
  assert.equal(launchCount, 2);
  assert.equal(engine.loadIdx().current_account_id, current.id);
  assert.equal(engine.inspectAuthState().status, "aligned");
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
  assert.match(html, /可以回到 Codex 账号管理器/);
  assert.equal(html.includes("Authorization received"), false);
  const result = await pendingPromise;
  assert.equal(result.account.email, "callback-page@example.com");
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

test("account lists still return when fold throws", async () => {
  const handlers = new Map();
  const warnings = [];
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
    collapseDuplicateCodexAccounts() { throw new Error("codex fold boom"); },
    collapseDuplicateCursorAccounts() { throw new Error("cursor fold boom"); },
    collapseDuplicateAntigravityAccounts() { throw new Error("ag fold boom"); },
    listAccts: () => [{ id: "codex_one", email: "one@example.com" }],
    listCursorAccts: () => [{ id: "cursor_one", email: "cursor@example.com", tokens: {} }],
    listAntigravityAccts: () => [{ id: "antigravity_one", email: "ag@example.com", tokens: {} }],
    withAccountLock: async (_id, task) => task(),
    logWarn: (message) => warnings.push(message),
    jwtExp: () => null,
    jwtPayload: () => null,
    ts: () => 1,
    isTokenExpired: () => true,
  };
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron });
  const listed = await handlers.get("account:list")({});
  assert.equal(listed.success, true);
  assert.equal(listed.data.length, 1);
  const cursor = await handlers.get("cursor:list")({}, { skipOfficialSync: true });
  assert.equal(cursor.success, true);
  assert.equal(cursor.data.length, 1);
  const antigravity = await handlers.get("antigravity:list")({}, { skipOfficialSync: true });
  assert.equal(antigravity.success, true);
  assert.equal(antigravity.data.length, 1);
  assert.equal(warnings.length, 3);
});

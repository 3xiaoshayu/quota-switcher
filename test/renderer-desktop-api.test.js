const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");

function loadDesktopApiWithBridge(bridge) {
  const sourcePath = path.join(projectRoot, "src", "renderer-react", "api", "desktop.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    window: { codexAccountManager: bridge },
    console,
    Date,
    Intl,
    Math,
    Number,
    String,
    Error,
  };
  vm.runInNewContext(compiled, sandbox, { filename: sourcePath });
  return module.exports.desktopApi;
}

function ok(data) {
  return Promise.resolve({ success: true, data });
}

function fail(error) {
  return Promise.resolve({ success: false, error });
}

function bridge(overrides = {}) {
  return {
    listAccounts: () => ok([{
      id: "one",
      email: "one@example.com",
      plan_type: "plus",
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: false,
        timeLeft: 3600,
      },
    }]),
    getCurrentAccount: () => ok(null),
    getDaemonStatus: () => ok({ running: false, syncIntervalMinutes: 10 }),
    getAutoSwitchConfig: () => ok({
      enabled: false,
      primary_threshold: 20,
      secondary_threshold: 30,
      account_scope_mode: "all",
      selected_account_ids: [],
      sync_interval_minutes: 10,
    }),
    getAppInfo: () => ok({ name: "Codex Account Manager", version: "test" }),
    getCodexStatus: () => ok({ installed: true }),
    getUpdateStatus: () => ok({ status: "idle" }),
    getAuthState: () => ok({ status: "aligned", requiresResolution: false }),
    getOAuthStatus: () => ok({ status: "idle", pending: false }),
    getStorageDiagnostics: () => ok([]),
    ...overrides,
  };
}

test("dashboard state survives optional desktop API failures", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    getAppInfo: () => fail("app info unavailable"),
    getCodexStatus: async () => { throw new Error("codex status crashed"); },
    getUpdateStatus: () => fail("update service unavailable"),
    getOAuthStatus: () => fail("oauth status unavailable"),
    getStorageDiagnostics: async () => { throw new Error("diagnostics crashed"); },
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.accounts[0].email, "one@example.com");
  assert.equal(snapshot.appInfo, null);
  assert.equal(snapshot.codexStatus, null);
  assert.equal(snapshot.updateStatus, null);
  assert.equal(snapshot.oauthStatus.status, "idle");
  assert.equal(snapshot.oauthStatus.pending, false);
  assert.equal(snapshot.oauthStatus.message, null);
  assert.equal(snapshot.storageDiagnostics.length, 0);
});

test("dashboard state still fails when the core account list is unavailable", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => fail("account database unavailable"),
  }));

  await assert.rejects(
    () => desktopApi.loadDashboardState(),
    /account database unavailable/,
  );
});

test("dashboard state pauses background sync when authentication cannot be verified", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    getAuthState: () => fail("auth state unavailable"),
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.authState.status, "unknown");
  assert.equal(snapshot.authState.requiresResolution, true);
  assert.match(snapshot.authState.message, /auth state unavailable/i);
});

test("dashboard state replaces internal reauthorization details with actionable copy", async () => {
  const desktopApi = loadDesktopApiWithBridge(bridge({
    listAccounts: () => ok([{
      id: "revoked",
      email: "revoked@example.com",
      plan_type: "plus",
      requires_reauth: true,
      reauth_reason: "refresh_token needs re-authorization",
      quota_error: {
        code: "refresh_token_invalidated",
        message: "{\"error\":\"refresh_token_invalidated\"}",
      },
      token_status: {
        accessAvailable: true,
        refreshAvailable: true,
        expired: false,
        timeLeft: 3600,
      },
    }]),
  }));

  const snapshot = await desktopApi.loadDashboardState();
  assert.equal(snapshot.accounts[0].status, "SUSPENDED");
  assert.equal(
    snapshot.accounts[0].warning,
    "该账号需要重新授权后才能刷新 Token。",
  );
});

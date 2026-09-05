// End-to-end smoke test: start the real Electron app against throw-away data
// directories, drive the window over the Chrome DevTools Protocol, and check
// that the shell renders and the main flows respond. Unit tests and the type
// checker cannot see a hook wired in the wrong order or an event subscription
// that never fires; this can.
//
//   npm run test:e2e
//
// Two runs. The first uses an empty store and covers the first-launch
// screens. The second seeds Codex, Cursor and Antigravity accounts (legacy
// plaintext records, which the app migrates to encrypted ones on read) and
// points every upstream API at a local stub through CODEX_MANAGER_API_ORIGIN,
// so account cards, quota bars, the "needs reauthorization" copy and the
// quota lens are exercised with no real credentials and no real network.
//
// APPDATA/LOCALAPPDATA are redirected too, so the run never reads the real
// Cursor or Antigravity login databases and Electron keeps its own userData
// (and single-instance lock) away from an installed copy.
//
// Set E2E_APP_BINARY to a packaged "Quota Switcher.exe" to run the same flows
// against a built app (asar-packed) instead of the source tree.
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const STARTUP_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 30_000;
const DAY_SECONDS = 24 * 60 * 60;

function log(message) {
  console.log(`[e2e] ${message}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(2000, () => request.destroy(new Error("timed out")));
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not happen within ${timeoutMs} ms${lastError ? `: ${lastError.message}` : ""}`);
}

function makeSandbox() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "quota-switcher-e2e-"));
  const dirs = {
    data: path.join(sandbox, "data"),
    codex: path.join(sandbox, "codex"),
    roaming: path.join(sandbox, "AppData", "Roaming"),
    local: path.join(sandbox, "AppData", "Local"),
    // Electron resolves userData through the Windows shell, not the APPDATA
    // variable, so the profile (and the single-instance lock) is moved
    // explicitly; an installed copy can keep running during the test.
    userData: path.join(sandbox, "userData"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return { sandbox, dirs };
}

// ---------------------------------------------------------------------------
// Seeded accounts. Tokens are fake JWTs whose payload carries an "e2e"
// scenario the stub server reads back; Antigravity tokens are opaque strings
// with the scenario in clear text, like the real ones are opaque.

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.e2e-signature`;
}

function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function codexAccount({ scenario, email, lastUsed, now }) {
  const accountId = `acct_e2e_${scenario}`;
  const auth = { chatgpt_account_id: accountId, chatgpt_plan_type: "plus", user_id: `user_e2e_${scenario}` };
  const exp = now + 30 * DAY_SECONDS;
  return {
    id: `codex_e2e${scenario}`,
    email,
    plan_type: "plus",
    subscription_active_until: null,
    account_id: accountId,
    user_id: `user_e2e_${scenario}`,
    organization_id: null,
    auth_mode: "oauth",
    tokens: {
      id_token: fakeJwt({ sub: `user_e2e_${scenario}`, exp, email, email_verified: true, "https://api.openai.com/auth": auth }),
      access_token: fakeJwt({ sub: `user_e2e_${scenario}`, exp, e2e: scenario, "https://api.openai.com/auth": auth, "https://api.openai.com/profile": { email } }),
      refresh_token: `rt-codex-${scenario}`,
      account_id: accountId,
    },
    token_generation: 1,
    token_updated_at: now - DAY_SECONDS,
    token_source_mode: "managed",
    requires_reauth: false,
    reauth_reason: null,
    banned: false,
    quota: null,
    quota_error: null,
    probe: null,
    usage_updated_at: null,
    quota_refresh_failures: 0,
    quota_next_retry_at: null,
    created_at: now - 7 * DAY_SECONDS,
    last_used: lastUsed,
  };
}

function cursorAccount({ scenario, email, lastUsed, now }) {
  const authId = `auth0|user_e2e${scenario}`;
  return {
    id: `cursor_e2e${scenario}`,
    platform: "cursor",
    email,
    plan_type: "pro",
    subscription_status: "active",
    auth_id: authId,
    auth_mode: "oauth",
    tokens: {
      access_token: fakeJwt({ sub: authId, exp: now + 30 * DAY_SECONDS, e2e: scenario }),
      refresh_token: `rt-cursor-${scenario}`,
      auth_id: authId,
    },
    token_generation: 1,
    token_updated_at: now - DAY_SECONDS,
    token_source_mode: "managed",
    requires_reauth: false,
    reauth_reason: null,
    banned: false,
    quota: null,
    quota_error: null,
    probe: null,
    usage_updated_at: null,
    created_at: now - 7 * DAY_SECONDS,
    last_used: lastUsed,
  };
}

function antigravityAccount({ scenario, email, lastUsed, now }) {
  const authId = `ag-e2e-${scenario}`;
  return {
    id: `antigravity_e2e${scenario}`,
    platform: "antigravity",
    email,
    plan_type: "free-tier",
    auth_id: authId,
    auth_mode: "oauth",
    tokens: {
      access_token: `ya29.e2e-${scenario}`,
      refresh_token: `rt-antigravity-${scenario}`,
      expiry_timestamp: now + 30 * DAY_SECONDS,
      token_type: "Bearer",
      auth_id: authId,
    },
    token_generation: 1,
    token_updated_at: now - DAY_SECONDS,
    token_source_mode: "managed",
    requires_reauth: false,
    reauth_reason: null,
    banned: false,
    quota: null,
    quota_error: null,
    probe: null,
    usage_updated_at: null,
    created_at: now - 7 * DAY_SECONDS,
    last_used: lastUsed,
  };
}

function buildFixtures() {
  const now = Math.floor(Date.now() / 1000);
  return {
    codex: {
      ok: codexAccount({ scenario: "ok", email: "good.codex@example.com", lastUsed: now, now }),
      reauth: codexAccount({ scenario: "reauth", email: "expired.codex@example.com", lastUsed: now - DAY_SECONDS, now }),
    },
    cursor: {
      ok: cursorAccount({ scenario: "ok", email: "good.cursor@example.com", lastUsed: now, now }),
      reauth: cursorAccount({ scenario: "reauth", email: "expired.cursor@example.com", lastUsed: now - DAY_SECONDS, now }),
    },
    antigravity: {
      ok: antigravityAccount({ scenario: "ok", email: "good.antigravity@example.com", lastUsed: now, now }),
      reauth: antigravityAccount({ scenario: "reauth", email: "expired.antigravity@example.com", lastUsed: now - DAY_SECONDS, now }),
    },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function summary(account) {
  return {
    id: account.id,
    email: account.email,
    plan_type: account.plan_type,
    subscription_active_until: account.subscription_active_until || null,
    created_at: account.created_at,
    last_used: account.last_used,
  };
}

function seedStore(dirs, fixtures) {
  const stores = [
    ["codex", "accounts", "accounts.json", "current_account_id", "2.0"],
    ["cursor", "cursor-accounts", "cursor-accounts.json", "current_cursor_account_id", "1.0"],
    ["antigravity", "antigravity-accounts", "antigravity-accounts.json", "current_antigravity_account_id", "1.0"],
  ];
  for (const [product, dir, indexName, currentField, version] of stores) {
    const accounts = Object.values(fixtures[product]);
    for (const account of accounts) {
      writeJson(path.join(dirs.data, dir, `${account.id}.json`), account);
    }
    writeJson(path.join(dirs.data, indexName), {
      version,
      accounts: accounts.map(summary),
      [currentField]: fixtures[product].ok.id,
    });
  }
  // The official Codex login mirrors the current managed account, so the
  // dashboard starts aligned instead of asking to resolve a login conflict.
  const current = fixtures.codex.ok;
  writeJson(path.join(dirs.codex, "auth.json"), {
    auth_mode: null,
    OPENAI_API_KEY: null,
    tokens: {
      id_token: current.tokens.id_token,
      access_token: current.tokens.access_token,
      refresh_token: current.tokens.refresh_token,
      account_id: current.account_id,
    },
    last_refresh: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Upstream API stub. Routes on the real paths (the app only swaps origins) and
// answers per scenario: "ok" accounts get usage, "reauth" accounts get 401s
// and a rejected refresh token, which is what a revoked login looks like.

function codexUsedPercent(callIndex) {
  // Each poll uses a little more so a manual refresh visibly changes the card.
  return 20 + Math.min(callIndex, 6) * 5;
}

function isoIn(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function startStub() {
  const requests = [];
  const unexpected = [];
  const counts = new Map();
  const bump = (key) => {
    const next = (counts.get(key) || 0) + 1;
    counts.set(key, next);
    return next;
  };

  const scenarioOf = (request, body) => {
    const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const cookie = String(request.headers.cookie || "").match(/WorkosCursorSessionToken=([^;]+)/);
    const cookieToken = cookie ? decodeURIComponent(cookie[1]).split("::").pop() : "";
    for (const token of [bearer, cookieToken]) {
      if (!token) continue;
      const claims = jwtClaims(token);
      if (claims?.e2e) return claims.e2e;
      const plain = token.match(/e2e-([a-z]+)/);
      if (plain) return plain[1];
    }
    const fromBody = String(body || "").match(/rt-[a-z]+-([a-z]+)/);
    return fromBody ? fromBody[1] : "unknown";
  };

  const routes = {
    // OpenAI, Cursor and Google token endpoints all land here.
    "POST /oauth/token": (scenario) => scenario === "ok"
      ? [200, { access_token: fakeJwt({ sub: "user_e2e_ok", exp: Math.floor(Date.now() / 1000) + DAY_SECONDS, e2e: "ok" }), refresh_token: "rt-codex-ok", token_type: "Bearer", expires_in: 3600 }]
      : [400, { error: "invalid_grant", error_description: "The refresh token is invalid or has been revoked" }],
    "POST /token": (scenario) => scenario === "ok"
      ? [200, { access_token: "ya29.e2e-ok", token_type: "Bearer", expires_in: 3599 }]
      : [400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }],
    "GET /backend-api/wham/usage": (scenario) => {
      if (scenario !== "ok") return [401, { detail: "Unauthorized" }];
      const used = codexUsedPercent(bump("codex-usage-ok") - 1);
      return [200, {
        plan_type: "plus",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: used, limit_window_seconds: 5 * 3600, reset_after_seconds: 3600 },
          secondary_window: { used_percent: 45, limit_window_seconds: 7 * DAY_SECONDS, reset_after_seconds: 3 * DAY_SECONDS },
        },
      }];
    },
    "GET /api/usage-summary": (scenario) => scenario === "ok"
      ? [200, {
        membershipType: "pro",
        billingCycleEnd: isoIn(12 * DAY_SECONDS),
        individualUsage: { plan: { totalPercentUsed: 30, autoPercentUsed: 10, apiPercentUsed: 50 } },
      }]
      : [401, { error: "unauthorized" }],
    "POST /aiserver.v1.AuthService/GetUserMeta": () => [200, { email: "good.cursor@example.com" }],
    "GET /oauth2/v2/userinfo": () => [200, { email: "good.antigravity@example.com" }],
    "POST /v1internal:loadCodeAssist": (scenario) => scenario === "ok"
      ? [200, { currentTier: { id: "free-tier", name: "Free" }, cloudaicompanionProject: "e2e-project", allowedTiers: [] }]
      : [401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }],
    "POST /v1internal:onboardUser": () => [200, { done: true, response: { cloudaicompanionProject: "e2e-project" } }],
    "POST /v1internal:fetchAvailableModels": () => [200, {}],
    "POST /v1internal:retrieveUserQuota": () => [200, {}],
    "POST /v1internal:retrieveUserQuotaSummary": () => [200, {
      groups: [
        { displayName: "Gemini", buckets: [
          { bucketId: "gemini-5h", remainingFraction: 0.7, resetTime: isoIn(2 * 3600) },
          { bucketId: "gemini-weekly", remainingFraction: 0.45, resetTime: isoIn(3 * DAY_SECONDS) },
        ] },
        { displayName: "Claude", buckets: [
          { bucketId: "3p-5h", remainingFraction: 0.9, resetTime: isoIn(2 * 3600) },
          { bucketId: "3p-weekly", remainingFraction: 0.6, resetTime: isoIn(3 * DAY_SECONDS) },
        ] },
      ],
    }],
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      const key = `${request.method} ${pathname}`;
      const scenario = scenarioOf(request, body);
      requests.push({ key, scenario });
      const route = routes[key];
      if (!route) {
        unexpected.push(`${key} (${scenario})`);
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected request in e2e stub" }));
        return;
      }
      const [status, payload] = route(scenario);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        requests,
        unexpected,
        count: (key, scenario) => requests.filter((item) => item.key === key && (!scenario || item.scenario === scenario)).length,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Launching the app and running one scenario against it.

function appLaunch() {
  const packaged = String(process.env.E2E_APP_BINARY || "").trim();
  if (packaged) return { binary: packaged, args: [], what: `packaged ${path.basename(packaged)}` };
  return { binary: require("electron"), args: ["."], what: "electron ." };
}

async function runApp({ dirs, extraEnv = {}, label }, body) {
  const port = await freePort();
  const launch = appLaunch();
  const env = {
    ...process.env,
    CODEX_MANAGER_DATA_DIR: dirs.data,
    CODEX_MANAGER_CODEX_DIR: dirs.codex,
    APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local,
    ELECTRON_ENABLE_LOGGING: "1",
    ...extraEnv,
  };
  log(`[${label}] ${launch.what}, CDP port ${port}`);
  const child = spawn(launch.binary, [...launch.args, `--remote-debugging-port=${port}`, `--user-data-dir=${dirs.userData}`], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const processOutput = [];
  child.stdout.on("data", (chunk) => processOutput.push(String(chunk)));
  child.stderr.on("data", (chunk) => processOutput.push(String(chunk)));
  let exited = false;
  child.on("exit", (code) => {
    exited = true;
    log(`[${label}] electron exited with ${code}`);
  });

  const problems = [];
  let browser = null;
  let failed = false;
  try {
    const cdpUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      if (exited) throw new Error("electron exited before the CDP endpoint came up");
      const version = await fetchJson(`${cdpUrl}/json/version`);
      return !!version?.webSocketDebuggerUrl;
    }, STARTUP_TIMEOUT_MS, "CDP endpoint");
    browser = await chromium.connectOverCDP(cdpUrl);

    const pages = () => browser.contexts().flatMap((context) => context.pages());
    const page = await waitFor(async () => (
      pages().find((item) => !item.url().includes("#float") && item.url() !== "about:blank") || null
    ), STARTUP_TIMEOUT_MS, "main window page");
    const watch = (target, prefix) => {
      target.on("pageerror", (error) => problems.push(`${prefix}pageerror: ${error.message}`));
      target.on("console", (message) => {
        if (message.type() === "error") problems.push(`${prefix}console.error: ${message.text()}`);
      });
    };
    watch(page, "");

    await page.waitForSelector("#app-sidebar", { timeout: STARTUP_TIMEOUT_MS });
    await page.waitForSelector("#dashboard-loading-state", { state: "detached", timeout: STARTUP_TIMEOUT_MS });
    if (await page.locator("#dashboard-load-error-state").count()) {
      throw new Error(`dashboard failed to load: ${await page.locator("#dashboard-load-error-state").innerText()}`);
    }
    if (await page.locator("#renderer-crash-screen").count()) {
      throw new Error(`renderer crashed: ${await page.locator("#renderer-crash-message").innerText()}`);
    }

    // Opens the desktop quota lens (a second renderer entry) from Settings.
    const openLens = async () => {
      await page.click("#sidebar-nav-settings");
      await page.waitForSelector("#btn-show-float-lens", { timeout: STEP_TIMEOUT_MS });
      await page.click("#btn-show-float-lens");
      const lens = await waitFor(async () => pages().find((item) => item.url().includes("#float")) || null, STEP_TIMEOUT_MS, "float lens window");
      watch(lens, "lens ");
      await lens.waitForSelector(".float-lens-shell", { timeout: STEP_TIMEOUT_MS });
      await lens.waitForSelector("#float-lens-mark", { timeout: STEP_TIMEOUT_MS });
      return lens;
    };

    await body({ page, openLens, log: (message) => log(`[${label}] ${message}`) });

    if (await page.locator("#renderer-crash-screen").count()) {
      throw new Error("renderer crashed during the flow");
    }
    // Chromium reports blocked-by-CSP and failed asset loads as console
    // errors; none of those may appear in a healthy build.
    if (problems.length) {
      throw new Error(`renderer reported problems:\n${problems.join("\n")}`);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await browser?.close(); } catch {}
    if (!exited) {
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (!exited && process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      }
    }
    if (failed && processOutput.length) {
      console.error(`[e2e] [${label}] electron output (tail):`);
      console.error(processOutput.join("").slice(-4000));
    }
  }
}

async function expectPresent(page, ids, where) {
  for (const id of ids) {
    if (!(await page.locator(`#${id}`).count())) throw new Error(`#${id} is missing from ${where}`);
  }
}

async function expectAbsent(page, id, reason) {
  if (await page.locator(`#${id}`).count()) throw new Error(`#${id} is showing but ${reason}`);
}

async function waitForText(page, selector, pattern, label) {
  let lastText = null;
  try {
    return await waitFor(async () => {
      const locator = page.locator(selector);
      if (!(await locator.count())) {
        lastText = null;
        return false;
      }
      lastText = await locator.first().innerText();
      return pattern.test(lastText) ? lastText : false;
    }, STEP_TIMEOUT_MS, `${label} (${selector} matching ${pattern})`);
  } catch (error) {
    error.message += lastText === null ? "; the element never appeared" : `; last text was ${JSON.stringify(lastText)}`;
    throw error;
  }
}

async function selectProduct(page, product, labelText) {
  await page.click(`#sidebar-product-${product}`);
  await waitFor(async () => (await page.locator("#accounts-meta-labels").innerText()).includes(labelText), STEP_TIMEOUT_MS, `${labelText} product selected`);
}

// ---------------------------------------------------------------------------
// Scenario 1: nothing stored yet.

async function emptyStoreScenario() {
  const { sandbox, dirs } = makeSandbox();
  try {
    await runApp({ dirs, label: "empty" }, async ({ page, openLens, log }) => {
      await expectPresent(page, ["sidebar-nav-accounts", "sidebar-nav-quotas", "sidebar-nav-settings", "sidebar-product-dock", "app-header"], "the shell");
      await expectAbsent(page, "sidebar-nav-autoswitch", "the auto-switch page was removed");
      log("shell rendered");

      await page.click("#sidebar-nav-accounts");
      await page.waitForSelector("#accounts-view-container", { timeout: STEP_TIMEOUT_MS });
      await page.waitForSelector("#accounts-empty-state", { timeout: STEP_TIMEOUT_MS });
      await selectProduct(page, "cursor", "Cursor");
      await page.waitForSelector("#accounts-empty-state", { timeout: STEP_TIMEOUT_MS });
      await selectProduct(page, "antigravity", "Antigravity");
      await page.waitForSelector("#accounts-empty-state", { timeout: STEP_TIMEOUT_MS });
      await selectProduct(page, "codex", "Codex");
      log("every product shows its empty state");

      await page.click("#sidebar-nav-quotas");
      await page.waitForSelector("#quotas-view-container", { timeout: STEP_TIMEOUT_MS });
      await page.waitForSelector("#quotas-empty-state", { timeout: STEP_TIMEOUT_MS });
      log("quotas view shows its empty state");

      const lens = await openLens();
      await lens.waitForSelector(".float-lens-empty", { timeout: STEP_TIMEOUT_MS });
      if (await lens.locator("#renderer-crash-screen").count()) {
        throw new Error(`float lens crashed: ${await lens.locator("#renderer-crash-message").innerText()}`);
      }
      log("float lens renders its empty state");
    });
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: seeded accounts, quota calls answered by the stub.

async function seededStoreScenario() {
  const { sandbox, dirs } = makeSandbox();
  const fixtures = buildFixtures();
  seedStore(dirs, fixtures);
  const stub = await startStub();
  try {
    await runApp({ dirs, extraEnv: { CODEX_MANAGER_API_ORIGIN: stub.origin }, label: "seeded" }, async ({ page, openLens, log }) => {
      const { codex, cursor, antigravity } = fixtures;

      // The official login was seeded to match the current account, so no
      // conflict banner; the sandbox login stores are in the known formats,
      // so no format-drift banner either.
      await expectAbsent(page, "auth-status-banner", "the seeded official Codex login matches the current account");
      await expectAbsent(page, "format-drift-banner", "the sandbox login stores are in the expected formats");

      // Codex cards: one account gets its quota, the other is asked to
      // reauthorize after the stub rejects its refresh token.
      await page.click("#sidebar-nav-accounts");
      await page.waitForSelector("#accounts-cards-grid", { timeout: STEP_TIMEOUT_MS });
      await expectAbsent(page, "accounts-empty-state", "accounts were seeded");
      await expectPresent(page, [`account-manage-card-${codex.ok.id}`, `account-manage-card-${codex.reauth.id}`], "the Codex accounts view");
      // The app may poll the current account more than once while it starts,
      // so the card is checked against the stub's latest answer.
      const usageKey = "GET /backend-api/wham/usage";
      const fiveHourMatchesStub = async () => {
        const calls = stub.count(usageKey, "ok");
        if (!calls) return false;
        const text = await page.locator(`#quota-box-fiveHour-${codex.ok.id}`).innerText();
        return text.includes(`${100 - codexUsedPercent(calls - 1)}%`) ? text : false;
      };
      await waitFor(fiveHourMatchesStub, STEP_TIMEOUT_MS, "Codex five-hour quota matching the stub");
      await waitForText(page, `#quota-box-weekly-${codex.ok.id}`, /55%/, "Codex weekly quota");
      await waitForText(page, `#account-m-badges-${codex.reauth.id}`, /需重新授权/, "Codex reauthorization copy");
      await expectPresent(page, [`action-reauthorize-${codex.reauth.id}`, "current-account-badge"], "the Codex cards");
      if (!(await page.locator(`#account-manage-card-${codex.ok.id} #current-account-badge`).count())) {
        throw new Error("the seeded current Codex account does not carry the current badge");
      }
      log("Codex cards show quota and the reauthorization copy");

      // A manual refresh goes through the same path and repaints the card.
      const usageCalls = stub.count(usageKey, "ok");
      await page.click(`#action-refresh-${codex.ok.id}`);
      await waitFor(() => stub.count(usageKey, "ok") > usageCalls, STEP_TIMEOUT_MS, "manual refresh reaching the usage endpoint");
      await waitFor(fiveHourMatchesStub, STEP_TIMEOUT_MS, "refreshed Codex five-hour quota matching the stub");
      log("manual refresh repaints the Codex card");

      // Cursor: plan/auto/API bars.
      await selectProduct(page, "cursor", "Cursor");
      await expectPresent(page, [`account-manage-card-${cursor.ok.id}`, `account-manage-card-${cursor.reauth.id}`], "the Cursor accounts view");
      await waitForText(page, `#quota-box-plan-${cursor.ok.id}`, /70%/, "Cursor plan quota");
      await waitForText(page, `#quota-box-auto-${cursor.ok.id}`, /90%/, "Cursor auto quota");
      await waitForText(page, `#quota-box-api-${cursor.ok.id}`, /50%/, "Cursor API quota");
      await waitForText(page, `#account-m-badges-${cursor.reauth.id}`, /需重新授权/, "Cursor reauthorization copy");
      log("Cursor cards show quota and the reauthorization copy");

      // Antigravity: Gemini and Claude/GPT families, weekly and five-hour.
      await selectProduct(page, "antigravity", "Antigravity");
      await expectPresent(page, [`account-manage-card-${antigravity.ok.id}`, `account-manage-card-${antigravity.reauth.id}`], "the Antigravity accounts view");
      await waitForText(page, `#quota-box-gemini-${antigravity.ok.id}`, /45%[\s\S]*70%/, "Antigravity Gemini quota");
      await waitForText(page, `#quota-box-third_party-${antigravity.ok.id}`, /60%[\s\S]*90%/, "Antigravity Claude/GPT quota");
      await waitForText(page, `#account-m-badges-${antigravity.reauth.id}`, /需重新授权/, "Antigravity reauthorization copy");
      log("Antigravity cards show quota and the reauthorization copy");

      // Quotas view lists the same accounts; settings still render.
      await selectProduct(page, "codex", "Codex");
      await page.click("#sidebar-nav-quotas");
      await page.waitForSelector("#quotas-view-container", { timeout: STEP_TIMEOUT_MS });
      await expectAbsent(page, "quotas-empty-state", "accounts were seeded");
      await expectPresent(page, [`quota-account-card-${codex.ok.id}`, `quota-account-card-${codex.reauth.id}`], "the quotas view");
      await waitForText(page, `#quota-account-card-${codex.ok.id}`, /\d+%/, "Codex quota card percentage");
      await page.click("#sidebar-nav-settings");
      await page.waitForSelector("#settings-view-container", { timeout: STEP_TIMEOUT_MS });
      await expectPresent(page, ["card-daemon-settings", "btn-toggle-daemon", "card-client-detect", "client-detect-status"], "settings");
      log("quotas and settings render with accounts");

      // The add-account dialog opens and closes without touching OAuth.
      await page.click("#sidebar-nav-accounts");
      await page.waitForSelector("#btn-add-account-modal-trigger", { timeout: STEP_TIMEOUT_MS });
      await page.click("#btn-add-account-modal-trigger");
      await page.waitForSelector("#add-account-modal", { timeout: STEP_TIMEOUT_MS });
      await page.click("#btn-close-modal");
      await page.waitForSelector("#add-account-modal", { state: "detached", timeout: STEP_TIMEOUT_MS });
      log("add-account dialog opens and closes");

      // Notification drawer.
      await page.click("#header-btn-notifications");
      await page.waitForSelector("#notification-sidebar-center", { timeout: STEP_TIMEOUT_MS });
      await page.keyboard.press("Escape");
      await page.waitForSelector("#notification-sidebar-center", { state: "detached", timeout: STEP_TIMEOUT_MS });
      log("notification drawer opens and closes");

      // The quota lens shows the current account with its dial, and pages to
      // the other one. Switching is never confirmed here.
      const lens = await openLens();
      await lens.waitForSelector(".float-lens-identity", { timeout: STEP_TIMEOUT_MS });
      await waitForText(lens, ".float-lens-name-local", /good\.codex/, "lens shows the current account");
      await waitForText(lens, ".float-lens-count", /01 \/ 02/, "lens counts both accounts");
      await waitForText(lens, ".float-lens-readout", /\d+/, "lens dial shows a number");
      await lens.click("button[title='下一个账号']");
      await waitForText(lens, ".float-lens-name-local", /expired\.codex/, "lens pages to the other account");
      await waitForText(lens, ".float-lens-count", /02 \/ 02/, "lens counter moves");
      await waitForText(lens, ".float-lens-body", /需重新授权/, "lens shows the reauthorization state");
      if (await lens.locator(".float-lens-empty").count()) throw new Error("the lens shows its empty state although accounts exist");
      log("float lens shows accounts and pages between them");

      if (stub.unexpected.length) {
        throw new Error(`the app called endpoints the stub does not know:\n${stub.unexpected.join("\n")}`);
      }
      log(`stub answered ${stub.requests.length} requests`);
    });
  } catch (error) {
    const seen = stub.requests.map((item) => `${item.key} [${item.scenario}]`);
    error.message += `\nstub saw ${seen.length} request(s):\n${seen.join("\n") || "(none)"}`;
    throw error;
  } finally {
    await stub.close();
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  await emptyStoreScenario();
  await seededStoreScenario();
  log("OK");
}

main().catch((error) => {
  console.error(`[e2e] FAILED: ${error.message}`);
  process.exitCode = 1;
});

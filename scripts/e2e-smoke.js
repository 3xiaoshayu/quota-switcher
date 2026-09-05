// End-to-end smoke test: start the real Electron app against an empty,
// throw-away data directory, drive the window over the Chrome DevTools
// Protocol, and check that the shell renders and the main flows respond.
// Unit tests and the type checker cannot see a hook wired in the wrong order
// or an event subscription that never fires; this can.
//
//   npm run test:e2e
//
// APPDATA/LOCALAPPDATA are redirected too, so the run never reads the real
// Cursor or Antigravity login databases and Electron keeps its own userData
// (and single-instance lock) away from an installed copy.
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

async function main() {
  const { sandbox, dirs } = makeSandbox();
  const port = await freePort();
  const electronBinary = require("electron");
  const env = {
    ...process.env,
    CODEX_MANAGER_DATA_DIR: dirs.data,
    CODEX_MANAGER_CODEX_DIR: dirs.codex,
    APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local,
    ELECTRON_ENABLE_LOGGING: "1",
  };
  log(`sandbox ${sandbox}, CDP port ${port}`);
  const child = spawn(electronBinary, [".", `--remote-debugging-port=${port}`, `--user-data-dir=${dirs.userData}`], {
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
    log(`electron exited with ${code}`);
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

    const page = await waitFor(async () => {
      const pages = browser.contexts().flatMap((context) => context.pages());
      return pages.find((item) => !item.url().includes("#float") && item.url() !== "about:blank") || null;
    }, STARTUP_TIMEOUT_MS, "main window page");
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
    });

    // Shell.
    await page.waitForSelector("#app-sidebar", { timeout: STARTUP_TIMEOUT_MS });
    await page.waitForSelector("#dashboard-loading-state", { state: "detached", timeout: STARTUP_TIMEOUT_MS });
    if (await page.locator("#dashboard-load-error-state").count()) {
      throw new Error(`dashboard failed to load: ${await page.locator("#dashboard-load-error-state").innerText()}`);
    }
    if (await page.locator("#renderer-crash-screen").count()) {
      throw new Error(`renderer crashed: ${await page.locator("#renderer-crash-message").innerText()}`);
    }
    for (const id of ["sidebar-nav-accounts", "sidebar-nav-quotas", "sidebar-nav-settings", "sidebar-product-dock", "app-header"]) {
      if (!(await page.locator(`#${id}`).count())) throw new Error(`#${id} is missing from the shell`);
    }
    if (await page.locator("#sidebar-nav-autoswitch").count()) throw new Error("the removed auto-switch page is back");
    log("shell rendered");

    // Accounts view on an empty store, then a product change.
    await page.click("#sidebar-nav-accounts");
    await page.waitForSelector("#accounts-view-container", { timeout: STEP_TIMEOUT_MS });
    await page.waitForSelector("#accounts-empty-state", { timeout: STEP_TIMEOUT_MS });
    await page.click("#sidebar-product-cursor");
    await waitFor(async () => (await page.locator("#accounts-meta-labels").innerText()).includes("Cursor"), STEP_TIMEOUT_MS, "Cursor product selected");
    await page.click("#sidebar-product-antigravity");
    await waitFor(async () => (await page.locator("#accounts-meta-labels").innerText()).includes("Antigravity"), STEP_TIMEOUT_MS, "Antigravity product selected");
    await page.click("#sidebar-product-codex");
    await waitFor(async () => (await page.locator("#accounts-meta-labels").innerText()).includes("Codex"), STEP_TIMEOUT_MS, "Codex product selected");
    log("accounts view and product dock respond");

    // Quotas and settings.
    await page.click("#sidebar-nav-quotas");
    await page.waitForSelector("#quotas-view-container", { timeout: STEP_TIMEOUT_MS });
    await page.click("#sidebar-nav-settings");
    await page.waitForSelector("#settings-view-container", { timeout: STEP_TIMEOUT_MS });
    for (const id of ["card-daemon-settings", "btn-toggle-daemon", "card-client-detect", "client-detect-status"]) {
      if (!(await page.locator(`#${id}`).count())) throw new Error(`#${id} is missing from settings`);
    }
    log("quotas and settings render");

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

    if (await page.locator("#renderer-crash-screen").count()) {
      throw new Error("renderer crashed during the flow");
    }
    // Chromium reports blocked-by-CSP and failed asset loads as console
    // errors; none of those may appear in a healthy build.
    if (problems.length) {
      throw new Error(`renderer reported problems:\n${problems.join("\n")}`);
    }
    log("OK");
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
      console.error("[e2e] electron output (tail):");
      console.error(processOutput.join("").slice(-4000));
    }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(`[e2e] FAILED: ${error.message}`);
  process.exitCode = 1;
});

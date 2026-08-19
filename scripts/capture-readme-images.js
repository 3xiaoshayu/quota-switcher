// Capture synthetic README screenshots from the Vite renderer preview.
// Start `npx vite --config vite.renderer.config.ts --host 127.0.0.1 --port 5173`
// first, with playwright-core available to Node (`npm install --no-save playwright-core`).

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "docs", "images");
const iconPath = path.join(root, "resources", "icon.png");
const baseUrl = process.env.README_CAPTURE_URL || "http://127.0.0.1:5173";

const VIEWPORT = { width: 1440, height: 812 };
const SCALE = 1.5;

async function openPage(browser, url, ready) {
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
  });
  await page.addInitScript((auth) => {
    if (auth) {
      localStorage.setItem("codex_auth_status", "true");
      localStorage.setItem("codex_auth_email", "ops-01-primary@codex.local");
    } else {
      localStorage.removeItem("codex_auth_status");
      localStorage.removeItem("codex_auth_email");
    }
  }, ready === "dashboard");
  await page.goto(url, { waitUntil: "networkidle" });
  await page.addStyleTag({
    content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
  });
  return page;
}

async function save(page, name, options) {
  const target = path.join(outDir, name);
  await page.screenshot({
    path: target,
    type: "png",
    ...options,
  });
  console.log(`wrote ${name}`);
}

async function captureAppPages(browser) {
  const page = await openPage(browser, `${baseUrl}/`, "dashboard");
  await page.waitForSelector("#dashboard-main-container");
  await page.waitForTimeout(400);

  const shots = [
    ["accounts", "account-dashboard.png"],
    ["quotas", "quota-overview.png"],
    ["autoswitch", "auto-switch.png"],
    ["settings", "settings.png"],
  ];
  for (const [tab, file] of shots) {
    await page.click(`#sidebar-nav-${tab}`);
    await page.waitForTimeout(250);
    await save(page, file, { fullPage: false });
  }
  await page.close();
}

async function captureLogin(browser) {
  const page = await openPage(browser, `${baseUrl}/?desktopLogin=1`, "login");
  await page.waitForSelector("#login-card");
  await page.waitForTimeout(300);
  await save(page, "login.png", { fullPage: false });
  await page.close();
}

async function captureFloatLens(browser) {
  const page = await openPage(browser, `${baseUrl}/#float`, "dashboard");
  await page.waitForSelector(".float-lens-shell");
  await page.evaluate(() => {
    document.documentElement.style.background = "#0b0b0d";
    document.body.style.background = "#0b0b0d";
    const root = document.getElementById("root");
    if (root) root.style.background = "#0b0b0d";
  });
  await page.waitForTimeout(300);
  const current = await page.locator(".float-lens-shell").screenshot({ type: "png" });
  await page.locator('button[title="下一个账号"]').click();
  await page.waitForTimeout(200);
  const preview = await page.locator(".float-lens-shell").screenshot({ type: "png" });
  await page.close();

  const board = await browser.newPage({
    viewport: { width: 760, height: 620 },
    deviceScaleFactor: 2,
  });
  const currentUri = `data:image/png;base64,${current.toString("base64")}`;
  const previewUri = `data:image/png;base64,${preview.toString("base64")}`;
  await board.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; background: #0b0b0d; font-family: "Segoe UI", sans-serif; }
  .wrap { display: flex; gap: 28px; align-items: end; justify-content: center; padding: 28px 24px 22px; }
  figure { margin: 0; text-align: center; }
  img { width: 288px; height: auto; display: block; }
  figcaption { margin-top: 12px; color: rgba(235,235,245,0.58); font-size: 13px; letter-spacing: 0.04em; }
</style></head>
<body>
  <div class="wrap">
    <figure>
      <img src="${currentUri}" alt="current account">
      <figcaption>当前账号</figcaption>
    </figure>
    <figure>
      <img src="${previewUri}" alt="preview account">
      <figcaption>预览其他账号</figcaption>
    </figure>
  </div>
</body></html>`);
  await board.waitForTimeout(150);
  await save(board, "float-lens.png", { fullPage: true });
  await board.close();
}

async function captureTrayMenu(browser) {
  const iconUri = `data:image/png;base64,${fs.readFileSync(iconPath).toString("base64")}`;
  const page = await browser.newPage({
    viewport: { width: 520, height: 280 },
    deviceScaleFactor: 2,
  });
  await page.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; background: #0b0b0d; font-family: "Segoe UI Variable", "Segoe UI", sans-serif; }
  .scene { position: relative; width: 520px; height: 280px; overflow: hidden; }
  .taskbar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 48px;
    background: rgba(32,32,32,0.94);
    border-top: 1px solid rgba(255,255,255,0.08);
    display: flex; align-items: center; justify-content: flex-end;
    padding: 0 18px 0 0; gap: 10px;
  }
  .clock { color: rgba(255,255,255,0.78); font-size: 12px; line-height: 1.15; text-align: right; }
  .tray-icon {
    width: 22px; height: 22px; border-radius: 5px;
    box-shadow: 0 0 0 4px rgba(255,255,255,0.06);
  }
  .menu {
    position: absolute; right: 16px; bottom: 58px; width: 196px;
    background: rgba(44,44,44,0.94);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    box-shadow: 0 18px 40px rgba(0,0,0,0.45);
    padding: 4px;
    color: #fff;
    font-size: 13px;
  }
  .item { padding: 8px 12px; border-radius: 4px; }
  .item.active { background: rgba(255,255,255,0.08); }
  .sep { height: 1px; margin: 4px 8px; background: rgba(255,255,255,0.1); }
</style></head>
<body>
  <div class="scene">
    <div class="menu">
      <div class="item active">打开窗口</div>
      <div class="item">打开桌面额度</div>
      <div class="sep"></div>
      <div class="item">退出</div>
    </div>
    <div class="taskbar">
      <img class="tray-icon" src="${iconUri}" alt="">
      <div class="clock">托盘<br>右键菜单</div>
    </div>
  </div>
</body></html>`);
  await page.waitForTimeout(150);
  await save(page, "tray-menu.png", { fullPage: false });
  await page.close();
}

async function captureSocialPreview(browser) {
  const dashPath = path.join(outDir, "account-dashboard.png");
  const dashUri = `data:image/png;base64,${fs.readFileSync(dashPath).toString("base64")}`;
  const iconUri = `data:image/png;base64,${fs.readFileSync(iconPath).toString("base64")}`;
  const page = await browser.newPage({
    viewport: { width: 1280, height: 640 },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; }
  .og {
    width: 1280px; height: 640px; display: flex; overflow: hidden;
    background: #0b0b0d; color: #f5f5f7;
    font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
  }
  .copy { width: 470px; padding: 72px 48px 56px 64px; box-sizing: border-box; }
  .icon { width: 72px; height: 72px; border-radius: 18px; display: block; }
  h1 { margin: 28px 0 0; font-size: 36px; line-height: 1.15; font-weight: 650; letter-spacing: -0.03em; }
  p { margin: 16px 0 0; font-size: 18px; line-height: 1.45; color: rgba(235,235,245,0.72); }
  .meta { margin-top: 28px; font-size: 13px; color: rgba(235,235,245,0.46); letter-spacing: 0.04em; }
  .preview {
    flex: 1; position: relative;
    background: radial-gradient(80% 70% at 70% 20%, rgba(255,255,255,0.06), transparent 60%);
  }
  .preview img {
    position: absolute; left: 24px; top: 54px; width: 820px;
    border-radius: 16px;
    box-shadow: 0 30px 80px rgba(0,0,0,0.45);
  }
</style></head>
<body>
  <div class="og">
    <div class="copy">
      <img class="icon" src="${iconUri}" alt="">
      <h1>Codex Account Manager</h1>
      <p>多个 Codex、Cursor 和 Antigravity 账号，一个窗口里照看。</p>
      <div class="meta">LOCAL-FIRST  ·  WINDOWS</div>
    </div>
    <div class="preview"><img src="${dashUri}" alt=""></div>
  </div>
</body></html>`);
  await page.waitForTimeout(200);
  await save(page, "social-preview.png", { fullPage: false });
  await page.close();
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
  });
  try {
    const traySocialOnly = process.argv.includes("--tray-social");
    if (traySocialOnly) {
      await captureTrayMenu(browser);
      await captureSocialPreview(browser);
      return;
    }
    await captureLogin(browser);
    await captureAppPages(browser);
    await captureFloatLens(browser);
    await captureTrayMenu(browser);
    await captureSocialPreview(browser);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

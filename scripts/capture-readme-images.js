// Capture README screenshots from the Vite renderer preview.
// Start `npx vite --config vite.renderer.config.ts --host 127.0.0.1 --port 5173`
// first, with playwright-core available to Node (`npm install --no-save playwright-core`).

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "docs", "images");
const iconPath = path.join(root, "resources", "icon.png");
const baseUrl = process.env.README_CAPTURE_URL || "http://127.0.0.1:5173";

const VIEWPORT = { width: 1320, height: 860 };
const SCALE = 2;
const FRAME = { padX: 56, padY: 48, titleH: 38, radius: 12 };

async function openPage(browser, url) {
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
  });
  await page.addInitScript(() => {
    localStorage.setItem("cam_product", "cursor");
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.addStyleTag({
    content: [
      "*, *::before, *::after { animation: none !important; transition: none !important; }",
      "#footer-privacy { visibility: hidden !important; }",
      "#header-btn-notifications span { display: none !important; }",
    ].join("\n"),
  });
  return page;
}

async function saveRaw(page, name, options) {
  const target = path.join(outDir, name);
  await page.screenshot({
    path: target,
    type: "png",
    ...options,
  });
  console.log(`wrote ${name}`);
}

async function saveFramed(browser, page, name) {
  const inner = await page.screenshot({ type: "png" });
  const innerUri = `data:image/png;base64,${inner.toString("base64")}`;
  const iconUri = `data:image/png;base64,${fs.readFileSync(iconPath).toString("base64")}`;
  const boardW = VIEWPORT.width + FRAME.padX * 2;
  const boardH = VIEWPORT.height + FRAME.titleH + FRAME.padY * 2;
  const board = await browser.newPage({
    viewport: { width: boardW, height: boardH },
    deviceScaleFactor: SCALE,
  });
  await board.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; background: #111114; }
  body {
    font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
    background:
      radial-gradient(90% 70% at 18% 0%, rgba(90, 140, 255, 0.08), transparent 55%),
      radial-gradient(80% 60% at 92% 100%, rgba(160, 80, 255, 0.07), transparent 50%),
      #111114;
  }
  .stage { width: ${boardW}px; height: ${boardH}px; display: flex; align-items: center; justify-content: center; }
  .window {
    width: ${VIEWPORT.width}px;
    border-radius: ${FRAME.radius}px;
    overflow: hidden;
    box-shadow: 0 28px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06);
    background: #0b0b0d;
  }
  .titlebar {
    height: ${FRAME.titleH}px;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 10px 0 12px;
    background: #16161a;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    color: rgba(245,245,247,0.78);
  }
  .title { display: flex; align-items: center; gap: 8px; font-size: 12px; letter-spacing: 0.01em; }
  .title img { width: 16px; height: 16px; border-radius: 4px; display: block; }
  .win { display: flex; height: ${FRAME.titleH}px; }
  .win span {
    width: 46px; height: ${FRAME.titleH}px; display: flex; align-items: center; justify-content: center;
    color: rgba(245,245,247,0.62); font-size: 11px;
  }
  .body { display: block; width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; }
</style></head>
<body>
  <div class="stage">
    <div class="window">
      <div class="titlebar">
        <div class="title"><img src="${iconUri}" alt=""><span>Quota Switcher</span></div>
        <div class="win"><span>&#x2014;</span><span>&#x2610;</span><span>&#x2715;</span></div>
      </div>
      <img class="body" src="${innerUri}" alt="">
    </div>
  </div>
</body></html>`);
  await board.waitForTimeout(120);
  await board.screenshot({ path: path.join(outDir, name), type: "png" });
  await board.close();
  console.log(`wrote ${name}`);
}

async function selectProduct(page, id) {
  const button = page.locator(`#sidebar-product-${id}`);
  if (await button.count()) {
    await button.click();
    await page.waitForTimeout(400);
  }
}

async function captureAppPages(browser) {
  const page = await openPage(browser, `${baseUrl}/`);
  await page.waitForSelector("#dashboard-main-container");
  await page.waitForTimeout(400);

  await selectProduct(page, "cursor");
  await page.click("#sidebar-nav-accounts");
  await page.waitForTimeout(250);
  await saveFramed(browser, page, "account-dashboard.png");

  await page.click("#sidebar-nav-quotas");
  await page.waitForTimeout(250);
  await saveFramed(browser, page, "quota-overview.png");

  await selectProduct(page, "codex");
  await page.click("#sidebar-nav-accounts");
  await page.waitForTimeout(250);
  await saveFramed(browser, page, "codex-accounts.png");

  await page.click("#sidebar-nav-settings");
  await page.waitForTimeout(250);
  await saveFramed(browser, page, "settings.png");
  await page.close();
}

async function captureFloatLens(browser) {
  const page = await openPage(browser, `${baseUrl}/#float`);
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

  const currentUri = `data:image/png;base64,${current.toString("base64")}`;
  const previewUri = `data:image/png;base64,${preview.toString("base64")}`;
  const board = await browser.newPage({
    viewport: { width: 1180, height: 420 },
    deviceScaleFactor: SCALE,
  });
  await board.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; }
  body {
    background:
      radial-gradient(80% 80% at 20% 0%, rgba(90, 140, 255, 0.10), transparent 55%),
      radial-gradient(70% 80% at 90% 100%, rgba(160, 80, 255, 0.08), transparent 50%),
      #111114;
    font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
  }
  .wrap {
    width: 1180px; height: 420px;
    display: flex; gap: 36px; align-items: center; justify-content: center;
    padding: 36px 40px; box-sizing: border-box;
  }
  figure { margin: 0; text-align: center; }
  img {
    width: 500px; height: auto; display: block;
    filter: drop-shadow(0 18px 40px rgba(0,0,0,0.45));
  }
  figcaption {
    margin-top: 14px; color: rgba(235,235,245,0.48);
    font-size: 12px; letter-spacing: 0.08em;
  }
</style></head>
<body>
  <div class="wrap">
    <figure>
      <img src="${currentUri}" alt="">
      <figcaption>CURRENT</figcaption>
    </figure>
    <figure>
      <img src="${previewUri}" alt="">
      <figcaption>PREVIEW</figcaption>
    </figure>
  </div>
</body></html>`);
  await board.waitForTimeout(120);
  await saveRaw(board, "float-lens.png", { fullPage: false });
  await board.close();
}

async function captureTrayMenu(browser) {
  const iconUri = `data:image/png;base64,${fs.readFileSync(iconPath).toString("base64")}`;
  const page = await browser.newPage({
    viewport: { width: 560, height: 300 },
    deviceScaleFactor: SCALE,
  });
  await page.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; background: #111114; font-family: "Segoe UI Variable", "Segoe UI", sans-serif; }
  .scene { position: relative; width: 560px; height: 300px; overflow: hidden; }
  .taskbar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 48px;
    background: rgba(32,32,32,0.94);
    border-top: 1px solid rgba(255,255,255,0.08);
    display: flex; align-items: center; justify-content: flex-end;
    padding: 0 18px 0 0; gap: 12px;
  }
  .clock { color: rgba(255,255,255,0.78); font-size: 12px; line-height: 1.2; text-align: right; }
  .tray-icon { width: 22px; height: 22px; border-radius: 5px; }
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
      <div class="clock">9:41<br>2026/8/20</div>
    </div>
  </div>
</body></html>`);
  await page.waitForTimeout(120);
  await saveRaw(page, "tray-menu.png", { fullPage: false });
  await page.close();
}

async function captureSocialPreview(browser) {
  const dashPath = path.join(outDir, "account-dashboard.png");
  const dashUri = `data:image/png;base64,${fs.readFileSync(dashPath).toString("base64")}`;
  const iconUri = `data:image/png;base64,${fs.readFileSync(iconPath).toString("base64")}`;
  const page = await browser.newPage({
    viewport: { width: 1280, height: 640 },
    deviceScaleFactor: 2,
  });
  await page.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; }
  .og {
    width: 1280px; height: 640px; display: flex; overflow: hidden;
    background: #0b0b0d; color: #f5f5f7;
    font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
  }
  .copy { width: 430px; padding: 72px 40px 56px 64px; box-sizing: border-box; }
  .icon { width: 72px; height: 72px; border-radius: 18px; display: block; }
  h1 { margin: 28px 0 0; font-size: 34px; line-height: 1.15; font-weight: 650; letter-spacing: -0.03em; }
  p { margin: 16px 0 0; font-size: 17px; line-height: 1.45; color: rgba(235,235,245,0.72); }
  .meta { margin-top: 28px; font-size: 12px; color: rgba(235,235,245,0.46); letter-spacing: 0.08em; }
  .preview {
    flex: 1; position: relative;
    background: radial-gradient(80% 70% at 70% 20%, rgba(255,255,255,0.05), transparent 60%);
  }
  .preview img {
    position: absolute; left: 8px; top: 72px; width: 860px;
    border-radius: 12px;
    box-shadow: 0 30px 80px rgba(0,0,0,0.45);
  }
</style></head>
<body>
  <div class="og">
    <div class="copy">
      <img class="icon" src="${iconUri}" alt="">
      <h1>Quota Switcher</h1>
      <p>在 Windows 上查看并切换 Codex、Cursor 与 Antigravity 账号。凭证只保存在本机。</p>
      <div class="meta">WINDOWS  ·  LOCAL-FIRST</div>
    </div>
    <div class="preview"><img src="${dashUri}" alt=""></div>
  </div>
</body></html>`);
  await page.waitForTimeout(200);
  await saveRaw(page, "social-preview.png", { fullPage: false });
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

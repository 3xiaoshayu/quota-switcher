const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "docs", "images");
const iconPath = path.join(root, "resources", "icon.png");

(async () => {
  const dashUri = `data:image/png;base64,${fs.readFileSync(path.join(outDir, "account-dashboard.png")).toString("base64")}`;
  const iconUri = `data:image/png;base64,${fs.readFileSync(iconPath).toString("base64")}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; }
  .og { width: 1280px; height: 640px; display: flex; overflow: hidden; background: #0b0b0d; color: #f5f5f7; font-family: "Segoe UI Variable", "Segoe UI", sans-serif; }
  .copy { width: 470px; padding: 72px 48px 56px 64px; box-sizing: border-box; }
  .icon { width: 72px; height: 72px; border-radius: 18px; display: block; }
  h1 { margin: 28px 0 0; font-size: 36px; line-height: 1.15; font-weight: 650; letter-spacing: -0.03em; }
  p { margin: 16px 0 0; font-size: 18px; line-height: 1.45; color: rgba(235,235,245,0.72); }
  .meta { margin-top: 28px; font-size: 13px; color: rgba(235,235,245,0.46); letter-spacing: 0.06em; }
  .preview { flex: 1; position: relative; background: radial-gradient(80% 70% at 70% 20%, rgba(255,255,255,0.06), transparent 60%); }
  .preview img { position: absolute; left: 24px; top: 54px; width: 820px; border-radius: 16px; box-shadow: 0 30px 80px rgba(0,0,0,0.45); }
</style></head>
<body>
  <div class="og">
    <div class="copy">
      <img class="icon" src="${iconUri}" alt="">
      <h1>Quota Switcher</h1>
      <p>多个 Codex、Cursor 和 Antigravity 账号，一个窗口里照看。</p>
      <div class="meta">WINDOWS  ·  LOCAL-FIRST</div>
    </div>
    <div class="preview"><img src="${dashUri}" alt=""></div>
  </div>
</body></html>`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, "social-preview.png"), type: "png" });
  await browser.close();
  console.log("social-preview updated");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

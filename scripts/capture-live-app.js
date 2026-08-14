const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "docs", "images");
const cdpUrl = process.env.README_CDP_URL || "http://127.0.0.1:9222";

function maskEmailsInText(text) {
  return String(text || "").replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    (email) => {
      const parts = email.split("@");
      const user = parts[0] || "user";
      const domain = parts.slice(1).join("@") || "example.com";
      const visible = user.slice(0, 2);
      const host = domain.split(".")[0] || "mail";
      return `${visible}***@${host}.example`;
    },
  );
}

async function maskPage(page) {
  await page.evaluate(() => {
    const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const maskEmail = (text) => String(text || "").replace(emailRe, (email) => {
      const user = email.split("@")[0] || "user";
      const domain = email.split("@").slice(1).join("@") || "example.com";
      return `${user.slice(0, 2)}***@${(domain.split(".")[0] || "mail")}.example`;
    });
    const source = document.body.innerText || "";
    const locals = [...new Set((source.match(emailRe) || []).map((email) => email.split("@")[0]).filter((part) => part.length >= 4))];
    const maskLocal = (text) => {
      let next = maskEmail(text);
      for (const local of locals) {
        if (!local) continue;
        next = next.split(local).join(`${local.slice(0, 2)}***`);
      }
      return next;
    };
    const walk = (node) => {
      if (node.nodeType === 3) {
        node.textContent = maskLocal(node.textContent);
        return;
      }
      if (node.nodeType !== 1) return;
      for (const attr of ["title", "aria-label", "placeholder"]) {
        const value = node.getAttribute && node.getAttribute(attr);
        if (value) node.setAttribute(attr, maskLocal(value));
      }
      for (const child of Array.from(node.childNodes)) walk(child);
    };
    walk(document.body);
    const profile = document.querySelector("#header-user-profile-widget span");
    if (profile && profile.textContent) profile.textContent = "demo-user";
  });
}

async function save(page, name) {
  const target = path.join(outDir, name);
  await page.screenshot({ path: target, type: "png" });
  console.log(`wrote ${name}`);
}

async function mainPage(browser) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((item) => !item.url().includes("#float")) || pages[0];
  if (!page) throw new Error("main window page not found");
  await page.bringToFront();
  return page;
}

async function floatPage(browser) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  return pages.find((item) => item.url().includes("#float")) || null;
}

async function captureDashboard(page) {
  const shots = [
    ["accounts", "account-dashboard.png"],
    ["quotas", "quota-overview.png"],
    ["autoswitch", "auto-switch.png"],
    ["settings", "settings.png"],
  ];
  for (const [tab, file] of shots) {
    await page.click(`#sidebar-nav-${tab}`);
    await page.waitForTimeout(400);
    await maskPage(page);
    await save(page, file);
  }
}

async function captureFloat(browser, page) {
  const openBtn = page.locator("#btn-show-float-lens");
  if (await openBtn.count()) {
    await openBtn.click();
    await page.waitForTimeout(600);
  }
  let lens = await floatPage(browser);
  if (!lens) {
    console.log("skip float-lens: window not found");
    return;
  }
  await lens.bringToFront();
  await maskPage(lens);
  const current = await lens.locator(".float-lens-shell").screenshot({ type: "png" });
  const nextBtn = lens.locator('button[title="下一个账号"]');
  if (await nextBtn.count()) {
    await nextBtn.click();
    await lens.waitForTimeout(250);
    await maskPage(lens);
  }
  const preview = await lens.locator(".float-lens-shell").screenshot({ type: "png" });
  const currentPath = path.join(outDir, "_float-current.png");
  const previewPath = path.join(outDir, "_float-preview.png");
  fs.writeFileSync(currentPath, current);
  fs.writeFileSync(previewPath, preview);
  await stitchFloat(currentPath, previewPath, path.join(outDir, "float-lens.png"));
  console.log("wrote float-lens.png");
}

function stitchFloat(leftPath, rightPath, dest) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$left = [System.Drawing.Image]::FromFile('${leftPath.replace(/\\/g, "\\\\")}')
$right = [System.Drawing.Image]::FromFile('${rightPath.replace(/\\/g, "\\\\")}')
$gap = 36
$pad = 28
$caption = 36
$width = $left.Width + $right.Width + $gap + ($pad * 2)
$height = [Math]::Max($left.Height, $right.Height) + ($pad * 2) + $caption
$bmp = New-Object System.Drawing.Bitmap $width, $height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255, 11, 11, 13))
$g.DrawImage($left, $pad, $pad)
$g.DrawImage($right, $pad + $left.Width + $gap, $pad)
$font = New-Object System.Drawing.Font 'Segoe UI', 11
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 160, 160, 168))
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('当前账号', $font, $brush, (New-Object System.Drawing.RectangleF $pad, ($pad + $left.Height + 8), $left.Width, 24), $format)
$g.DrawString('预览其他账号', $font, $brush, (New-Object System.Drawing.RectangleF ($pad + $left.Width + $gap), ($pad + $right.Height + 8), $right.Width, 24), $format)
$bmp.Save('${dest.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $left.Dispose(); $right.Dispose()
`;
  const { spawnSync } = require("node:child_process");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "float stitch failed");
  }
}

async function captureLogin(page) {
  const logout = page.locator("#header-btn-logout");
  if (!(await logout.count())) {
    console.log("skip login: already on login or no logout button");
    return null;
  }
  const title = await page.locator('#header-user-profile-widget [title^="已登录账号"]').getAttribute("title").catch(() => "");
  const email = String(title || "").replace(/^已登录账号：/, "").trim();
  await logout.click();
  await page.waitForSelector("#login-card", { timeout: 8000 });
  const input = page.locator("#login-email-input");
  if (await input.count()) await input.fill("");
  await page.waitForTimeout(300);
  await maskPage(page);
  await save(page, "login.png");
  return email || null;
}

async function restoreSession(page, email) {
  const input = page.locator("#login-email-input");
  if (!(await input.count()) || !email) return;
  await input.fill(email);
  await page.click("#login-submit-button");
  await page.waitForSelector("#dashboard-main-container", { timeout: 8000 }).catch(() => {});
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const page = await mainPage(browser);
    await page.waitForTimeout(500);
    const onLogin = await page.locator("#login-card").count();
    if (onLogin) {
      await maskPage(page);
      await save(page, "login.png");
      const input = page.locator("#login-email-input");
      if (await input.count()) {
        const value = await input.inputValue();
        if (value) {
          await page.click("#login-submit-button");
          await page.waitForSelector("#dashboard-main-container", { timeout: 8000 });
        }
      }
    }
    await captureDashboard(page);
    await captureFloat(browser, page);
    const restoreHint = await captureLogin(page);
    if (restoreHint) await restoreSession(page, restoreHint);
  } finally {
    // Keep the running desktop app open.
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

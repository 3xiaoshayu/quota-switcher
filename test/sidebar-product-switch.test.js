const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const productsPath = path.join(projectRoot, "src", "renderer-react", "data", "products.ts");
const sidebarPath = path.join(projectRoot, "src", "renderer-react", "components", "Sidebar.tsx");
const iconsDir = path.join(projectRoot, "src", "renderer-react", "assets", "products");

test("sidebar product switch is an official-icon dock", () => {
  const sidebar = fs.readFileSync(sidebarPath, "utf8");
  const products = fs.readFileSync(productsPath, "utf8");

  assert.match(sidebar, /id="sidebar-product-dock"/);
  assert.match(sidebar, /id={`sidebar-product-\$\{item\.id\}`}/);
  assert.match(sidebar, /PRODUCT_ICON_DOCK_LIMIT/);
  assert.match(sidebar, /assets\/products\/codex\.png/);
  assert.match(sidebar, /assets\/products\/cursor\.png/);
  assert.match(sidebar, /assets\/products\/antigravity\.png/);
  assert.doesNotMatch(sidebar, /grid-cols-2/);
  assert.match(sidebar, /leading-\[1\.25\]/);
  assert.doesNotMatch(sidebar, /text-\[10px\] font-semibold leading-none truncate max-w-full/);
  assert.match(products, /PRODUCT_ICON_DOCK_LIMIT = 5/);
});

test("settings pause line maps auth_conflict to Chinese", () => {
  const settings = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "components", "SettingsView.tsx"), "utf8");
  assert.match(settings, /toUserMessage\(daemonState\.pausedReason\)/);
});

test("the auto-switch page and its reason copy are gone", () => {
  assert.equal(fs.existsSync(path.join(projectRoot, "src", "renderer-react", "components", "AutoSwitchView.tsx")), false);
  assert.equal(fs.existsSync(path.join(projectRoot, "engine", "auto-switch.js")), false);
  const sidebar = fs.readFileSync(sidebarPath, "utf8");
  assert.doesNotMatch(sidebar, /autoswitch|自动切号/);
  const messages = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "api", "user-messages.ts"), "utf8");
  assert.doesNotMatch(messages, /recently_switched|oauth_pending|no_quota_data|不会切号|本次未切/);
});

test("missing official banner says quota refresh continues", () => {
  const banner = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "components", "AuthStatusBanner.tsx"), "utf8");
  assert.match(banner, /status === 'missing_official_auth'/);
  assert.match(banner, /status === 'unsupported_official_auth'/);
  assert.match(banner, /额度刷新仍会继续，官方登录同步已暂停/);
  assert.doesNotMatch(banner, /自动切号/);
  assert.doesNotMatch(banner, /missing_official_auth[\s\S]{0,180}可采用官方账号/);
  assert.doesNotMatch(banner, /unsupported_official_auth[\s\S]{0,180}可采用官方账号/);
});

test("official product icons are checked into renderer assets", () => {
  for (const name of ["codex.png", "cursor.png", "antigravity.png"]) {
    const file = path.join(iconsDir, name);
    assert.equal(fs.existsSync(file), true, name);
    assert.ok(fs.statSync(file).size > 2000, name);
  }
});

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

test("auto-switch toasts name missing official login separately from a conflict", () => {
  const view = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "components", "AutoSwitchView.tsx"), "utf8");
  assert.match(view, /case 'oauth_pending'/);
  assert.match(view, /已有授权正在进行，本次不自动切号/);
  assert.match(view, /case 'missing_official_auth'/);
  assert.match(view, /检查已暂停：官方 Codex 已退出/);
  assert.match(view, /检查已暂停：官方登录了另一个账号/);
  assert.match(view, /检查已暂停：官方 Codex 已登录，尚未纳入管理/);
  assert.match(view, /case 'unmanaged_official_auth'/);
  assert.match(view, /case 'current_not_found'/);
  assert.match(view, /已跳过：没有当前账号/);
  assert.match(view, /case 'current_changed'/);
  assert.match(view, /当前账号已变化，本次未切/);
});

test("missing official banner says quota refresh continues", () => {
  const banner = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "components", "AuthStatusBanner.tsx"), "utf8");
  assert.match(banner, /status === 'missing_official_auth'/);
  assert.match(banner, /status === 'unsupported_official_auth'/);
  assert.match(banner, /额度刷新仍会继续，自动切号已暂停/);
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

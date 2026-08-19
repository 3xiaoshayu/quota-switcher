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
  assert.match(products, /PRODUCT_ICON_DOCK_LIMIT = 5/);
});

test("official product icons are checked into renderer assets", () => {
  for (const name of ["codex.png", "cursor.png", "antigravity.png"]) {
    const file = path.join(iconsDir, name);
    assert.equal(fs.existsSync(file), true, name);
    assert.ok(fs.statSync(file).size > 2000, name);
  }
});

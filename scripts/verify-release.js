const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const requiredFiles = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "resources/icon.ico",
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`Release assets missing: ${missing.join(", ")}`);
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  console.error(`Invalid release version: ${pkg.version}`);
  process.exit(1);
}

console.log(`Release metadata OK: ${pkg.name} ${pkg.version}`);

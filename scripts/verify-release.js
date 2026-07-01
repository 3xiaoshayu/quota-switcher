const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const requiredFiles = [
  "LICENSE",
  "README.md",
  "README.en.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "ASSET_LICENSE.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/images/account-dashboard.jpg",
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

if (process.env.GITHUB_REF_TYPE === "tag") {
  const expectedTag = `v${pkg.version}`;
  if (process.env.GITHUB_REF_NAME !== expectedTag) {
    console.error(`Release tag ${process.env.GITHUB_REF_NAME} does not match ${expectedTag}`);
    process.exit(1);
  }
}

console.log(`Release metadata OK: ${pkg.name} ${pkg.version}`);

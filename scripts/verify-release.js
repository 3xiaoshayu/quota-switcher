const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const windowShots = [
  "docs/images/account-dashboard.png",
  "docs/images/antigravity-quota.png",
  "docs/images/quota-overview.png",
  "docs/images/settings.png",
];
const lensShots = [
  "docs/images/float-lens.png",
  "docs/images/float-lens-cursor-reauth.png",
  "docs/images/float-lens-codex.png",
  "docs/images/float-lens-antigravity.png",
];
const requiredFiles = [
  "LICENSE",
  "README.md",
  "README.en.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "ASSET_LICENSE.md",
  "THIRD_PARTY_NOTICES.md",
  ...windowShots,
  ...lensShots,
  "docs/images/social-preview.png",
  "resources/icon.ico",
  "resources/installerSidebar.bmp",
  "resources/installerHeader.bmp",
  "resources/installer.nsh",
];

function pngSize(filePath) {
  const buf = Buffer.alloc(24);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  if (buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${filePath} is not a PNG`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`Release assets missing: ${missing.join(", ")}`);
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  console.error(`Invalid release version: ${pkg.version}`);
  process.exit(1);
}

const builderYml = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
if (!/from:\s*resources\/icon\.ico/.test(builderYml) || !/to:\s*icon\.ico/.test(builderYml)) {
  console.error("electron-builder.yml must copy resources/icon.ico into extraResources as icon.ico");
  process.exit(1);
}

if (process.env.GITHUB_REF_TYPE === "tag") {
  const expectedTag = `v${pkg.version}`;
  if (process.env.GITHUB_REF_NAME !== expectedTag) {
    console.error(`Release tag ${process.env.GITHUB_REF_NAME} does not match ${expectedTag}`);
    process.exit(1);
  }
}

for (const banned of ["docs/images/tray-menu.png", "docs/images/auto-switch.png"]) {
  if (fs.existsSync(path.join(root, banned))) {
    console.error(`${banned} must not be published`);
    process.exit(1);
  }
}

for (const file of windowShots) {
  const size = pngSize(path.join(root, file));
  if (size.width < 2100 || size.height < 1300) {
    console.error(`${file} is ${size.width}x${size.height}; window shots must stay at original capture size`);
    process.exit(1);
  }
}

for (const file of lensShots) {
  const size = pngSize(path.join(root, file));
  if (size.width < 400 || size.height < 450) {
    console.error(`${file} is ${size.width}x${size.height}; lens shots must stay at original capture size`);
    process.exit(1);
  }
}

const social = pngSize(path.join(root, "docs/images/social-preview.png"));
if (social.width !== 1280 || social.height !== 640) {
  console.error(`docs/images/social-preview.png is ${social.width}x${social.height}; expected 1280x640`);
  process.exit(1);
}

const galleryNames = [
  "account-dashboard.png",
  "quota-overview.png",
  "antigravity-quota.png",
  "settings.png",
  "float-lens.png",
  "float-lens-cursor-reauth.png",
  "float-lens-codex.png",
  "float-lens-antigravity.png",
];
for (const readme of ["README.md", "README.en.md"]) {
  const text = fs.readFileSync(path.join(root, readme), "utf8");
  if (text.includes("tray-menu")) {
    console.error(`${readme} still mentions tray-menu`);
    process.exit(1);
  }
  const missingShots = galleryNames.filter((name) => !text.includes(name));
  if (missingShots.length) {
    console.error(`${readme} is missing ${missingShots.join(", ")}`);
    process.exit(1);
  }
}

if (fs.existsSync(path.join(root, ".git"))) {
  const history = execFileSync("git", ["log", "--format=%B"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (/Co-authored-by:\s*Cursor/i.test(history) || /Made-with:\s*Cursor/i.test(history)) {
    console.error("git history still contains Cursor attribution trailers");
    process.exit(1);
  }
}

console.log(`Release metadata OK: ${pkg.name} ${pkg.version}`);

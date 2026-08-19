const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const pkg = require(path.join(root, "package.json"));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertFile(file) {
  const fullPath = path.join(dist, file);
  if (!fs.existsSync(fullPath)) fail(`Missing release artifact: ${file}`);
  return fullPath;
}

if (!fs.existsSync(dist)) fail("Missing dist directory. Run the release build first.");

const expected = [
  `Quota-Switcher-${pkg.version}-x64.zip`,
  `Quota-Switcher-Setup-${pkg.version}-x64.exe`,
  `Quota-Switcher-Setup-${pkg.version}-x64.exe.blockmap`,
  "latest.yml",
];

for (const file of expected) assertFile(file);

const releaseFiles = fs
  .readdirSync(dist, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => (
    name.includes(pkg.version) || name === "latest.yml"
  ) && /\.(exe|zip|blockmap|yml)$/i.test(name));

const filesWithWhitespace = releaseFiles.filter((name) => /\s/.test(name));
if (filesWithWhitespace.length) {
  fail(`Release artifact names must not contain whitespace: ${filesWithWhitespace.join(", ")}`);
}

const latest = fs.readFileSync(assertFile("latest.yml"), "utf8");
const pathMatch = latest.match(/^path:\s*["']?([^"'\r\n]+)["']?\s*$/m);
const urlMatch = latest.match(/^\s*-\s+url:\s*["']?([^"'\r\n]+)["']?\s*$/m);

if (!pathMatch) fail("latest.yml does not contain a path entry.");
const latestPath = pathMatch[1].trim();
if (/\s/.test(latestPath)) fail(`latest.yml path must not contain whitespace: ${latestPath}`);
assertFile(latestPath);

if (!urlMatch) fail("latest.yml does not contain a files[0].url entry.");
const latestUrl = urlMatch[1].trim();
if (latestUrl !== latestPath) {
  fail(`latest.yml url (${latestUrl}) does not match path (${latestPath}).`);
}

const blockmap = `${latestPath}.blockmap`;
assertFile(blockmap);

const unpackedDir = path.join(dist, "win-unpacked");
if (fs.existsSync(unpackedDir)) {
  const packagedIcon = path.join(unpackedDir, "resources", "icon.ico");
  if (!fs.existsSync(packagedIcon)) {
    fail("Packaged extraResources icon.ico is missing from win-unpacked/resources/");
  }
}

console.log(`Release artifacts OK: ${expected.join(", ")}`);

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const pkg = require(path.join(root, "package.json"));

if (!fs.existsSync(dist)) {
  console.log("No dist directory to clean.");
  process.exit(0);
}

const removable = fs
  .readdirSync(dist, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => (
    name.includes(pkg.version) && /\.(exe|zip|blockmap)$/i.test(name)
  ) || name === "latest.yml" || name === "SHA256SUMS.txt");

for (const name of removable) {
  fs.rmSync(path.join(dist, name), { force: true });
}

console.log(`Cleaned ${removable.length} release artifacts for ${pkg.version}.`);

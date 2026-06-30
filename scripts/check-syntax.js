const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const targets = ["engine", "scripts", "src/main", "src/preload", "src/renderer"];
const files = [];

function collect(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stat = fs.statSync(absolutePath);

  if (stat.isFile()) {
    if (absolutePath.endsWith(".js")) files.push(absolutePath);
    return;
  }

  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.name === "vendor") continue;
    collect(path.join(relativePath, entry.name));
  }
}

targets.forEach(collect);
files.sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}

console.log(`JavaScript syntax OK: ${files.length} files`);

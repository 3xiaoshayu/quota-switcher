const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([".git", ".reference", "dist", "node_modules"]);
const markdownFiles = [];
const missing = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(absolutePath);
    else if (entry.name.endsWith(".md")) markdownFiles.push(absolutePath);
  }
}

collect(root);

for (const file of markdownFiles) {
  const text = fs.readFileSync(file, "utf8");
  const links = text.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g);

  for (const match of links) {
    const target = match[1].trim().replace(/^<|>$/g, "");
    if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue;

    const filePart = target.split("#", 1)[0].split("?", 1)[0];
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(filePart));
    if (!fs.existsSync(resolved)) {
      missing.push(`${path.relative(root, file)} -> ${target}`);
    }
  }
}

if (missing.length) {
  console.error(`Broken local documentation links:\n${missing.join("\n")}`);
  process.exit(1);
}

console.log(`Documentation links OK: ${markdownFiles.length} files`);

const fs = require("node:fs");
const path = require("node:path");

const rendererRoot = path.resolve(__dirname, "..", "..", "src", "renderer-react");

// App.tsx plus every module under src/renderer-react/app, joined with file
// banners. Structural guards that describe the renderer's logic as a whole
// (for example "only applyAuthState may call setAuthState") read this instead
// of App.tsx alone, so moving code between those files does not break them.
function readRendererLogicSource() {
  const appDir = path.join(rendererRoot, "app");
  const files = [
    path.join(rendererRoot, "App.tsx"),
    ...fs.readdirSync(appDir)
      .filter((name) => /\.tsx?$/.test(name))
      .sort()
      .map((name) => path.join(appDir, name)),
  ];
  return files
    .map((file) => `// ---- ${path.relative(rendererRoot, file).replace(/\\/g, "/")} ----\n${fs.readFileSync(file, "utf8")}`)
    .join("\n");
}

function readRendererFile(...segments) {
  return fs.readFileSync(path.join(rendererRoot, ...segments), "utf8");
}

module.exports = { readRendererLogicSource, readRendererFile, rendererRoot };

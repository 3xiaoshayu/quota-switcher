const esbuild = require("esbuild");

// TypeScript 7 ships as a native binary without the transpileModule API, so
// renderer sources are lowered to CommonJS for the vm-based tests with esbuild.
// Type checking stays with tsc (npm run renderer:check); this only strips types
// and rewrites imports, which is all the tests need.
function transpileTs(source, { filename = "module.ts" } = {}) {
  return esbuild.transformSync(source, {
    loader: filename.endsWith(".tsx") ? "tsx" : "ts",
    format: "cjs",
    target: "es2020",
    sourcefile: filename,
  }).code;
}

module.exports = { transpileTs };

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const rendererRoot = path.join(projectRoot, "src", "renderer-react");

test("both renderer entry points render inside the error boundary", () => {
  const main = fs.readFileSync(path.join(rendererRoot, "main.tsx"), "utf8");
  const boundaryMounts = main.match(/<AppErrorBoundary>/g) || [];
  assert.equal(boundaryMounts.length, 2, "App and FloatLens must both be wrapped");
  assert.match(main, /boot\(\)\.catch\(/);
  assert.match(main, /RendererCrashScreen message=/);
});

test("the crash screen explains that accounts are safe and offers a reload", () => {
  const boundary = fs.readFileSync(path.join(rendererRoot, "components", "AppErrorBoundary.tsx"), "utf8");
  assert.match(boundary, /static getDerivedStateFromError/);
  assert.match(boundary, /componentDidCatch/);
  assert.match(boundary, /账号和后台任务都没有受影响/);
  assert.match(boundary, /window\.location\.reload\(\)/);
  assert.match(boundary, /id="renderer-crash-message"/);
});

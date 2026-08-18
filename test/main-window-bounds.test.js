const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_MAIN_WIDTH,
  DEFAULT_MAIN_HEIGHT,
  MIN_MAIN_WIDTH,
  MIN_MAIN_HEIGHT,
  resolveMainWindowSize,
} = require("../src/main/main-window-bounds");

test("main window defaults to the agreed launch size", () => {
  assert.equal(DEFAULT_MAIN_WIDTH, 1440);
  assert.equal(DEFAULT_MAIN_HEIGHT, 900);
  assert.equal(MIN_MAIN_WIDTH, 1280);
  assert.equal(MIN_MAIN_HEIGHT, 720);
  assert.deepEqual(resolveMainWindowSize({ width: 1920, height: 1080 }), {
    width: 1440,
    height: 900,
  });
});

test("main window size is clamped to a smaller work area", () => {
  assert.deepEqual(resolveMainWindowSize({ width: 1400, height: 800 }), {
    width: 1400,
    height: 800,
  });
});

test("main window size ignores invalid work areas", () => {
  assert.deepEqual(resolveMainWindowSize(null), {
    width: 1440,
    height: 900,
  });
  assert.deepEqual(resolveMainWindowSize({ width: 0, height: -10 }), {
    width: 1440,
    height: 900,
  });
});

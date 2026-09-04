const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseStartAppsOutput,
  cacheWindowFor,
  CACHE_MS,
  FAILURE_CACHE_MS,
} = require("../engine/codex-installation");
const { CODEX_AUMID } = require("../engine/config");

test("a found or missing Store Codex is remembered for a minute", () => {
  const found = parseStartAppsOutput(JSON.stringify({ Name: "Codex", AppID: CODEX_AUMID }));
  assert.equal(found.installed, true);
  assert.equal(found.name, "Codex");
  assert.equal(cacheWindowFor(found), CACHE_MS);

  const missing = parseStartAppsOutput("{}");
  assert.equal(missing.installed, false);
  assert.equal(missing.reason, "not-found");
  assert.equal(cacheWindowFor(missing), CACHE_MS);
});

test("a failed detection is only remembered briefly so the next switch re-checks", () => {
  const failed = { installed: false, reason: "detection-failed", error: "powershell timed out" };
  assert.equal(cacheWindowFor(failed), FAILURE_CACHE_MS);
  assert.ok(FAILURE_CACHE_MS < CACHE_MS);
  assert.ok(FAILURE_CACHE_MS <= 10_000, "a detection hiccup must not block auto-switch for a whole tick");
});

test("Start Apps output for another app id does not count as installed", () => {
  const other = parseStartAppsOutput(JSON.stringify({ Name: "Codex", AppID: "Some.Other_app!App" }));
  assert.equal(other.installed, false);
  assert.equal(other.reason, "not-found");
});

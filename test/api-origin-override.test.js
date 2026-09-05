const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// engine/config.js reads CODEX_MANAGER_API_ORIGIN once at load, so each case
// gets its own process instead of juggling the require cache.
const UPSTREAM_KEYS = [
  "TOKEN_URL",
  "USAGE_URL",
  "CURSOR_POLL_URL",
  "CURSOR_TOKEN_URL",
  "CURSOR_USAGE_URL",
  "CURSOR_META_URL",
  "ANTIGRAVITY_TOKEN_URL",
  "ANTIGRAVITY_USERINFO_URL",
  "ANTIGRAVITY_CLOUDCODE_URL",
  "ANTIGRAVITY_CLOUDCODE_DAILY_URL",
];
const BROWSER_KEYS = ["AUTH_URL", "CURSOR_LOGIN_URL", "ANTIGRAVITY_AUTH_URL"];

function loadConfig(env) {
  const script = `
    const config = require(${JSON.stringify(path.join(__dirname, "..", "engine", "config.js"))});
    const keys = ${JSON.stringify([...UPSTREAM_KEYS, ...BROWSER_KEYS])};
    process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, config[key]]))));
  `;
  const cleanEnv = { ...process.env };
  delete cleanEnv.CODEX_MANAGER_API_ORIGIN;
  return JSON.parse(execFileSync(process.execPath, ["-e", script], {
    env: { ...cleanEnv, ...env },
    encoding: "utf8",
  }));
}

test("without the override every upstream URL is the literal https endpoint", () => {
  const config = loadConfig({});
  for (const key of [...UPSTREAM_KEYS, ...BROWSER_KEYS]) {
    assert.match(config[key], /^https:\/\/[a-z0-9.-]+(\/|$)/, key);
    assert.doesNotMatch(config[key], /127\.0\.0\.1|localhost/, key);
  }
});

test("the override swaps only the origin and keeps every API path", () => {
  const literal = loadConfig({});
  const overridden = loadConfig({ CODEX_MANAGER_API_ORIGIN: "http://127.0.0.1:4567/" });
  for (const key of UPSTREAM_KEYS) {
    const expectedPath = new URL(literal[key]).pathname.replace(/\/$/, "");
    assert.equal(overridden[key], `http://127.0.0.1:4567${expectedPath}`, key);
  }
});

test("URLs opened in the browser are never redirected to the stub", () => {
  const literal = loadConfig({});
  const overridden = loadConfig({ CODEX_MANAGER_API_ORIGIN: "http://127.0.0.1:4567" });
  for (const key of BROWSER_KEYS) {
    assert.equal(overridden[key], literal[key], key);
  }
});

test("upstreamUrl leaves URLs alone when the override is blank", () => {
  const original = process.env.CODEX_MANAGER_API_ORIGIN;
  process.env.CODEX_MANAGER_API_ORIGIN = "   ";
  delete require.cache[require.resolve("../engine/config")];
  try {
    const { upstreamUrl, USAGE_URL } = require("../engine/config");
    assert.equal(upstreamUrl("https://example.com/a/b"), "https://example.com/a/b");
    assert.equal(USAGE_URL, "https://chatgpt.com/backend-api/wham/usage");
  } finally {
    if (original === undefined) delete process.env.CODEX_MANAGER_API_ORIGIN;
    else process.env.CODEX_MANAGER_API_ORIGIN = original;
    delete require.cache[require.resolve("../engine/config")];
  }
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_JSON_BODY_BYTES,
  concatUtf8Capped,
} = require("../engine/http-client");

test("capped UTF-8 concat keeps a normal JSON body", () => {
  const body = concatUtf8Capped([Buffer.from('{"ok":true}')]);
  assert.equal(body, '{"ok":true}');
});

test("capped UTF-8 concat rejects a body that would freeze the UI", () => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const chunks = [];
  let total = 0;
  while (total <= MAX_JSON_BODY_BYTES) {
    chunks.push(chunk);
    total += chunk.length;
  }
  assert.throws(() => concatUtf8Capped(chunks), (error) => {
    assert.equal(error.code, "response_too_large");
    assert.match(error.message, /响应过大/);
    return true;
  });
});

test("quota HTTP never uses Chromium fetch on the UI session", () => {
  const source = fs.readFileSync(path.join(__dirname, "../engine/http-client.js"), "utf8");
  assert.match(source, /Never use Chromium net\.fetch here/);
  assert.match(source, /touchSession: false/);
  assert.match(source, /MAX_JSON_BODY_BYTES = 1024 \* 1024/);
  assert.doesNotMatch(source, /if \(!signature\.proxyUrl\) \{/);
});

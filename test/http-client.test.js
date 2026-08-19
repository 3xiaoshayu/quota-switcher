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
  assert.match(source, /keepAlive: true/);
  assert.doesNotMatch(source, /if \(!signature\.proxyUrl\) \{/);
  assert.doesNotMatch(source, /electronHttpJson/);
});

test("HTTP agents are reused for the same proxy signature", () => {
  const { getAgentForSignature, resetHttpAgentsForTests } = require("../engine/http-client");
  resetHttpAgentsForTests();
  const directA = getAgentForSignature({ proxyUrl: "" }, "https:");
  const directB = getAgentForSignature({ proxyUrl: "" }, "https:");
  const proxyA = getAgentForSignature({ proxyUrl: "http://127.0.0.1:7890" }, "https:");
  const proxyB = getAgentForSignature({ proxyUrl: "http://127.0.0.1:7890" }, "https:");
  const proxyOther = getAgentForSignature({ proxyUrl: "http://127.0.0.1:10808" }, "https:");
  const httpDirect = getAgentForSignature({ proxyUrl: "" }, "http:");
  assert.equal(directA, directB);
  assert.equal(proxyA, proxyB);
  assert.notEqual(directA, proxyA);
  assert.notEqual(proxyA, proxyOther);
  assert.notEqual(directA, httpDirect);
  assert.equal(directA.keepAlive, true);
  resetHttpAgentsForTests();
});

test("HTTP transport falls back in-process when the engine worker is down", async () => {
  const { httpJson, setHttpJsonTransport } = require("../engine/http-client");
  let calls = 0;
  setHttpJsonTransport(async () => {
    calls += 1;
    const error = new Error("worker down");
    error.code = "engine_worker_down";
    throw error;
  });
  try {
    await assert.rejects(() => httpJson("http://127.0.0.1:1/", { timeout: 200 }), /网络请求失败|ECONNREFUSED|请求超时/);
    assert.equal(calls, 1);
  } finally {
    setHttpJsonTransport(null);
  }
});

test("HTTP transport is used when the engine worker is alive", async () => {
  const { httpJson, setHttpJsonTransport } = require("../engine/http-client");
  setHttpJsonTransport(async (url) => ({ status: 200, headers: {}, body: JSON.stringify({ url }) }));
  try {
    const result = await httpJson("https://example.invalid/quota");
    assert.equal(result.status, 200);
    assert.match(result.body, /example\.invalid/);
  } finally {
    setHttpJsonTransport(null);
  }
});

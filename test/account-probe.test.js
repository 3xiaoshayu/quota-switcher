const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyProbe,
  applyProbeToAccount,
} = require("../engine/account-probe");

test("usage 2xx with a free plan payload is active", () => {
  const probe = classifyProbe({
    source: "usage",
    httpStatus: 200,
    body: JSON.stringify({ chatgpt_plan_type: "chatgptfreeplan", rate_limit: {} }),
    headers: {},
  });
  assert.equal(probe.status, "active");
  assert.equal(probe.ok, true);
});

test("refresh invalid_grant is token_invalid and never banned", () => {
  const probe = classifyProbe({
    source: "refresh",
    httpStatus: 400,
    body: JSON.stringify({ error: "invalid_grant" }),
    headers: {},
  });
  assert.equal(probe.status, "token_invalid");
  assert.notEqual(probe.status, "banned");
});

test("refresh account_disabled is still token_invalid", () => {
  const probe = classifyProbe({
    source: "refresh",
    httpStatus: 400,
    body: JSON.stringify({ error: { code: "account_disabled" } }),
    headers: {},
  });
  assert.equal(probe.status, "token_invalid");
});

test("usage account_deactivated is banned even on HTTP 401", () => {
  const probe = classifyProbe({
    source: "usage",
    httpStatus: 401,
    body: JSON.stringify({
      error: {
        message: "Your OpenAI account has been deactivated, please check your email",
        code: "account_deactivated",
      },
    }),
    headers: {},
  });
  assert.equal(probe.status, "banned");
  assert.equal(probe.error_code, "account_deactivated");
});

test("leftover access rejected codes stay locked to four token-dead codes", () => {
  const { ACCESS_REJECTED_CODES } = require("../engine/account-probe");
  assert.deepEqual([...ACCESS_REJECTED_CODES].sort(), [
    "invalid_grant",
    "invalid_token",
    "token_invalidated",
    "token_revoked",
  ]);
});

test("usage token_invalidated is leftover-access rejected, not banned", () => {
  const { classifyProbe, isLeftoverAccessRejected } = require("../engine/account-probe");
  const probe = classifyProbe({
    source: "usage",
    httpStatus: 401,
    body: JSON.stringify({ error: { code: "token_invalidated" } }),
    headers: {},
  });
  assert.equal(probe.status, "probe_failed");
  assert.equal(probe.error_code, "token_invalidated");
  assert.equal(isLeftoverAccessRejected(probe), true);
  assert.equal(isLeftoverAccessRejected({
    status: "banned",
    error_code: "account_deactivated",
    http_status: 401,
  }), false);
});

test("empty 401 and HTML 403 are probe_failed", () => {
  const { classifyProbe, isLeftoverAccessRejected } = require("../engine/account-probe");
  const empty = classifyProbe({
    source: "usage",
    httpStatus: 401,
    body: "",
    headers: {},
  });
  assert.equal(empty.status, "probe_failed");
  assert.equal(isLeftoverAccessRejected(empty), false);
  assert.equal(classifyProbe({
    source: "usage",
    httpStatus: 403,
    body: "<html>challenge</html>",
    headers: {},
  }).status, "probe_failed");
});

test("usage 429 is usage_limited", () => {
  const probe = classifyProbe({
    source: "usage",
    httpStatus: 429,
    body: JSON.stringify({ error: { code: "usage_limit_reached" } }),
    headers: {},
  });
  assert.equal(probe.status, "usage_limited");
});

test("timeout with no status is probe_failed", () => {
  const probe = classifyProbe({
    source: "usage",
    httpStatus: 0,
    body: "请求超时",
    headers: {},
  });
  assert.equal(probe.status, "probe_failed");
});

test("error code can come from the IDE error header", () => {
  const probe = classifyProbe({
    source: "usage",
    httpStatus: 401,
    body: "",
    headers: { "x-openai-ide-error-code": "account_deactivated" },
  });
  assert.equal(probe.status, "banned");
  assert.equal(probe.error_code, "account_deactivated");
});

test("a later probe_failed does not clear banned", () => {
  const account = {
    banned: true,
    probe: { status: "banned", error_code: "account_deactivated", http_status: 401, checked_at: 1 },
  };
  applyProbeToAccount(account, {
    status: "probe_failed",
    error_code: null,
    http_status: 0,
    message: "这次没有查清楚，不能当成封号",
    ok: false,
  });
  assert.equal(account.banned, true);
  assert.equal(account.probe.status, "banned");
  assert.equal(account.probe.error_code, "account_deactivated");
});

test("a bare deactivated word is not banned", () => {
  const probe = classifyProbe({
    source: "usage",
    httpStatus: 403,
    body: JSON.stringify({ error: { message: "this feature is deactivated for now" } }),
    headers: {},
  });
  assert.equal(probe.status, "probe_failed");
});

test("workspace deactivation is banned and keeps its own code", () => {
  const probe = classifyProbe({
    source: "usage",
    httpStatus: 403,
    body: JSON.stringify({ error: { code: "workspace_deactivated" } }),
    headers: {},
  });
  assert.equal(probe.status, "banned");
  assert.equal(probe.error_code, "workspace_deactivated");
});

test("error code can come from the base64 x-error-json header", () => {
  const payload = Buffer.from(JSON.stringify({
    error: { code: "account_deactivated" },
  })).toString("base64");
  const probe = classifyProbe({
    source: "usage",
    httpStatus: 401,
    body: "",
    headers: { "x-error-json": payload },
  });
  assert.equal(probe.status, "banned");
  assert.equal(probe.error_code, "account_deactivated");
});

test("usage 2xx clears banned", () => {
  const account = { banned: true, probe: { status: "banned", error_code: "account_deactivated" } };
  applyProbeToAccount(account, {
    status: "active",
    error_code: null,
    http_status: 200,
    message: "账号可用",
    ok: true,
  });
  assert.equal(account.banned, false);
  assert.equal(account.probe.status, "active");
});

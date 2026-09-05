const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readRendererLogicSource } = require("./helpers/renderer-source");
const { transpileTs } = require("./helpers/transpile-ts");

const projectRoot = path.resolve(__dirname, "..");
const rendererApi = path.join(projectRoot, "src", "renderer-react", "api");

function compileTs(sourcePath) {
  return transpileTs(fs.readFileSync(sourcePath, "utf8"), { filename: sourcePath });
}

function loadUserMessages() {
  const sourcePath = path.join(rendererApi, "user-messages.ts");
  const module = { exports: {} };
  vm.runInNewContext(compileTs(sourcePath), { module, exports: module.exports }, { filename: sourcePath });
  return module.exports;
}

function loadDesktop(bridge) {
  const sourcePath = path.join(rendererApi, "desktop.ts");
  const module = { exports: {} };
  const userMessages = loadUserMessages();
  vm.runInNewContext(compileTs(sourcePath), {
    module,
    exports: module.exports,
    require(id) {
      if (id === "./user-messages") return userMessages;
      throw new Error(`Unexpected require: ${id}`);
    },
    window: { codexAccountManager: bridge },
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Promise,
    Error,
    Map,
    Set,
    JSON,
    RegExp,
  }, { filename: sourcePath });
  return module.exports;
}

// Every `error.code = "..."` / `code: "..."` literal the engine or main process
// produces. Matching the renderer table against this list keeps a new engine
// code from surfacing as the generic fallback.
function collectEngineCodes() {
  const codes = new Set();
  const pattern = /(?:\.code\s*=\s*|code:\s*|codedError\()["']([a-z][a-z0-9_]*)["']/g;
  const stack = [path.join(projectRoot, "engine"), path.join(projectRoot, "src", "main")];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".js")) {
        for (const match of fs.readFileSync(full, "utf8").matchAll(pattern)) codes.add(match[1]);
      }
    }
  }
  return [...codes].sort();
}

test("every engine error code has renderer copy", () => {
  const { CODE_MESSAGES } = loadUserMessages();
  const codes = collectEngineCodes();
  const missing = codes.filter((code) => !CODE_MESSAGES[code]);
  assert.deepEqual(missing, [], `add copy for: ${missing.join(", ")}`);
  assert.ok(codes.length >= 50, `expected the engine to carry many codes, found ${codes.length}`);
  for (const [code, copy] of Object.entries(CODE_MESSAGES)) {
    assert.match(copy, /[\u4e00-\u9fff]/, `${code} copy must be Chinese`);
  }
});

test("no engine failure is raised without a code", () => {
  // Every deliberate failure goes through codedError() or sets error.code on
  // the line after `new Error(...)`; a bare `throw new Error(...)` would fall
  // back to message matching in the window.
  const offenders = [];
  const stack = [path.join(projectRoot, "engine")];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".js")) {
        const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
        lines.forEach((line, index) => {
          if (/throw new Error\(/.test(line)) offenders.push(`${path.relative(projectRoot, full)}:${index + 1}`);
        });
      }
    }
  }
  assert.deepEqual(offenders, [], `use codedError(code, message) at: ${offenders.join(", ")}`);
});

test("coded engine failures translate by code even when the message is diagnostic", () => {
  const { codedError } = require("../engine/errors");
  const { toUserMessage } = loadUserMessages();
  const busy = codedError("oauth_in_progress", "authorization is already in progress");
  assert.equal(busy.code, "oauth_in_progress");
  assert.equal(toUserMessage(busy), "已有授权正在进行");
  assert.equal(toUserMessage(codedError("vault_not_initialized", "Account encryption is not initialized")), "账号加密尚未就绪，请重启软件");
  assert.equal(toUserMessage(codedError("network_unavailable", "网络请求失败 (chatgpt.com)。本机 DNS 异常且没有可用的本地代理。")), "额度暂时没刷到，登录还在。请稍后再试。");
  // Codes that cover several situations keep the more specific message copy.
  assert.equal(
    toUserMessage(codedError("codex_start_failed", "Official Codex opened a crash recovery window instead of a working session")),
    "官方 Codex 打开了崩溃恢复窗口，未能正常启动",
  );
  assert.equal(toUserMessage(codedError("codex_start_failed", "something new the engine says")), "官方 Codex 未能正常启动");
  assert.equal(
    toUserMessage(codedError("account_product_mismatch", "Cursor accounts cannot be written to official Codex")),
    "Cursor 账号不能写进官方 Codex",
  );
  assert.equal(toUserMessage(codedError("account_product_mismatch", "unexpected wording")), "该账号不属于当前产品，无法切换");
});

test("main-process fail() carries the code next to the message", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc-handlers.js"), "utf8");
  assert.match(source, /function fail\(message, code = null\)/);
  assert.match(source, /function failFrom\(error\)/);
  assert.match(source, /return failFrom\(error\);\s*\}\s*\}\);\s*\};/, "the shared handle() wrapper must keep error.code");
  assert.doesNotMatch(source, /fail\(error\.message\)/, "use failFrom(error) so the code is not dropped");
  assert.doesNotMatch(source, /fail\("Account does not exist"\)/, "account_not_found must be coded");
});

test("a coded engine error reaches the renderer as {success:false, code}", async () => {
  const handlers = new Map();
  const electron = {
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
    BrowserWindow: { getAllWindows: () => [] },
    app: { getVersion: () => "0.0.0-test", isPackaged: false },
    shell: { async openExternal() {}, async openPath() { return ""; } },
  };
  const busy = new Error("官方 Cursor 还在占用登录库");
  busy.code = "cursor_vscdb_busy";
  const listed = { id: "cursor_x", email: "x@example.com" };
  let plainFailure = false;
  const engine = {
    listCursorAccts: () => [listed],
    loadCursorIdx: () => ({ current_cursor_account_id: null }),
    withAccountLocks: async (_ids, task) => task(),
    loadCursorAcct: (id) => (id === listed.id ? { ...listed, tokens: {} } : null),
    async doCursorSwitch() {
      if (plainFailure) throw new Error("plain failure");
      throw busy;
    },
  };
  delete require.cache[require.resolve("../src/main/ipc-handlers")];
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron, setInterval: () => 0, clearInterval: () => {} });

  const cursorSwitch = handlers.get("cursor:switch");
  assert.ok(cursorSwitch, "cursor:switch handler registered");
  const response = await cursorSwitch({ sender: { id: 1 } }, "cursor_x");
  assert.equal(response.success, false);
  assert.equal(response.code, "cursor_vscdb_busy");
  assert.match(response.error, /占用登录库/);

  plainFailure = true;
  const plainResponse = await cursorSwitch({ sender: { id: 1 } }, "cursor_x");
  assert.equal(plainResponse.success, false);
  assert.equal(plainResponse.code, undefined, "no code when the error has none");

  const missing = await cursorSwitch({ sender: { id: 1 } }, "cursor_nope");
  assert.equal(missing.success, false);
  assert.equal(missing.code, "account_not_found");
});

test("renderer keeps the code on DesktopError and translates by code first", () => {
  const desktop = loadDesktop({});
  const { toUserMessage, toCursorUserMessage } = loadUserMessages();

  const error = (() => {
    try {
      desktop.expectData({ success: false, error: "SQLITE_BUSY: database is locked", code: "cursor_vscdb_busy" }, "Switch");
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof desktop.DesktopError);
  assert.equal(error.code, "cursor_vscdb_busy");
  assert.equal(toUserMessage(error), "官方 Cursor 还在占用登录库，请关掉后再切");
  assert.equal(toCursorUserMessage(error), "官方 Cursor 还在占用登录库，请关掉后再切");

  // The code wins even when the message would have matched a different rule.
  const misleading = new desktop.DesktopError("HTTP 500 upstream", "reauthorization_required");
  assert.equal(toUserMessage(misleading), "该账号需要重新授权后才能继续操作");

  // Refined codes keep the more specific message copy when it exists.
  const refined = new desktop.DesktopError(
    "The target account requires reauthorization before quotas can be refreshed",
    "reauthorization_required",
  );
  assert.equal(toUserMessage(refined), "该账号需要重新授权后才能刷新额度");

  // Bare code strings and plain messages still work.
  assert.equal(toUserMessage("account_banned"), "账号已封号，无法继续使用。");
  assert.equal(toUserMessage("probe_failed"), "额度暂时没刷到，登录还在。请稍后再试。");
  assert.equal(toUserMessage(new Error("Account does not exist")), "账号不存在");
  assert.equal(toUserMessage(new desktop.DesktopError("whatever", "no_such_code_xyz")), "操作失败，请稍后重试");
});

test("daemon failures are translated per account by code, not by parsing a joined string", () => {
  const desktop = loadDesktop({});
  const joined = desktop.daemonErrorCopy({
    message: "Token refresh failed: HTTP 500; Official Cursor did not exit: 4242",
    failures: [
      { stage: "token_refresh", email: "a@example.com", code: "token_refresh_failed", message: "Token refresh failed: HTTP 500" },
      { stage: "auth_inspect", email: null, code: "cursor_process_still_running", message: "Official Cursor did not exit: 4242" },
      { stage: "token_refresh", email: "a@example.com", code: "token_refresh_failed", message: "Token refresh failed: HTTP 500" },
    ],
  });
  assert.equal(joined, "a@example.com：令牌刷新失败；官方 Cursor 没能退出，请手动关掉后再切");
  assert.equal(desktop.daemonErrorCopy({ message: "boom", code: "account_index_invalid" }), "账号索引文件损坏");
  assert.equal(desktop.daemonErrorCopy({ message: "Daemon error" }), "后台检查失败，请稍后重试");
  assert.equal(desktop.daemonErrorCopy(undefined), "后台检查失败，请稍后重试");
});

test("the renderer hands the whole error to the translator", () => {
  const logic = readRendererLogicSource();
  const accounts = fs.readFileSync(path.join(projectRoot, "src", "renderer-react", "components", "AccountsView.tsx"), "utf8");
  assert.doesNotMatch(logic, /to(?:Cursor|Antigravity)?UserMessage\(error instanceof Error \? error\.message : String\(error\)\)/);
  assert.doesNotMatch(accounts, /formMessage\(product, error instanceof Error \? error\.message : String\(error\)\)/);
  assert.ok((logic.match(/toUserMessage\(error\)/g) || []).length >= 8);
  assert.match(logic, /toUserMessage\(result\.error\)/, "config save failures also pass the error object");
});

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  APP_USER_MODEL_ID,
  MAIN_NATIVE_TITLE,
  applyAppUserModelId,
  applyMainTaskbarExclusion,
  createTaskbarHost,
  parkHostWindow,
} = require("../src/main/taskbar-minimize");

function createFakeWindow(opts = {}) {
  const listeners = new Map();
  const win = {
    destroyed: false,
    minimized: false,
    visible: opts.show === true,
    skipTaskbar: !!opts.skipTaskbar,
    focused: false,
    bounds: {
      x: opts.x ?? 80,
      y: opts.y ?? 80,
      width: opts.width ?? 1440,
      height: opts.height ?? 900,
    },
    title: opts.title || "",
    on(event, handler) {
      const list = listeners.get(event) || [];
      list.push(handler);
      listeners.set(event, list);
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) || []) handler(...args);
    },
    isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; },
    isVisible() { return this.visible && !this.destroyed; },
    isFocused() { return this.focused; },
    setSkipTaskbar(value) { this.skipTaskbar = !!value; },
    setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; },
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; },
    setMenuBarVisibility() {},
    loadURL() { return Promise.resolve(); },
    show() {
      this.visible = true;
      this.minimized = false;
      this.emit("show");
    },
    showInactive() {
      this.visible = true;
    },
    hide() { this.visible = false; },
    minimize() {
      this.minimized = true;
      this.focused = false;
      this.emit("minimize");
    },
    restore() {
      this.minimized = false;
      this.visible = true;
      this.emit("restore");
    },
    focus() {
      this.focused = true;
      this.visible = true;
      this.emit("focus");
    },
    blur() {
      this.focused = false;
      this.emit("blur");
    },
    destroy() { this.destroyed = true; },
  };
  return win;
}

function createHost() {
  let constructed = null;
  function BrowserWindow(opts) {
    constructed = createFakeWindow(opts);
    return constructed;
  }
  const api = createTaskbarHost({
    BrowserWindow,
    iconPath: "icon.ico",
    title: "Codex Account Manager",
  });
  const main = createFakeWindow({
    width: 1440,
    height: 900,
    skipTaskbar: true,
    title: "Codex Account Manager",
  });
  api.attachMain(main);
  return { api, host: api.host, main, constructed };
}

test("AppUserModelId matches the packaged app id", () => {
  assert.equal(APP_USER_MODEL_ID, "com.3xiaoshayu.codex-account-manager");
  const calls = [];
  assert.equal(applyAppUserModelId({ setAppUserModelId: (id) => calls.push(id) }), true);
  assert.deepEqual(calls, [APP_USER_MODEL_ID]);
});

test("parkHostWindow keeps the framed host off-screen", () => {
  const host = createFakeWindow({ x: 40, y: 40, width: 400, height: 300 });
  parkHostWindow(host);
  assert.equal(host.bounds.x, -32000);
  assert.equal(host.bounds.y, -32000);
  assert.equal(host.bounds.width, 1);
  assert.equal(host.bounds.height, 1);
});

test("host minimize and restore keep the visible main window in sync", () => {
  const { api, host, main } = createHost();
  api.present();
  main.show();
  main.focus();
  assert.equal(main.skipTaskbar, true);
  assert.equal(api.inspect().hostSkipTaskbar, false);

  api.minimize();
  assert.equal(host.minimized, true);
  assert.equal(main.minimized, true);

  api.reveal();
  assert.equal(host.minimized, false);
  assert.equal(main.minimized, false);
  assert.equal(main.visible, true);
  assert.equal(main.focused, true);
});

test("restoring then activating the host does not immediately minimize again", async () => {
  const { api, host, main } = createHost();
  api.present();
  main.show();
  main.focus();
  api.minimize();
  api.reveal();
  host.emit("focus");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(host.minimized, false);
  assert.equal(main.minimized, false);
  assert.equal(main.visible, true);
});

test("activating the host while the main window is focused minimizes both", async () => {
  const { api, host, main } = createHost();
  api.present();
  main.show();
  main.focus();
  host.emit("focus");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(host.minimized, true);
  assert.equal(main.minimized, true);
});

test("title-bar minus minimizes the host so the taskbar button stays", () => {
  const { api, host, main } = createHost();
  api.present();
  main.show();
  api.minimize();
  assert.equal(host.minimized, true);
  assert.equal(main.minimized, true);
  assert.equal(api.inspect().hostOnTaskbar, true);
  assert.equal(api.inspect().hostSkipTaskbar, false);
});

test("close-to-tray hides both windows and removes the taskbar button", () => {
  const { api, host, main } = createHost();
  api.present();
  main.show();
  api.hideToTray();
  assert.equal(main.visible, false);
  assert.equal(host.visible, false);
  assert.equal(api.inspect().hostSkipTaskbar, true);
  assert.equal(api.inspect().hostOnTaskbar, false);

  api.reveal();
  assert.equal(host.visible, true);
  assert.equal(main.visible, true);
  assert.equal(api.inspect().hostSkipTaskbar, false);
});

test("main window exclusion keeps the official app id and a private native title", () => {
  const details = [];
  const titles = [];
  const win = {
    skipTaskbar: false,
    setSkipTaskbar(value) { this.skipTaskbar = !!value; },
    setAppDetails(options) { details.push(options); },
    setTitle(title) { titles.push(title); },
  };
  assert.equal(applyMainTaskbarExclusion(win), true);
  assert.equal(win.skipTaskbar, true);
  assert.deepEqual(details, [{ appId: APP_USER_MODEL_ID }]);
  assert.deepEqual(titles, [MAIN_NATIVE_TITLE]);
});

test("host close while running hides to tray instead of quitting", () => {
  const { api, host, main } = createHost();
  api.present();
  main.show();
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  host.emit("close", event);
  assert.equal(event.prevented, true);
  assert.equal(main.visible, false);
  assert.equal(api.inspect().hostSkipTaskbar, true);
});

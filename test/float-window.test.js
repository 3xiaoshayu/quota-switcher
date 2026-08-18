const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  FLOAT_HEIGHT,
  FLOAT_WIDTH,
  clampFloatBounds,
  clampFloatHeight,
  createFloatWindowController,
  defaultFloatPosition,
  loadFloatState,
} = require("../src/main/float-window");

test("float window defaults to the top-right of the work area", () => {
  const position = defaultFloatPosition({ x: 0, y: 0, width: 1920, height: 1080 }, FLOAT_WIDTH, FLOAT_HEIGHT, 20);
  assert.equal(position.x, 1920 - FLOAT_WIDTH - 20);
  assert.equal(position.y, 20);
});

test("float window stays fully inside a smaller work area", () => {
  const clamped = clampFloatBounds(
    { x: 5000, y: -40, width: FLOAT_WIDTH, height: FLOAT_HEIGHT },
    { x: 100, y: 50, width: 800, height: 600 },
  );
  assert.equal(clamped.x, 100 + 800 - FLOAT_WIDTH);
  assert.equal(clamped.y, 50);
  assert.equal(clamped.width, FLOAT_WIDTH);
  assert.equal(clamped.height, FLOAT_HEIGHT);
});

test("float window does not leave the origin when it is larger than the display", () => {
  const clamped = clampFloatBounds(
    { x: -20, y: -20, width: 2000, height: 2000 },
    { x: 0, y: 0, width: 800, height: 600 },
  );
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 0);
});

test("float height is clamped to the window range", () => {
  assert.equal(clampFloatHeight("nope"), FLOAT_HEIGHT);
  assert.equal(clampFloatHeight(100), 360);
  assert.equal(clampFloatHeight(900), 720);
  assert.equal(clampFloatHeight(600), 600);
});

test("float window state restores a saved height", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-window-"));
  fs.writeFileSync(path.join(dir, "float-window.json"), JSON.stringify({
    alwaysOnTop: false,
    x: 80,
    y: 40,
    height: 600,
  }));
  const saved = loadFloatState(dir);
  assert.equal(saved.height, 600);
  fs.writeFileSync(path.join(dir, "float-window.json"), JSON.stringify({ height: 9999 }));
  assert.equal(loadFloatState(dir).height, 720);
});

test("float window persists height after setHeight", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-window-"));
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  class FakeWindow {
    constructor(opts) {
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.destroyed = false;
      this.visible = false;
      this.url = "";
      const win = this;
      this.webContents = {
        setWindowOpenHandler() {},
        on() {},
        once(event, cb) {
          if (event === "did-finish-load") setImmediate(cb);
        },
        getURL: () => win.url,
        isLoadingMainFrame: () => !win.url,
      };
    }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    setBounds(next) { this.bounds = { ...this.bounds, ...next }; }
    setSize(width, height) {
      this.bounds.width = width;
      this.bounds.height = height;
    }
    setResizable() {}
    setMinimumSize() {}
    setMaximumSize() {}
    setMenuBarVisibility() {}
    setBackgroundColor() {}
    setHasShadow() {}
    setAlwaysOnTop() {}
    setSkipTaskbar(value) { this.skipTaskbar = !!value; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    restore() {}
    moveTop() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    once(event, cb) {
      if (event === "ready-to-show") setImmediate(cb);
    }
    loadFile() {
      this.url = "file://index.html#float";
      return Promise.resolve();
    }
    on() {}
    removeAllListeners() {}
    destroy() { this.destroyed = true; }
  }

  const controller = createFloatWindowController({
    app: { getPath: () => dir },
    BrowserWindow: FakeWindow,
    screen: {
      getDisplayNearestPoint: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea }),
    },
    trustWebContents() {},
    rendererHtml: "index.html",
    preloadPath: "preload.js",
    iconPath: "icon.ico",
    isQuitting: () => true,
    writeJsonAtomic(file, data) {
      fs.writeFileSync(file, JSON.stringify(data));
    },
  });

  controller.show();
  controller.setHeight(600);
  const saved = loadFloatState(dir);
  assert.equal(saved.height, 600);

  controller.destroy();
  controller.show();
  assert.equal(loadFloatState(dir).height, 600);
});

test("float window shows immediately and again after hide", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-window-"));
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  let created = null;
  class FakeWindow {
    constructor(opts) {
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.destroyed = false;
      this.visible = false;
      this.url = "";
      this.readyCb = null;
      const win = this;
      this.webContents = {
        setWindowOpenHandler() {},
        on() {},
        once() {},
        getURL: () => win.url,
        isLoadingMainFrame: () => !win.url,
      };
      created = this;
    }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    setBounds(next) { this.bounds = { ...this.bounds, ...next }; }
    setSize() {}
    setResizable() {}
    setMinimumSize() {}
    setMaximumSize() {}
    setMenuBarVisibility() {}
    setBackgroundColor() {}
    setHasShadow() {}
    setAlwaysOnTop(_enabled, level) { this.onTopLevel = level; }
    setSkipTaskbar(value) { this.skipTaskbar = !!value; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    restore() {}
    moveTop() { this.movedTop = true; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    once(event, cb) {
      if (event === "ready-to-show") this.readyCb = cb;
    }
    loadFile() {
      return Promise.resolve();
    }
    on() {}
    removeAllListeners() {}
    destroy() { this.destroyed = true; }
  }

  const controller = createFloatWindowController({
    app: { getPath: () => dir },
    BrowserWindow: FakeWindow,
    screen: {
      getDisplayNearestPoint: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea }),
    },
    trustWebContents() {},
    rendererHtml: "index.html",
    preloadPath: "preload.js",
    iconPath: "icon.ico",
    isQuitting: () => true,
    writeJsonAtomic(file, data) {
      fs.writeFileSync(file, JSON.stringify(data));
    },
  });

  controller.show();
  assert.equal(created.visible, true);
  assert.equal(created.skipTaskbar, false);
  assert.equal(created.onTopLevel, "screen-saver");
  assert.equal(created.movedTop, true);
  assert.equal(created.focused, true);
  assert.equal(controller.inspect().visible, true);

  created.movedTop = false;
  controller.hide();
  assert.equal(created.visible, false);
  assert.equal(created.skipTaskbar, true);

  controller.show();
  assert.equal(created.visible, true);
  assert.equal(created.skipTaskbar, false);
  assert.equal(created.movedTop, true);
  controller.destroy();
});

test("float window persists the current product", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-window-"));
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const sent = [];
  class FakeWindow {
    constructor(opts) {
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.destroyed = false;
      this.visible = false;
      this.title = opts.title;
      this.url = "";
      const win = this;
      this.webContents = {
        setWindowOpenHandler() {},
        on() {},
        once(event, cb) {
          if (event === "did-finish-load") setImmediate(cb);
        },
        send(channel, payload) { sent.push([channel, payload]); },
        getURL: () => win.url,
        isLoadingMainFrame: () => !win.url,
      };
    }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    setBounds(next) { this.bounds = { ...this.bounds, ...next }; }
    setSize() {}
    setResizable() {}
    setMinimumSize() {}
    setMaximumSize() {}
    setMenuBarVisibility() {}
    setBackgroundColor() {}
    setHasShadow() {}
    setAlwaysOnTop() {}
    setSkipTaskbar() {}
    setTitle(title) { this.title = title; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    restore() {}
    moveTop() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    once(event, cb) {
      if (event === "ready-to-show") setImmediate(cb);
    }
    loadFile() {
      this.url = "file://index.html#float";
      return Promise.resolve();
    }
    on() {}
    removeAllListeners() {}
    destroy() { this.destroyed = true; }
  }

  const controller = createFloatWindowController({
    app: { getPath: () => dir },
    BrowserWindow: FakeWindow,
    screen: {
      getDisplayNearestPoint: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea }),
    },
    trustWebContents() {},
    rendererHtml: "index.html",
    preloadPath: "preload.js",
    iconPath: "icon.ico",
    isQuitting: () => true,
    writeJsonAtomic(file, data) {
      fs.writeFileSync(file, JSON.stringify(data));
    },
  });

  controller.show("cursor");
  assert.equal(controller.getState().product, "cursor");
  assert.equal(loadFloatState(dir).product, "cursor");
  assert.ok(sent.some((item) => item[0] === "float:product" && item[1] === "cursor"));
  controller.destroy();
});

test("setProduct updates the float product without showing the window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-window-"));
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const sent = [];
  class FakeWindow {
    constructor(opts) {
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.destroyed = false;
      this.visible = false;
      this.title = opts.title;
      this.url = "";
      const win = this;
      this.webContents = {
        setWindowOpenHandler() {},
        on() {},
        once(event, cb) {
          if (event === "did-finish-load") setImmediate(cb);
        },
        send(channel, payload) { sent.push([channel, payload]); },
        getURL: () => win.url,
        isLoadingMainFrame: () => !win.url,
      };
    }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    setBounds(next) { this.bounds = { ...this.bounds, ...next }; }
    setSize() {}
    setResizable() {}
    setMinimumSize() {}
    setMaximumSize() {}
    setMenuBarVisibility() {}
    setBackgroundColor() {}
    setHasShadow() {}
    setAlwaysOnTop() {}
    setSkipTaskbar() {}
    setTitle(title) { this.title = title; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    restore() {}
    moveTop() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    once(event, cb) {
      if (event === "ready-to-show") setImmediate(cb);
    }
    loadFile() {
      this.url = "file://index.html#float";
      return Promise.resolve();
    }
    on() {}
    removeAllListeners() {}
    destroy() { this.destroyed = true; }
  }

  const controller = createFloatWindowController({
    app: { getPath: () => dir },
    BrowserWindow: FakeWindow,
    screen: {
      getDisplayNearestPoint: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea }),
    },
    trustWebContents() {},
    rendererHtml: "index.html",
    preloadPath: "preload.js",
    iconPath: "icon.ico",
    isQuitting: () => true,
    writeJsonAtomic(file, data) {
      fs.writeFileSync(file, JSON.stringify(data));
    },
  });

  controller.setProduct("cursor");
  assert.equal(controller.getState().product, "cursor");
  assert.equal(controller.getState().visible, false);
  assert.equal(controller.inspect().exists, false);
  assert.equal(loadFloatState(dir).product, "cursor");
  assert.equal(sent.length, 0);

  controller.show();
  assert.equal(controller.getState().visible, true);
  controller.hide();
  sent.length = 0;
  controller.setProduct("codex");
  assert.equal(controller.getState().product, "codex");
  assert.equal(controller.getState().visible, false);
  assert.equal(loadFloatState(dir).product, "codex");
  assert.ok(sent.some((item) => item[0] === "float:product" && item[1] === "codex"));
  controller.destroy();
});

test("dashboard product changes sync the float product and auto-open once", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer-react", "App.tsx"), "utf8");
  assert.match(source, /persistProduct/);
  assert.match(source, /setFloatProduct/);
  assert.match(source, /pickStartupFloatProduct/);
  assert.match(source, /didAutoShowFloat/);
  assert.match(source, /showFloatWindow\(chosen\)/);
  assert.match(source, /const handleProductChange = \(next: ProductKind\) => \{\s*persistProduct\(next\);/);
  assert.match(source, /setSwitchTarget\(null\)/);
  assert.match(source, /setIsRefreshingAll\(refreshAllKindRef\.current === next\)/);
  assert.match(source, /actionsLocked=\{\!\!\(product === 'antigravity' \? antigravityOAuthStatus\?\.pending/);
  assert.match(source, /oauthStatusFor/);
  assert.match(source, /result\.account\?\.id && productRef\.current === kind/);
  assert.match(source, /account\?\.id && productRef\.current === kind/);
  assert.match(source, /wasCursorOAuthPendingRef/);
  assert.match(source, /wasAntigravityOAuthPendingRef/);
  assert.match(source, /pending && !wasCursorOAuthPendingRef\.current && productRef\.current === 'cursor'/);
  assert.match(source, /nextOAuth\.pending && !wasOAuthPendingRef\.current && productRef\.current === 'codex'/);
  assert.match(source, /localOAuth\?\.pending && !incomingOAuth\.pending && incomingOAuth\.status === 'idle'/);
  assert.match(source, /if \(productRef\.current !== kind\) return;/);
  assert.match(source, /actions\.refreshQuota\(kind, account\.id, false\)/);
  assert.match(source, /didOpenQuotaSync/);
  assert.match(source, /actions\.refreshAllQuotas\(kind\)/);
  assert.match(source, /\(\['codex', 'cursor', 'antigravity'\] as ProductKind\[\]\)/);
  assert.match(source, /\.\.\.\(snapshot\.cursorAccounts \|\| \[\]\)/);
  assert.match(source, /\.\.\.\(snapshot\.antigravityAccounts \|\| \[\]\)/);
  assert.doesNotMatch(source, /!String\(account\.id\)\.startsWith\('cursor_'\)/);
});

test("float window is created as a system-minimizable hidden-titlebar window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-window-"));
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  let createdOpts = null;
  class FakeWindow {
    constructor(opts) {
      createdOpts = opts;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.destroyed = false;
      this.visible = false;
      this.url = "";
      this.webContents = {
        setWindowOpenHandler() {},
        on() {},
        once() {},
        getURL: () => "",
        isLoadingMainFrame: () => true,
      };
    }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    setBounds(next) { this.bounds = { ...this.bounds, ...next }; }
    setSize() {}
    setResizable() {}
    setMinimumSize() {}
    setMaximumSize() {}
    setMenuBarVisibility() {}
    setBackgroundColor() {}
    setHasShadow() {}
    setAlwaysOnTop() {}
    setSkipTaskbar() {}
    setTitle() {}
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    restore() {}
    moveTop() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    once() {}
    loadFile() { return Promise.resolve(); }
    on() {}
    removeAllListeners() {}
    destroy() { this.destroyed = true; }
  }

  const controller = createFloatWindowController({
    app: { getPath: () => dir },
    BrowserWindow: FakeWindow,
    screen: {
      getDisplayNearestPoint: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea }),
    },
    trustWebContents() {},
    rendererHtml: "index.html",
    preloadPath: "preload.js",
    iconPath: "icon.ico",
    isQuitting: () => true,
    writeJsonAtomic() {},
  });
  controller.show();
  assert.equal(createdOpts.frame, true);
  assert.equal(createdOpts.titleBarStyle, "hidden");
  assert.equal(createdOpts.minimizable, true);
  assert.equal(createdOpts.transparent, true);
  assert.equal(createdOpts.backgroundColor, "#00000000");
  controller.destroy();
});

test("float lens footer does not crash while accounts are loading", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer-react", "components", "FloatLens.tsx"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "renderer-react", "components", "FloatLens.css"), "utf8");
  assert.match(source, /!viewed \|\| canRefreshQuota\(viewed\)/);
  assert.match(source, /该账号需要重新授权后才能刷新额度/);
  assert.match(source, /STATUS_TEXT/);
  assert.match(source, /actions\.switchAccount/);
  assert.match(source, /if \(productRef.current === kind\) setSwitching\(false\);/);
  assert.match(source, /setRefreshing\(false\);\s*setSwitching\(false\);/);
  assert.match(source, /setAccounts\(\[\]\);\s*setViewedId\(null\);\s*setLoading\(true\);/);
  assert.match(source, /if \(!silent\) setRefreshing\(false\);/);
  assert.match(source, /next\?\.status === 'SYNC_FAILED'/);
  assert.match(source, /会关掉正在运行的官方 \{officialClientLabel\(product\)\}/);
  assert.match(source, /float-lens-mark/);
  assert.match(source, /floatChromeMark/);
  assert.doesNotMatch(source, /KeyRound/);
  assert.doesNotMatch(source, /float-lens-readout-icon/);
  assert.match(source, /heroPercent == null \? \(\s*isPair \? \(/);
  assert.doesNotMatch(css, /\.float-lens-readout-icon/);
  assert.match(source, /const showPair = isManagedProduct\(product\) && !hideQuota;/);
  assert.match(source, /openedRefreshKeyRef\.current === key/);
  assert.doesNotMatch(source, /showPair = product === 'cursor' && !hideQuota && !hideFailedQuota/);
  assert.doesNotMatch(source, /请回主窗口重新授权/);
  assert.doesNotMatch(source, /title=\{viewed\.status/);
  assert.doesNotMatch(source, /float-lens-cast/);
  assert.doesNotMatch(css, /\.float-lens-cast/);
  assert.match(css, /padding:\s*16px 24px 56px/);
  assert.match(css, /0 22px 36px rgba\(0, 0, 0, 0\.14\)/);
  assert.match(css, /\.float-lens-icon:disabled/);
  assert.match(css, /\.float-lens-confirm/);
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.doesNotMatch(css, /\.float-lens-error[\s\S]*white-space:\s*nowrap/);
});

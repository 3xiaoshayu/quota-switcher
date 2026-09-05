const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readRendererLogicSource, readRendererFile } = require("./helpers/renderer-source");
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

test("float window state retries a transient lock", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-window-"));
  const target = path.join(dir, "float-window.json");
  fs.writeFileSync(target, JSON.stringify({
    alwaysOnTop: true,
    x: 80,
    y: 40,
    height: 500,
    product: "cursor",
  }));
  const originalRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = (file, encoding) => {
    if (path.resolve(String(file)) === path.resolve(target) && failures < 2) {
      failures += 1;
      const error = new Error("EPERM: operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRead(file, encoding);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const saved = loadFloatState(dir);
  assert.equal(saved.alwaysOnTop, true);
  assert.equal(saved.product, "cursor");
  assert.equal(saved.height, 500);
  assert.equal(failures, 2);
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

test("renderer invariants that neither the unit tests nor the smoke test can see", () => {
  // Behaviour lives in test/app-modules.test.js and scripts/e2e-smoke.js; what
  // is left here are cross-file rules about state ownership.
  const source = readRendererLogicSource();
  const app = readRendererFile("App.tsx");
  const loader = readRendererFile("app", "useDashboardLoader.ts");
  const events = readRendererFile("app", "useDesktopEvents.ts");
  const actions = readRendererFile("app", "useAccountActions.ts");

  // Every auth-state write goes through one helper that filters the busy
  // placeholder, so a lock-busy daemon tick cannot wipe a real conflict.
  assert.match(app, /const applyAuthState = useCallback\(\(incoming: DesktopAuthState \| null \| undefined\) => \{\s*const next = resolveAuthStateAfterSnapshot\(incoming, authStateRef\.current\);\s*setAuthState\(next\);\s*authStateRef\.current = next;/);
  assert.equal((source.match(/setAuthState\(/g) || []).length, 1, "only applyAuthState may call setAuthState");
  assert.doesNotMatch(source, /authStateRef\.current = (?!next;)/);
  assert.doesNotMatch(source, /refs\.authState\.current = /);
  assert.match(loader, /applyAuthState\(snapshot\.authState\)/);
  assert.match(events, /onDaemonTick: \(payload\) => \{\s*if \(payload\?\.result\?\.authState\) applyAuthState\(payload\.result\.authState\);/);

  // Toasts only speak for the product that was showing when the action started.
  assert.ok((actions.match(/if \(productRef\.current !== kind\) return;/g) || []).length >= 8);

  // The startup lens opens once per session, from the loader, never from a view.
  assert.match(loader, /if \(!didAutoShowFloat\.current\) \{\s*didAutoShowFloat\.current = true;\s*const chosen = pickStartupFloatProduct\(/);
  assert.equal((source.match(/showFloatWindow\(chosen\)/g) || []).length, 1);

  // Auto-switch is gone: no daemon-driven switch events, no manual tick.
  assert.doesNotMatch(source, /onAutoSwitch|runAutoSwitchTick|autoswitch:executed/);
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

test("float lens visual decisions stay as designed", () => {
  // Ring geometry, spacing, and copy that were settled by hand against the
  // live window. The drawing rules themselves are behaviour-tested in
  // test/app-modules.test.js (float lens model).
  const source = readRendererFile("components", "FloatLens.tsx");
  const css = readRendererFile("components", "FloatLens.css");
  const adapter = readRendererFile("api", "product-adapter.ts");
  const model = readRendererFile("app", "float-lens-model.ts");
  assert.match(model, /该账号需要重新授权后才能刷新额度/);
  assert.match(source, /会关掉正在运行的官方 \{officialClientLabel\(product\)\}/);
  assert.match(source, /float-lens-mark/);
  assert.match(source, /floatChromeMark/);
  assert.match(source, /chromeMark\.length > 8 \? ' is-full'/);
  assert.doesNotMatch(adapter, /return 'AG'/);
  assert.match(adapter, /productById\(product\)\.label\.toUpperCase\(\)/);
  assert.match(css, /\.float-lens-mark\.is-full \{\s*letter-spacing:\s*0\.1em;/);
  assert.doesNotMatch(source, /KeyRound|float-lens-readout-icon|float-lens-cast|请回主窗口重新授权/);
  assert.doesNotMatch(css, /\.float-lens-readout-icon|\.float-lens-cast/);
  assert.match(source, /heroPercent == null \? \(\s*isPair && !captionBelow \? \(/);
  assert.match(source, /is-empty-text\$\{heroLabel\.length > 4 \? ' is-long' : ''\}/);
  assert.match(css, /\.float-lens-reset \{[\s\S]*white-space:\s*normal;/);
  assert.match(css, /\.float-lens-switch \{[\s\S]*white-space:\s*normal;/);
  assert.match(css, /padding:\s*16px 24px 56px/);
  assert.match(css, /\.float-lens button:focus \{\s*outline:\s*none;/);
  assert.match(css, /0 22px 36px rgba\(0, 0, 0, 0\.14\)/);
  assert.match(css, /\.float-lens-icon:disabled/);
  assert.match(css, /\.float-lens-confirm/);
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.doesNotMatch(css, /\.float-lens-error[\s\S]*white-space:\s*nowrap/);
  assert.doesNotMatch(source, /strokeDasharray=\{preview \? '3 7'|preview=\{!isCurrent\}/);
  assert.match(source, /const RING_SIZE = 156;/);
  assert.match(css, /\.float-lens-dial \{\s*position:\s*relative;\s*width:\s*156px;/);
  assert.match(css, /\.float-lens-dial\.is-pair,\s*\.float-lens-dial\.is-pair svg \{\s*width:\s*112px;/);
  assert.match(source, /nest=\{product === 'antigravity'\}/);
  assert.match(source, /const PAIR_NEST_OUTER_RADIUS = 42;/);
  assert.match(source, /const PAIR_NEST_INNER_RADIUS = 30;/);
  assert.match(css, /\.float-lens-dial\.is-pair\.is-nested \.float-lens-readout-value \{\s*font-size:\s*20px;/);
  assert.match(source, /const captionBelow = isPair && nested;/);
  assert.match(css, /\.float-lens-dial-caption \{/);
  assert.match(css, /\.float-lens-nav \{\s*display:\s*inline-flex;\s*flex-direction:\s*row;/);
  assert.match(css, /\.float-lens-plan\.is-status \{\s*color:\s*var\(--color-warn\);/);
  assert.doesNotMatch(css, /\.float-lens-plan\.is-status \{[^}]*background:\s*var\(--color-fill\)/);

  // Async writes only land for the product that started them, and a product
  // change restores that product's cached list before anything reloads.
  assert.ok((source.match(/if \(productRef\.current === kind\)/g) || []).length >= 4);
  assert.match(source, /if \(cached\) \{\s*setAccounts\(cached\.accounts\);\s*setViewedId\(cached\.viewedId\);\s*setLoading\(false\);/);
  assert.match(source, /if \(!silent\) setRefreshing\(false\);/);
});

test("float lens antigravity load skips official sync and restores product cache first", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer-react", "components", "FloatLens.tsx"), "utf8");
  const desktop = fs.readFileSync(path.join(__dirname, "..", "src", "renderer-react", "api", "desktop.ts"), "utf8");
  assert.match(desktop, /loadAntigravityState\(\{ skipOfficialSync: true \}\)/);
  assert.match(desktop, /async loadFloatAccounts\(product: ProductKind = 'codex'\) \{\s*if \(product === 'antigravity'\) \{\s*const snapshot = await desktopApi\.loadAntigravityState\(\{ skipOfficialSync: true \}\);/);
  assert.match(desktop, /listCursorAccounts\(\{ skipOfficialSync: true \}\)/);
  assert.match(desktop, /getCurrentCursorAccount\(\{ skipOfficialSync: true \}\)/);
  assert.match(source, /onAccountUpdated: \(payload\) => \{/);
  assert.match(source, /payload\?\.current && payload\.account\?\.id/);
  assert.match(source, /withCurrentFlag\(prev, currentId\)/);
  assert.doesNotMatch(source, /setViewedId\(currentId\);\s*return;/);
  assert.match(source, /setLoading\(false\);\s*\} else \{\s*setAccounts\(\[\]\)/);
});

test("float renderer is loaded through a dynamic import", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer-react", "main.tsx"), "utf8");
  assert.match(source, /import\('\.\/components\/FloatLens'\)/);
  assert.match(source, /import\('\.\/App'\)/);
  assert.doesNotMatch(source, /import App from/);
  assert.doesNotMatch(source, /import FloatLens from/);
});

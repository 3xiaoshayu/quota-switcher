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
  assert.doesNotMatch(source, /didOpenQuotaSync/);
  assert.match(source, /queueQuotaAutoSync/);
  assert.match(source, /authStateRef\.current\.status === 'conflict'/);
  assert.match(source, /desktopApi\.refreshQuota\(account\.id, false\)[\s\S]{0,240}toUserMessage\(error\)/);
  assert.doesNotMatch(source, /const authBlocked = authStateRef\.current\.requiresResolution/);
  assert.match(source, /actions\.switchAccount\(kind, id, isCurrent\)[\s\S]{0,720}if \(snapshot\) queueQuotaAutoSync\(snapshot\.accounts\)/);
  assert.match(source, /addLogEntry\(message, 'error', kind\);\s*try \{ await loadDashboardState\(false\); \} catch \{\}/);
  assert.match(source, /if \(result\?\.authState\) applyAuthState\(result\.authState\);/);
  // Auto-switch is gone: no daemon-driven switch events, no manual tick.
  assert.doesNotMatch(source, /onAutoSwitch|runAutoSwitchTick|autoswitch:executed/);
  assert.match(source, /onDaemonTick: \(payload\) => \{\s*if \(payload\?\.result\?\.authState\) applyAuthState\(payload\.result\.authState\);/);
  assert.match(source, /onAuthConflict: \(state\) => \{\s*applyAuthState\(state\);\s*const raw = state\.status && state\.status !== 'aligned'/);
  assert.match(source, /desktopApi\.adoptOfficialAccount\(\)[\s\S]{0,240}if \(account\?\.authState\) applyAuthState\(account\.authState\);/);
  assert.match(source, /desktopApi\.reapplyManagedAccount\([\s\S]{0,240}if \(result\?\.authState\) applyAuthState\(result\.authState\);/);
  assert.match(source, /管理账号已重新应用到官方 Codex[\s\S]{0,160}queueQuotaAutoSync\(snapshot\.accounts\)/);
  assert.match(source, /handleResolveAuthConflict[\s\S]{0,2400}toUserMessage\(error\)/);
  // Every auth-state write goes through one helper that filters the busy
  // placeholder, so a lock-busy daemon tick cannot wipe a real conflict.
  assert.match(source, /const applyAuthState = useCallback\(\(incoming: DesktopAuthState \| null \| undefined\) => \{\s*const next = resolveAuthStateAfterSnapshot\(incoming, authStateRef\.current\);\s*setAuthState\(next\);\s*authStateRef\.current = next;/);
  assert.match(source, /applyAuthState\(snapshot\.authState\)/);
  assert.equal((source.match(/setAuthState\(/g) || []).length, 1, "only applyAuthState may call setAuthState");
  assert.doesNotMatch(source, /authStateRef\.current = (?!next;)/);
  assert.match(source, /actions\.addAccount\(kind\)[\s\S]{0,240}if \(kind === 'codex' && added\?\.authState\)/);
  assert.match(source, /completeOAuthManually\(callbackUrl\)[\s\S]{0,200}if \(completed\?\.authState\)/);
  assert.match(source, /actions\.reauthorize\(kind, id\)[\s\S]{0,280}if \(kind === 'codex' && result\?\.authState\)/);
  assert.match(source, /if \(result\?\.authState\) applyAuthState\(result\.authState\);\s*if \(result\?\.mismatch\)/);
  // One browser authorization at a time across all three products, and a
  // rejected add/reauth must not re-toast an earlier flow's completed result.
  assert.match(source, /const anyOAuthPending = \(\) => !!oauthStatusFor\('codex'\)\?\.pending\s*\|\| !!oauthStatusFor\('cursor'\)\?\.pending\s*\|\| !!oauthStatusFor\('antigravity'\)\?\.pending;/);
  assert.match(source, /const oauthStatusEndedThisFlow = [\s\S]{0,200}status\.status !== 'completed'/);
  assert.equal((source.match(/if \(oauthStatusEndedThisFlow\(finished\)\)/g) || []).length, 2);
  // An operation's own follow-up load returns the fresher superseding snapshot
  // instead of null, and an in-flight config save is not reverted by an
  // older snapshot.
  assert.match(source, /const latestDashboardLoadRef = useRef<Promise<DashboardLoadResult \| null> \| null>\(null\);/);
  assert.match(source, /while \(latest && latest !== run\) \{\s*const outcome = await latest;\s*if \(outcome !== null\) return outcome;/);
  // The save sequencing itself is behaviour-tested in test/app-modules.test.js.
  assert.match(source, /const nextConfig = configSaves\.current\.pending > 0 \? daemonConfigRef\.current : snapshot\.config;/);
  assert.match(source, /await configSaves\.current\.enqueue\(\(\) => desktopApi\.saveDaemonConfig\(nextConfig\)\)/);
  assert.match(source, /if \(result\.latest\) \{\s*await loadDashboardState\(false\);/);
  assert.match(source, /result\?\.mismatch\) \{\s*if \(kind === 'codex' && result\?\.accountId && result\?\.switched !== false\) \{\s*applyCurrentAccountBadge\('codex', result\.accountId\);/);
  assert.match(source, /actions\.refreshAllQuotas\(kind\)/);
  assert.doesNotMatch(source, /\(\['codex', 'cursor', 'antigravity'\] as ProductKind\[\]\)/);
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
  const adapter = fs.readFileSync(path.join(__dirname, "..", "src", "renderer-react", "api", "product-adapter.ts"), "utf8");
  assert.match(source, /!viewed \|\| canRefreshQuota\(viewed\)/);
  assert.match(source, /该账号需要重新授权后才能刷新额度/);
  assert.match(source, /STATUS_TEXT/);
  assert.match(source, /actions\.switchAccount/);
  assert.match(source, /if \(productRef.current === kind\) setSwitching\(false\);/);
  assert.match(source, /setRefreshing\(false\);\s*setSwitching\(false\);/);
  assert.match(source, /if \(cached\) \{\s*setAccounts\(cached\.accounts\);\s*setViewedId\(cached\.viewedId\);\s*setLoading\(false\);\s*\} else \{\s*setAccounts\(\[\]\);\s*setViewedId\(null\);\s*setLoading\(true\);/);
  assert.match(source, /cacheRef\.current\[product\]/);
  assert.match(source, /if \(kind === 'antigravity' \|\| kind === 'cursor'\) \{\s*const refresh = kind === 'antigravity'\s*\? desktopApi\.loadAntigravityState\(\)\s*: desktopApi\.loadCursorState\(\);/);
  assert.doesNotMatch(source, /if \(kind === 'antigravity' \|\| kind === 'cursor'\) \{\s*setLoading\(true\)/);
  assert.match(source, /if \(!silent\) setRefreshing\(false\);/);
  assert.match(source, /next\?\.status === 'SYNC_FAILED'/);
  assert.match(source, /会关掉正在运行的官方 \{officialClientLabel\(product\)\}/);
  assert.match(source, /float-lens-mark/);
  assert.match(source, /floatChromeMark/);
  assert.match(source, /chromeMark\.length > 8 \? ' is-full'/);
  assert.doesNotMatch(adapter, /return 'AG'/);
  assert.match(adapter, /productById\(product\)\.label\.toUpperCase\(\)/);
  assert.match(css, /\.float-lens-mark\.is-full \{\s*letter-spacing:\s*0\.1em;/);
  assert.doesNotMatch(source, /KeyRound/);
  assert.doesNotMatch(source, /float-lens-readout-icon/);
  assert.match(source, /heroPercent == null \? \(\s*isPair && !captionBelow \? \(/);
  assert.match(source, /is-empty-text\$\{heroLabel\.length > 4 \? ' is-long' : ''\}/);
  assert.match(css, /\.float-lens-reset \{[\s\S]*white-space:\s*normal;/);
  assert.match(css, /\.float-lens-switch \{[\s\S]*white-space:\s*normal;/);
  assert.doesNotMatch(css, /\.float-lens-readout-icon/);
  assert.match(source, /const showPair = product === 'antigravity'\s*\? !!viewed\s*: isManagedProduct\(product\) && !hideQuota;/);
  assert.match(source, /openedRefreshKeyRef\.current === key/);
  assert.doesNotMatch(source, /showPair = product === 'cursor' && !hideQuota && !hideFailedQuota/);
  assert.doesNotMatch(source, /请回主窗口重新授权/);
  assert.doesNotMatch(source, /title=\{viewed\.status/);
  assert.doesNotMatch(source, /float-lens-cast/);
  assert.doesNotMatch(css, /\.float-lens-cast/);
  assert.match(css, /padding:\s*16px 24px 56px/);
  assert.match(css, /\.float-lens button:focus \{\s*outline:\s*none;/);
  assert.match(css, /0 22px 36px rgba\(0, 0, 0, 0\.14\)/);
  assert.match(css, /\.float-lens-icon:disabled/);
  assert.match(css, /\.float-lens-confirm/);
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.doesNotMatch(css, /\.float-lens-error[\s\S]*white-space:\s*nowrap/);
  assert.doesNotMatch(source, /strokeDasharray=\{preview \? '3 7'/);
  assert.doesNotMatch(source, /preview=\{!isCurrent\}/);
  assert.match(source, /const RING_SIZE = 156;/);
  assert.doesNotMatch(source, /const RING_SIZE = 188;/);
  assert.match(css, /\.float-lens-dial \{\s*position:\s*relative;\s*width:\s*156px;/);
  assert.match(css, /\.float-lens-dial\.is-pair,\s*\.float-lens-dial\.is-pair svg \{\s*width:\s*112px;/);
  assert.match(source, /const showInner = fiveHour != null \|\| nest;/);
  assert.match(source, /nest=\{product === 'antigravity'\}/);
  assert.match(source, /const PAIR_NEST_OUTER_RADIUS = 42;/);
  assert.match(source, /const PAIR_NEST_INNER_RADIUS = 30;/);
  assert.match(css, /\.float-lens-dial\.is-pair\.is-nested \.float-lens-readout-value \{\s*font-size:\s*20px;/);
  assert.match(source, /antigravityQuotaFamilies\(viewed\)/);
  assert.match(source, /fiveHour: null as number \| null/);
  assert.match(source, /const captionBelow = isPair && nested;/);
  assert.match(source, /float-lens-dial-caption/);
  assert.match(css, /\.float-lens-dial-caption \{/);
  assert.match(css, /\.float-lens-nav \{\s*display:\s*inline-flex;\s*flex-direction:\s*row;/);
  assert.match(css, /\.float-lens-plan\.is-status \{\s*color:\s*var\(--color-warn\);/);
  assert.doesNotMatch(css, /\.float-lens-plan\.is-status \{[^}]*background:\s*var\(--color-fill\)/);
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

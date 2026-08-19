const { app, BrowserWindow, dialog, safeStorage, screen, shell } = require("electron");
const path = require("path");
const { registerIpcHandlers } = require("./ipc-handlers");
const { createUpdateService } = require("./updater");
const { createAppTray } = require("./tray");
const { resolveAppIcon } = require("./app-icon");
const { createFloatWindowController } = require("./float-window");
const { applyAppUserModelId } = require("./taskbar-minimize");
const {
    MIN_MAIN_HEIGHT,
    MIN_MAIN_WIDTH,
    resolveMainWindowSize,
} = require("./main-window-bounds");
const { writeJsonAtomic } = require(path.resolve(__dirname, "..", "..", "engine", "atomic-file"));
const { applyAppProxy, applyStartupProxyHint } = require(path.resolve(__dirname, "..", "..", "engine", "proxy-resolve"));

applyAppUserModelId(app);

let mainWindow = null;
let appTray = null;
let floatWindow = null;
let isQuitting = false;
let startupHousekeepingStarted = false;
const trustedSenderIds = new Set();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function trustWebContents(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    trustedSenderIds.add(webContents.id);
    webContents.once("destroyed", () => trustedSenderIds.delete(webContents.id));
}

function focusMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function destroyAppTray() {
    if (!appTray) return;
    appTray.destroy();
    appTray = null;
}

function quitApplication() {
    isQuitting = true;
    if (floatWindow) {
        floatWindow.destroy();
        floatWindow = null;
    }
    destroyAppTray();
    app.quit();
}

function startStartupHousekeeping() {
    if (startupHousekeepingStarted) return;
    startupHousekeepingStarted = true;
    const eng = require("../../engine");
    setImmediate(() => {
        try { eng.listAccts(); } catch (error) {
            console.error("Startup account scan failed:", error);
        }
    });
    setTimeout(() => {
        applyAppProxy().catch((error) => {
            console.error("Background proxy probe failed:", error);
        });
    }, 2000);
}

function startApplication() {
    const eng = require("../../engine");
    if (!safeStorage.isEncryptionAvailable()) {
        dialog.showErrorBox(
            "Codex Account Manager",
            "Windows 凭据保护不可用，账号 Token 无法安全保存。应用将退出。",
        );
        app.quit();
        return;
    }
    eng.setSecretCodec({
        name: "windows-dpapi",
        encrypt: (plainText) => safeStorage.encryptString(plainText).toString("base64"),
        decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, "base64")),
    });
    eng.setOpenUrlHandler((url) => shell.openExternal(url));
    if (typeof eng.setCursorOpenUrlHandler === "function") {
      eng.setCursorOpenUrlHandler((url) => shell.openExternal(url));
    }
    if (typeof eng.setAntigravityOpenUrlHandler === "function") {
      eng.setAntigravityOpenUrlHandler((url) => shell.openExternal(url));
    }
    eng.initLogger();
    try {
      const workerHost = require("./engine-worker-host");
      if (workerHost.startEngineWorker()) {
        if (typeof eng.setHttpJsonTransport === "function") {
          eng.setHttpJsonTransport(workerHost.httpJson);
        }
        if (typeof eng.setSqliteReadTransport === "function") {
          eng.setSqliteReadTransport(workerHost.readVscdbItems);
        }
      }
    } catch (error) {
      console.error("Engine worker not started; using in-process engine:", error);
    }
    const restoredCodexOAuth = eng.restorePendingOAuth();
    if (restoredCodexOAuth) {
      if (typeof eng.discardPendingCursorOAuth === "function") {
        eng.discardPendingCursorOAuth("authorization is already in progress");
      }
      if (typeof eng.discardPendingAntigravityOAuth === "function") {
        eng.discardPendingAntigravityOAuth("authorization is already in progress");
      }
    } else if (typeof eng.restorePendingCursorOAuth === "function" && eng.restorePendingCursorOAuth()) {
      if (typeof eng.discardPendingAntigravityOAuth === "function") {
        eng.discardPendingAntigravityOAuth("authorization is already in progress");
      }
    } else if (typeof eng.restorePendingAntigravityOAuth === "function") {
      eng.restorePendingAntigravityOAuth();
    }

    const updateService = createUpdateService({ app, BrowserWindow });
    const launchSize = resolveMainWindowSize(screen.getPrimaryDisplay().workArea);
    const appIcon = resolveAppIcon();
    const win = new BrowserWindow({
        width: launchSize.width,
        height: launchSize.height,
        center: true,
        minWidth: MIN_MAIN_WIDTH,
        minHeight: MIN_MAIN_HEIGHT,
        frame: true,
        titleBarStyle: "hidden",
        autoHideMenuBar: true,
        title: "Codex Account Manager",
        backgroundColor: "#131315",
        show: false,
        icon: appIcon,
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "preload.js"),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
        },
    });
    mainWindow = win;
    win.on("close", (event) => {
        if (!isQuitting) {
            event.preventDefault();
            win.hide();
        }
    });
    win.on("closed", () => {
        if (mainWindow === win) mainWindow = null;
    });
    win.setMenuBarVisibility(false);
    floatWindow = createFloatWindowController({
        app,
        BrowserWindow,
        screen,
        trustWebContents,
        rendererHtml: path.join(__dirname, "..", "renderer-dist", "index.html"),
        preloadPath: path.join(__dirname, "..", "preload", "preload.js"),
        iconPath: appIcon,
        isQuitting: () => isQuitting,
        writeJsonAtomic,
    });
    appTray = createAppTray({
        onShow: focusMainWindow,
        onShowFloat: () => floatWindow?.show(),
        onQuit: quitApplication,
    });
    const daemon = registerIpcHandlers(eng, {
        updateService,
        trustedSenderIds,
        floatWindow,
        showMainWindow: focusMainWindow,
        minimizeMainWindow: () => mainWindow?.minimize(),
        mainWindow: win,
        onUiReady: startStartupHousekeeping,
    });
    trustWebContents(win.webContents);

    const openExternalUrl = (url) => {
        if (!/^https?:\/\//i.test(String(url || ""))) return;
        shell.openExternal(url).catch((error) => console.error("Failed to open external URL:", error));
    };
    win.webContents.setWindowOpenHandler(({ url }) => {
        openExternalUrl(url);
        return { action: "deny" };
    });
    const guardNavigation = (event, url) => {
        if (url === win.webContents.getURL()) return;
        event.preventDefault();
        if (/^https?:\/\//i.test(String(url || ""))) openExternalUrl(url);
    };
    win.webContents.on("will-navigate", guardNavigation);
    win.webContents.on("will-redirect", guardNavigation);

    win.once("ready-to-show", () => {
        const size = resolveMainWindowSize(screen.getPrimaryDisplay().workArea);
        if (typeof win.unmaximize === "function") win.unmaximize();
        if (typeof win.setSize === "function") win.setSize(size.width, size.height);
        if (typeof win.center === "function") win.center();
        win.show();
        updateService.startAutoCheck();
        setTimeout(startStartupHousekeeping, 5000);
    });
    win.loadFile(path.join(__dirname, "..", "renderer-dist", "index.html"))
        .catch((error) => console.error("Failed to load renderer:", error));

    // 自动启动守护进程（如果配置启用）
    try {
        const cfg = eng.loadAutoSwitchCfg();
        if (cfg && cfg.enabled) {
            daemon.startDaemon();
        }
    } catch (error) {
        console.error("Failed to start daemon:", error);
    }
}

// Without this guard a startup exception leaves a windowless zombie process
// holding the single-instance lock, and every later launch exits silently.
function reportStartupFailure(error) {
    console.error("Startup failed:", error);
    try {
        dialog.showErrorBox(
            "Codex Account Manager",
            `应用启动失败：${error?.message || error}`,
        );
    } catch {}
    app.quit();
}

if (!hasSingleInstanceLock) {
    app.quit();
} else {
    app.commandLine.appendSwitch("disable-quic");
    app.commandLine.appendSwitch("disable-http3");
    app.on("second-instance", () => {
        focusMainWindow();
    });
    app.on("before-quit", () => {
        isQuitting = true;
        try { require("./engine-worker-host").stopEngineWorker(); } catch {}
        if (floatWindow) {
            floatWindow.destroy();
            floatWindow = null;
        }
        destroyAppTray();
    });
    app.whenReady().then(async () => {
        try {
            await applyStartupProxyHint();
            startApplication();
        } catch (error) {
            reportStartupFailure(error);
        }
    }).catch(reportStartupFailure);
}

app.on("window-all-closed", () => app.quit());

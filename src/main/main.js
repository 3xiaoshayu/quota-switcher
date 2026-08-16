const { app, BrowserWindow, dialog, safeStorage, screen, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { registerIpcHandlers } = require("./ipc-handlers");
const { createUpdateService } = require("./updater");
const { createAppTray } = require("./tray");
const { resolveAppIcon } = require("./app-icon");
const { createFloatWindowController } = require("./float-window");
const { writeJsonAtomic } = require(path.resolve(__dirname, "..", "..", "engine", "atomic-file"));
const { applyAppProxy } = require(path.resolve(__dirname, "..", "..", "engine", "proxy-resolve"));

let mainWindow = null;
let appTray = null;
let floatWindow = null;
let isQuitting = false;
const trustedSenderIds = new Set();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function trustWebContents(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    trustedSenderIds.add(webContents.id);
    webContents.once("destroyed", () => trustedSenderIds.delete(webContents.id));
}

function windowStatePath() {
    return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
    try {
        const state = JSON.parse(fs.readFileSync(windowStatePath(), "utf8"));
        if (!state || typeof state !== "object") return null;
        const bounds = state.bounds;
        const isMaximized = !!state.isMaximized;
        if (!bounds
            || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
            || bounds.width <= 0 || bounds.height <= 0) {
            return { bounds: null, isMaximized };
        }
        // Display scaling can change between sessions; keep the window no
        // larger than the primary work area.
        const primaryArea = screen.getPrimaryDisplay().workArea;
        const width = Math.min(bounds.width, primaryArea.width);
        const height = Math.min(bounds.height, primaryArea.height);
        // Require a grabbable strip on some display, not just a 1px sliver:
        // the frameless window has no system menu to recover it otherwise.
        const visible = screen.getAllDisplays().some((display) => {
            const area = display.workArea;
            const overlapX = Math.min(bounds.x + width, area.x + area.width) - Math.max(bounds.x, area.x);
            const overlapY = Math.min(bounds.y + height, area.y + area.height) - Math.max(bounds.y, area.y);
            return overlapX >= 200 && overlapY >= 100;
        });
        return { bounds: visible ? { x: bounds.x, y: bounds.y, width, height } : null, isMaximized };
    } catch {
        return null;
    }
}

function saveWindowState(win, lastKnownMaximized) {
    try {
        // isMaximized() reports false for a minimized window even when it will
        // restore to the maximized state, so rely on the tracked value there.
        const maximized = win.isMinimized() ? !!lastKnownMaximized : win.isMaximized();
        writeJsonAtomic(windowStatePath(), {
            bounds: win.isMaximized() || win.isMinimized() ? win.getNormalBounds() : win.getBounds(),
            isMaximized: maximized,
        }, { backup: false });
    } catch {}
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
    eng.initLogger();
    const restoredCodexOAuth = eng.restorePendingOAuth();
    if (restoredCodexOAuth) {
      if (typeof eng.discardPendingCursorOAuth === "function") {
        eng.discardPendingCursorOAuth("authorization is already in progress");
      }
    } else if (typeof eng.restorePendingCursorOAuth === "function") {
      eng.restorePendingCursorOAuth();
    }

    const updateService = createUpdateService({ app, BrowserWindow });
    const savedWindowState = loadWindowState();
    const appIcon = resolveAppIcon();
    const win = new BrowserWindow({
        width: savedWindowState?.bounds?.width || 1440,
        height: savedWindowState?.bounds?.height || 900,
        ...(savedWindowState?.bounds
            ? { x: savedWindowState.bounds.x, y: savedWindowState.bounds.y }
            : { center: true }),
        minWidth: 1280, minHeight: 720,
        frame: false,
        autoHideMenuBar: true,
        title: "Codex Account Manager",
        backgroundColor: "#0f172a",
        show: false,
        icon: appIcon,
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "preload.js"),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
        },
    });
    mainWindow = win;
    if (savedWindowState?.isMaximized) win.maximize();
    let lastKnownMaximized = !!savedWindowState?.isMaximized;
    win.on("maximize", () => { lastKnownMaximized = true; });
    win.on("unmaximize", () => { lastKnownMaximized = false; });
    win.on("close", (event) => {
        saveWindowState(win, lastKnownMaximized);
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
        win.show();
        updateService.startAutoCheck();
        // Startup housekeeping (legacy migration, index sync) reads and
        // decrypts every account file; run it after the window is visible.
        setImmediate(() => {
            try { eng.listAccts(); } catch (error) {
                console.error("Startup account scan failed:", error);
            }
        });
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
    app.on("second-instance", focusMainWindow);
    app.on("before-quit", () => {
        isQuitting = true;
        if (floatWindow) {
            floatWindow.destroy();
            floatWindow = null;
        }
        destroyAppTray();
    });
    app.whenReady().then(async () => {
        try {
            await applyAppProxy();
            startApplication();
        } catch (error) {
            reportStartupFailure(error);
        }
    }).catch(reportStartupFailure);
}

app.on("window-all-closed", () => app.quit());

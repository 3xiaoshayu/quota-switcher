const { app, BrowserWindow, dialog, safeStorage, screen, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { registerIpcHandlers } = require("./ipc-handlers");
const { createUpdateService } = require("./updater");
const { writeJsonAtomic } = require(path.resolve(__dirname, "..", "..", "engine", "atomic-file"));

let mainWindow = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function windowStatePath() {
    return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
    try {
        const state = JSON.parse(fs.readFileSync(windowStatePath(), "utf8"));
        if (!state || typeof state !== "object") return null;
        const bounds = state.bounds;
        const isMaximized = !!state.isMaximized;
        if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
            return { bounds: null, isMaximized };
        }
        // Only restore the position when it still intersects a visible display
        // (monitor layouts change between sessions).
        const visible = screen.getAllDisplays().some((display) => {
            const area = display.workArea;
            return bounds.x < area.x + area.width
                && bounds.x + bounds.width > area.x
                && bounds.y < area.y + area.height
                && bounds.y + bounds.height > area.y;
        });
        return { bounds: visible ? bounds : null, isMaximized };
    } catch {
        return null;
    }
}

function saveWindowState(win) {
    try {
        writeJsonAtomic(windowStatePath(), {
            bounds: win.isMaximized() || win.isMinimized() ? win.getNormalBounds() : win.getBounds(),
            isMaximized: win.isMaximized(),
        }, { backup: false });
    } catch {}
}

function focusMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
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
    eng.initLogger();
    eng.listAccts();
    eng.restorePendingOAuth();

    const updateService = createUpdateService({ app, BrowserWindow });
    const savedWindowState = loadWindowState();
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
        icon: path.join(__dirname, "..", "..", "resources", "icon.ico"),
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "preload.js"),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
        },
    });
    mainWindow = win;
    if (savedWindowState?.isMaximized) win.maximize();
    win.on("close", () => saveWindowState(win));
    win.on("closed", () => {
        if (mainWindow === win) mainWindow = null;
    });
    win.setMenuBarVisibility(false);
    const daemon = registerIpcHandlers(eng, {
        updateService,
        trustedWebContentsId: win.webContents.id,
    });

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

if (!hasSingleInstanceLock) {
    app.quit();
} else {
    app.on("second-instance", focusMainWindow);
    app.whenReady().then(startApplication);
}

app.on("window-all-closed", () => app.quit());

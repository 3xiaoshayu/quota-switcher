const { app, BrowserWindow, dialog, safeStorage, shell } = require("electron");
const path = require("path");
const { registerIpcHandlers } = require("./ipc-handlers");
const { createUpdateService } = require("./updater");

app.whenReady().then(() => {
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
    const daemon = registerIpcHandlers(eng, { updateService });
    const win = new BrowserWindow({
        width: 1440, height: 900,
        minWidth: 1280, minHeight: 720,
        center: true,
        frame: true,
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
    win.setMenuBarVisibility(false);

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
});

app.on("window-all-closed", () => app.quit());

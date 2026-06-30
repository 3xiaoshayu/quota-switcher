const { app, BrowserWindow } = require("electron");
const path = require("path");
const { registerIpcHandlers } = require("./ipc-handlers");

app.whenReady().then(() => {
    const daemon = registerIpcHandlers();
    const win = new BrowserWindow({
        width: 1180, height: 760,
        minWidth: 420, minHeight: 560,
        frame: false, titleBarStyle: "hidden",
        backgroundColor: "#edf1f5",
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "preload.js"),
            contextIsolation: true, nodeIntegration: false, sandbox: false,
        },
    });

    win.once("ready-to-show", () => win.show());
    win.loadFile(path.join(__dirname, "..", "renderer", "index.html"))
        .catch((error) => console.error("Failed to load renderer:", error));

    // 自动启动守护进程（如果配置启用）
    try {
        const eng = require("../../engine");
        const cfg = eng.loadAutoSwitchCfg();
        if (cfg && cfg.enabled) {
            daemon.startDaemon();
        }
    } catch (error) {
        console.error("Failed to start daemon:", error);
    }
});

app.on("window-all-closed", () => app.quit());

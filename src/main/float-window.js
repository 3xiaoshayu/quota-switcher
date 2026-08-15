const path = require("path");
const fs = require("fs");

const FLOAT_WIDTH = 288;
const FLOAT_HEIGHT = 512;
const FLOAT_MARGIN = 20;
const FLOAT_HASH = "float";

function clampFloatBounds(bounds, workArea) {
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    const minX = workArea.x;
    const minY = workArea.y;
    const maxX = workArea.x + workArea.width - width;
    const maxY = workArea.y + workArea.height - height;
    return {
        x: Math.round(Math.min(Math.max(bounds.x, minX), Math.max(minX, maxX))),
        y: Math.round(Math.min(Math.max(bounds.y, minY), Math.max(minY, maxY))),
        width,
        height,
    };
}

function clampFloatHeight(height) {
    const value = Number(height);
    if (!Number.isFinite(value)) return FLOAT_HEIGHT;
    return Math.max(360, Math.min(720, Math.round(value)));
}

function defaultFloatPosition(workArea, width, height, margin = FLOAT_MARGIN) {
    return {
        x: workArea.x + workArea.width - width - margin,
        y: workArea.y + margin,
    };
}

function floatBoundsVisible(bounds, workArea) {
    const overlapX = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const overlapY = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
    return overlapX >= 80 && overlapY >= 80;
}

function floatStatePath(userDataPath) {
    return path.join(userDataPath, "float-window.json");
}

function loadFloatState(userDataPath) {
    try {
        const state = JSON.parse(fs.readFileSync(floatStatePath(userDataPath), "utf8"));
        if (!state || typeof state !== "object") return { alwaysOnTop: false, x: null, y: null, height: null };
        return {
            alwaysOnTop: !!state.alwaysOnTop,
            x: Number.isFinite(state.x) ? state.x : null,
            y: Number.isFinite(state.y) ? state.y : null,
            height: Number.isFinite(state.height) ? clampFloatHeight(state.height) : null,
        };
    } catch {
        return { alwaysOnTop: false, x: null, y: null, height: null };
    }
}

function createFloatWindowController(options) {
    const {
        app,
        BrowserWindow,
        screen,
        trustWebContents,
        rendererHtml,
        preloadPath,
        iconPath,
        isQuitting,
        writeJsonAtomic,
    } = options;

    let floatWindow = null;
    let persistTimer = null;
    let showRequested = false;
    let alwaysOnTop = false;

    const persistPath = () => floatStatePath(app.getPath("userData"));

    const persistNow = (extra = {}) => {
        if (!writeJsonAtomic) return;
        const bounds = floatWindow && !floatWindow.isDestroyed()
            ? floatWindow.getBounds()
            : null;
        const current = loadFloatState(app.getPath("userData"));
        try {
            writeJsonAtomic(persistPath(), {
                alwaysOnTop,
                x: bounds ? bounds.x : current.x,
                y: bounds ? bounds.y : current.y,
                height: bounds ? clampFloatHeight(bounds.height) : (current.height || FLOAT_HEIGHT),
                ...extra,
            }, { backup: false });
        } catch {}
    };

    const schedulePersist = () => {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            persistTimer = null;
            persistNow();
        }, 200);
    };

    const resolveBounds = (saved) => {
        const height = clampFloatHeight(saved && saved.height != null ? saved.height : FLOAT_HEIGHT);
        const hasSaved = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
        if (hasSaved) {
            const display = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y });
            if (display?.workArea) {
                const clamped = clampFloatBounds(
                    { x: saved.x, y: saved.y, width: FLOAT_WIDTH, height },
                    display.workArea,
                );
                if (floatBoundsVisible(clamped, display.workArea)) return clamped;
            }
        }
        let area = screen.getPrimaryDisplay().workArea;
        try {
            if (typeof screen.getCursorScreenPoint === "function") {
                const cursor = screen.getCursorScreenPoint();
                const near = screen.getDisplayNearestPoint(cursor);
                if (near?.workArea) area = near.workArea;
            }
        } catch {}
        const position = defaultFloatPosition(area, FLOAT_WIDTH, height);
        return { ...position, width: FLOAT_WIDTH, height };
    };

    const windowIsReady = (win) => {
        const url = win.webContents?.getURL?.() || "";
        if (!url) return false;
        if (typeof win.webContents.isLoadingMainFrame === "function") {
            return !win.webContents.isLoadingMainFrame();
        }
        return true;
    };

    const presentWindow = (win) => {
        if (!showRequested || !win || win.isDestroyed()) return;
        const saved = loadFloatState(app.getPath("userData"));
        win.setBounds(resolveBounds(saved));
        alwaysOnTop = true;
        if (typeof win.setAlwaysOnTop === "function") win.setAlwaysOnTop(true, "floating");
        if (typeof win.isMinimized === "function" && win.isMinimized()) win.restore();
        win.show();
        if (typeof win.moveTop === "function") win.moveTop();
        win.focus();
        persistNow({ alwaysOnTop: true });
    };

    const attachGuards = (win) => {
        win.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:\/\//i.test(String(url || ""))) {
                const { shell } = require("electron");
                shell.openExternal(url).catch((error) => console.error("Failed to open external URL:", error));
            }
            return { action: "deny" };
        });
        const guardNavigation = (event, url) => {
            const current = win.webContents.getURL();
            if (url === current) return;
            const normalized = String(url || "").replace(/\\/g, "/");
            if (normalized.startsWith("file:") && normalized.includes("/renderer-dist/")) return;
            event.preventDefault();
            if (/^https?:\/\//i.test(String(url || ""))) {
                const { shell } = require("electron");
                shell.openExternal(url).catch((error) => console.error("Failed to open external URL:", error));
            }
        };
        win.webContents.on("will-navigate", guardNavigation);
        win.webContents.on("will-redirect", guardNavigation);
    };

    const ensureWindow = () => {
        if (floatWindow && !floatWindow.isDestroyed()) return floatWindow;

        const saved = loadFloatState(app.getPath("userData"));
        alwaysOnTop = !!saved.alwaysOnTop;
        const bounds = resolveBounds(saved);

        const win = new BrowserWindow({
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            frame: false,
            transparent: true,
            backgroundColor: "#00000000",
            hasShadow: false,
            roundedCorners: false,
            skipTaskbar: true,
            resizable: false,
            maximizable: false,
            minimizable: false,
            fullscreenable: false,
            autoHideMenuBar: true,
            show: false,
            alwaysOnTop,
            title: "Codex 桌面额度",
            icon: iconPath,
            webPreferences: {
                preload: preloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });

        win.setMenuBarVisibility(false);
        win.setBackgroundColor("#00000000");
        if (typeof win.setHasShadow === "function") win.setHasShadow(false);
        if (alwaysOnTop && typeof win.setAlwaysOnTop === "function") {
            win.setAlwaysOnTop(true, "floating");
        }

        trustWebContents(win.webContents);
        attachGuards(win);

        win.on("moved", schedulePersist);
        win.on("close", (event) => {
            persistNow();
            if (!isQuitting()) {
                event.preventDefault();
                showRequested = false;
                win.hide();
            }
        });
        win.on("closed", () => {
            if (floatWindow === win) floatWindow = null;
        });
        win.once("ready-to-show", () => presentWindow(win));
        if (typeof win.webContents?.once === "function") {
            win.webContents.once("did-finish-load", () => presentWindow(win));
        }

        win.loadFile(rendererHtml, { hash: FLOAT_HASH })
            .catch((error) => console.error("Failed to load float window:", error));

        floatWindow = win;
        return win;
    };

    return {
        show() {
            showRequested = true;
            const win = ensureWindow();
            if (windowIsReady(win) || (typeof win.isVisible === "function" && win.isVisible())) {
                presentWindow(win);
            }
        },
        hide() {
            showRequested = false;
            if (floatWindow && !floatWindow.isDestroyed()) floatWindow.hide();
        },
        destroy() {
            showRequested = false;
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = null;
            }
            if (!floatWindow || floatWindow.isDestroyed()) {
                floatWindow = null;
                return;
            }
            persistNow();
            floatWindow.removeAllListeners("close");
            floatWindow.destroy();
            floatWindow = null;
        },
        setAlwaysOnTop(nextValue) {
            alwaysOnTop = !!nextValue;
            if (floatWindow && !floatWindow.isDestroyed()) {
                floatWindow.setAlwaysOnTop(alwaysOnTop, "floating");
            }
            persistNow({ alwaysOnTop });
        },
        getState() {
            const visible = !!(floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible());
            return { visible, alwaysOnTop };
        },
        inspect() {
            if (!floatWindow || floatWindow.isDestroyed()) {
                return { exists: false, visible: false, alwaysOnTop };
            }
            return {
                exists: true,
                visible: floatWindow.isVisible(),
                alwaysOnTop,
                bounds: floatWindow.getBounds(),
                url: floatWindow.webContents.getURL(),
            };
        },
        setHeight(height) {
            if (!floatWindow || floatWindow.isDestroyed()) return;
            const nextHeight = Math.max(380, Math.min(640, Math.round(Number(height) || 0)));
            const current = floatWindow.getBounds();
            if (Math.abs(current.height - nextHeight) <= 2 && Math.abs(current.width - FLOAT_WIDTH) <= 2) {
                return;
            }
            floatWindow.setResizable(true);
            floatWindow.setMinimumSize(FLOAT_WIDTH, 360);
            floatWindow.setMaximumSize(FLOAT_WIDTH, 720);
            floatWindow.setSize(FLOAT_WIDTH, nextHeight);
            floatWindow.setResizable(false);
            persistNow();
        },
        isThisWindow(win) {
            return !!(floatWindow && win === floatWindow);
        },
    };
}

module.exports = {
    FLOAT_WIDTH,
    FLOAT_HEIGHT,
    FLOAT_MARGIN,
    FLOAT_HASH,
    clampFloatBounds,
    clampFloatHeight,
    floatBoundsVisible,
    defaultFloatPosition,
    loadFloatState,
    createFloatWindowController,
};

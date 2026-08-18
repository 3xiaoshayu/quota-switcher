const path = require("path");
const fs = require("fs");

const FLOAT_WIDTH = 316;
const FLOAT_HEIGHT = 512;
const FLOAT_MARGIN = 20;
const FLOAT_HASH = "float";
const FLOAT_ON_TOP_LEVEL = "screen-saver";

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

function normalizeFloatProduct(value) {
    if (value === "cursor" || value === "antigravity") return value;
    return "codex";
}

function floatWindowTitle(product) {
    const kind = normalizeFloatProduct(product);
    if (kind === "antigravity") return "Antigravity 桌面额度";
    if (kind === "cursor") return "Cursor 桌面额度";
    return "Codex 桌面额度";
}

function loadFloatState(userDataPath) {
    try {
        const state = JSON.parse(fs.readFileSync(floatStatePath(userDataPath), "utf8"));
        if (!state || typeof state !== "object") {
            return { alwaysOnTop: false, x: null, y: null, height: null, product: "codex" };
        }
        return {
            alwaysOnTop: !!state.alwaysOnTop,
            x: Number.isFinite(state.x) ? state.x : null,
            y: Number.isFinite(state.y) ? state.y : null,
            height: Number.isFinite(state.height) ? clampFloatHeight(state.height) : null,
            product: normalizeFloatProduct(state.product),
        };
    } catch {
        return { alwaysOnTop: false, x: null, y: null, height: null, product: "codex" };
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
    let activeProduct = "codex";

    const persistPath = () => floatStatePath(app.getPath("userData"));
    try {
        activeProduct = normalizeFloatProduct(loadFloatState(app.getPath("userData")).product);
    } catch {}

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
                product: activeProduct,
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

    const applyOnTop = (win, enabled) => {
        if (!win || typeof win.setAlwaysOnTop !== "function") return;
        if (enabled) win.setAlwaysOnTop(true, FLOAT_ON_TOP_LEVEL);
        else win.setAlwaysOnTop(false);
    };

    const applyFloatTaskbarIdentity = (win) => {
        if (!win) return;
        if (typeof win.setAppDetails === "function") {
            win.setAppDetails({
                appId: "com.3xiaoshayu.codex-account-manager.float",
                relaunchDisplayName: floatWindowTitle(activeProduct),
                relaunchCommand: process.execPath,
            });
        }
        if (typeof win.setSkipTaskbar === "function") win.setSkipTaskbar(false);
    };

    const notifyProduct = (win) => {
        if (!win || win.isDestroyed() || !win.webContents) return;
        if (typeof win.setTitle === "function") win.setTitle(floatWindowTitle(activeProduct));
        applyFloatTaskbarIdentity(win);
        if (typeof win.webContents.send === "function") {
            win.webContents.send("float:product", activeProduct);
        }
    };

    const applyProduct = (product) => {
        activeProduct = normalizeFloatProduct(product);
        if (floatWindow && !floatWindow.isDestroyed()) notifyProduct(floatWindow);
        persistNow({ product: activeProduct });
    };

    const presentWindow = (win) => {
        if (!showRequested || !win || win.isDestroyed()) return;
        const saved = loadFloatState(app.getPath("userData"));
        win.setBounds(resolveBounds(saved));
        alwaysOnTop = true;
        applyFloatTaskbarIdentity(win);
        applyOnTop(win, true);
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
        activeProduct = normalizeFloatProduct(saved.product);
        const bounds = resolveBounds(saved);

        const win = new BrowserWindow({
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            frame: true,
            titleBarStyle: "hidden",
            transparent: true,
            backgroundColor: "#00000000",
            hasShadow: false,
            roundedCorners: false,
            skipTaskbar: false,
            resizable: false,
            maximizable: false,
            minimizable: true,
            fullscreenable: false,
            autoHideMenuBar: true,
            show: false,
            alwaysOnTop,
            title: floatWindowTitle(activeProduct),
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
        if (alwaysOnTop) applyOnTop(win, true);

        trustWebContents(win.webContents);
        attachGuards(win);

        win.on("moved", schedulePersist);
        win.on("close", (event) => {
            persistNow();
            if (!isQuitting()) {
                event.preventDefault();
                showRequested = false;
                if (typeof win.setSkipTaskbar === "function") win.setSkipTaskbar(true);
                win.hide();
            }
        });
        win.on("closed", () => {
            if (floatWindow === win) floatWindow = null;
        });
        win.once("ready-to-show", () => presentWindow(win));
        if (typeof win.webContents?.once === "function") {
            win.webContents.once("did-finish-load", () => {
                notifyProduct(win);
                presentWindow(win);
            });
        }

        win.loadFile(rendererHtml, { hash: FLOAT_HASH })
            .catch((error) => console.error("Failed to load float window:", error));

        floatWindow = win;
        return win;
    };

    return {
        show(product) {
            showRequested = true;
            const win = ensureWindow();
            if (product != null) applyProduct(product);
            else notifyProduct(win);
            presentWindow(win);
        },
        setProduct(product) {
            applyProduct(product);
        },
        hide() {
            showRequested = false;
            if (floatWindow && !floatWindow.isDestroyed()) {
                if (typeof floatWindow.setSkipTaskbar === "function") floatWindow.setSkipTaskbar(true);
                floatWindow.hide();
            }
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
            if (floatWindow && !floatWindow.isDestroyed()) applyOnTop(floatWindow, alwaysOnTop);
            persistNow({ alwaysOnTop });
        },
        getState() {
            const visible = !!(floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible());
            return { visible, alwaysOnTop, product: activeProduct };
        },
        inspect() {
            if (!floatWindow || floatWindow.isDestroyed()) {
                return { exists: false, visible: false, alwaysOnTop, product: activeProduct };
            }
            return {
                exists: true,
                visible: floatWindow.isVisible(),
                alwaysOnTop,
                product: activeProduct,
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
    normalizeFloatProduct,
    createFloatWindowController,
};

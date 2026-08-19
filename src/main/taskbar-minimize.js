"use strict";

const APP_USER_MODEL_ID = "com.3xiaoshayu.codex-account-manager";
const SURFACE_APP_USER_MODEL_ID = `${APP_USER_MODEL_ID}.surface`;
const { APP_DISPLAY_NAME } = require("../../engine/app-brand");
const HOST_TITLE = APP_DISPLAY_NAME;
const MAIN_NATIVE_TITLE = "\u200b";

function applyHostTaskbarIdentity(win) {
    if (!win) return false;
    if (typeof win.setSkipTaskbar === "function") win.setSkipTaskbar(false);
    if (typeof win.setAppDetails === "function") win.setAppDetails({ appId: APP_USER_MODEL_ID });
    if (typeof win.setTitle === "function") win.setTitle(HOST_TITLE);
    return true;
}

function applyMainTaskbarExclusion(win) {
    if (!win) return false;
    if (typeof win.setSkipTaskbar === "function") win.setSkipTaskbar(true);
    if (typeof win.setAppDetails === "function") win.setAppDetails({ appId: APP_USER_MODEL_ID });
    if (typeof win.setTitle === "function") win.setTitle(MAIN_NATIVE_TITLE);
    return true;
}

function applyAppUserModelId(electronApp) {
    if (typeof electronApp?.setAppUserModelId !== "function") return false;
    electronApp.setAppUserModelId(APP_USER_MODEL_ID);
    return true;
}

function parkHostWindow(host) {
    if (!host || typeof host.isDestroyed === "function" && host.isDestroyed()) return;
    if (typeof host.setBounds === "function") {
        host.setBounds({ x: -32000, y: -32000, width: 1, height: 1 });
        return;
    }
    if (typeof host.setPosition === "function") host.setPosition(-32000, -32000);
}

function createTaskbarHost({ BrowserWindow, iconPath, title = HOST_TITLE }) {
    if (typeof BrowserWindow !== "function") {
        throw new Error("BrowserWindow is required");
    }
    const host = new BrowserWindow({
        width: 1,
        height: 1,
        x: -32000,
        y: -32000,
        frame: true,
        skipTaskbar: false,
        show: false,
        minimizable: true,
        maximizable: false,
        closable: true,
        title,
        icon: iconPath,
        backgroundColor: "#131315",
        autoHideMenuBar: true,
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    if (typeof host.setMenuBarVisibility === "function") host.setMenuBarVisibility(false);
    if (typeof host.setOpacity === "function") host.setOpacity(0);
    if (typeof host.setFocusable === "function") host.setFocusable(true);
    applyHostTaskbarIdentity(host);
    if (typeof host.loadURL === "function") {
        host.loadURL("about:blank").catch(() => {});
    }

    let main = null;
    let onTaskbar = false;
    let hostSkipTaskbar = false;
    let syncing = false;
    let quitting = false;
    let revealing = false;
    let justRestored = false;
    let restoreTimer = null;
    let mainHadFocus = false;
    let lastFocused = "main";
    let mainBlurTimer = null;

    function lowWord(wParam) {
        if (Buffer.isBuffer(wParam)) {
            return wParam.length >= 2 ? wParam.readUInt16LE(0) : wParam[0] || 0;
        }
        return Number(wParam) & 0xffff;
    }

    function markRestored() {
        justRestored = true;
        revealing = true;
        lastFocused = "main";
        mainHadFocus = true;
        if (restoreTimer && typeof clearTimeout === "function") clearTimeout(restoreTimer);
        const delay = typeof setTimeout === "function" ? setTimeout : (fn) => fn();
        restoreTimer = delay(() => {
            justRestored = false;
            revealing = false;
        }, 400);
    }

    function handleHostActivation() {
        if (revealing || syncing || quitting || justRestored || isGone(main)) return;
        const hostMin = typeof host.isMinimized === "function" && host.isMinimized();
        const mainMin = typeof main.isMinimized === "function" && main.isMinimized();
        if (hostMin || mainMin) {
            reveal();
            return;
        }
        const mainVisible = typeof main.isVisible !== "function" || main.isVisible();
        if (mainVisible && lastFocused === "main") {
            lastFocused = "host";
            minimize();
            return;
        }
        parkHostWindow(host);
        if (mainVisible && typeof main.focus === "function") main.focus();
    }

    function withSync(work) {
        if (syncing) return;
        syncing = true;
        try { work(); } finally { syncing = false; }
    }

    function isGone(win) {
        return !win || (typeof win.isDestroyed === "function" && win.isDestroyed());
    }

    host.on("close", (event) => {
        if (quitting || isGone(main)) return;
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        hideToTray();
    });
    host.on("show", () => {
        if (typeof host.isMinimized === "function" && host.isMinimized()) return;
        parkHostWindow(host);
    });
    host.on("focus", () => {
        if (revealing || syncing || quitting) return;
        const delay = typeof setTimeout === "function" ? setTimeout : (fn) => fn();
        delay(() => handleHostActivation(), 30);
    });
    if (typeof host.hookWindowMessage === "function") {
        host.hookWindowMessage(0x0006, (wParam) => {
            const code = lowWord(wParam);
            if (code === 1 || code === 2) {
                if (typeof setImmediate === "function") setImmediate(handleHostActivation);
                else handleHostActivation();
            }
            return false;
        });
    }
    host.on("minimize", () => {
        withSync(() => {
            if (isGone(main) || (typeof main.isMinimized === "function" && main.isMinimized())) return;
            if (typeof main.minimize === "function") main.minimize();
        });
    });
    host.on("restore", () => {
        markRestored();
        withSync(() => {
            parkHostWindow(host);
            if (isGone(main)) return;
            if (typeof main.isMinimized === "function" && main.isMinimized() && typeof main.restore === "function") {
                main.restore();
            }
            if (typeof main.show === "function") main.show();
            if (typeof main.focus === "function") main.focus();
        });
    });

    function attachMain(win) {
        main = win;
        if (!main) return;
        applyMainTaskbarExclusion(main);
        const excludeMain = () => applyMainTaskbarExclusion(main);
        main.on("show", () => {
            excludeMain();
            lastFocused = "main";
            mainHadFocus = true;
        });
        main.on("focus", () => {
            lastFocused = "main";
            mainHadFocus = true;
            if (mainBlurTimer && typeof clearTimeout === "function") clearTimeout(mainBlurTimer);
        });
        if (main.webContents && typeof main.webContents.on === "function") {
            main.webContents.on("focus", () => {
                lastFocused = "main";
                mainHadFocus = true;
            });
        }
        main.on("blur", () => {
            if (typeof clearTimeout !== "function") return;
            if (mainBlurTimer) clearTimeout(mainBlurTimer);
            mainBlurTimer = setTimeout(() => {
                if (typeof main.isFocused === "function" && main.isFocused()) return;
                if (typeof host.isFocused === "function" && host.isFocused()) return;
                if (lastFocused === "host") return;
                lastFocused = "other";
                mainHadFocus = false;
            }, 250);
        });
        main.on("minimize", () => {
            withSync(() => {
                if (isGone(host) || (typeof host.isMinimized === "function" && host.isMinimized())) return;
                if (typeof host.minimize === "function") host.minimize();
            });
        });
        main.on("restore", () => {
            withSync(() => {
                if (isGone(host)) return;
                if (typeof host.isMinimized === "function" && host.isMinimized() && typeof host.restore === "function") {
                    host.restore();
                }
                parkHostWindow(host);
            });
        });
    }

    function setHostSkipTaskbar(skip) {
        hostSkipTaskbar = !!skip;
        if (!isGone(host) && typeof host.setSkipTaskbar === "function") host.setSkipTaskbar(hostSkipTaskbar);
    }

    function showOnTaskbar() {
        if (isGone(host)) return;
        onTaskbar = true;
        setHostSkipTaskbar(false);
        parkHostWindow(host);
        if (typeof host.isMinimized === "function" && host.isMinimized() && typeof host.restore === "function") {
            host.restore();
        }
        parkHostWindow(host);
        if (typeof host.showInactive === "function") host.showInactive();
        else if (typeof host.show === "function") host.show();
        parkHostWindow(host);
    }

    function minimize() {
        if (isGone(host)) {
            if (!isGone(main) && typeof main.minimize === "function") main.minimize();
            return;
        }
        showOnTaskbar();
        if (typeof host.isMinimized === "function" && host.isMinimized()) return;
        if (typeof host.minimize === "function") host.minimize();
    }

    function reveal() {
        markRestored();
        showOnTaskbar();
        if (isGone(main)) return;
        if (typeof main.isMinimized === "function" && main.isMinimized() && typeof main.restore === "function") {
            main.restore();
        }
        if (typeof main.show === "function") main.show();
        if (typeof main.focus === "function") main.focus();
        mainHadFocus = true;
        lastFocused = "main";
    }

    function hideToTray() {
        withSync(() => {
            onTaskbar = false;
            mainHadFocus = false;
            lastFocused = "other";
            if (!isGone(main) && typeof main.hide === "function") main.hide();
            if (isGone(host)) return;
            setHostSkipTaskbar(true);
            if (typeof host.hide === "function") host.hide();
        });
    }

    function destroy() {
        quitting = true;
        if (!isGone(host) && typeof host.destroy === "function") host.destroy();
    }

    function inspect() {
        return {
            hostOnTaskbar: onTaskbar && !isGone(host) && (typeof host.isVisible !== "function" || host.isVisible() || (typeof host.isMinimized === "function" && host.isMinimized())),
            hostSkipTaskbar,
            hostMinimized: !isGone(host) && typeof host.isMinimized === "function" && host.isMinimized(),
            mainVisible: !isGone(main) && typeof main.isVisible === "function" && main.isVisible(),
            mainMinimized: !isGone(main) && typeof main.isMinimized === "function" && main.isMinimized(),
            mainSkipTaskbar: !isGone(main) && (main.skipTaskbar !== false),
        };
    }

    return {
        host,
        attachMain,
        present: showOnTaskbar,
        minimize,
        reveal,
        hideToTray,
        destroy,
        inspect,
        setQuitting(value) { quitting = !!value; },
    };
}

module.exports = {
    APP_USER_MODEL_ID,
    SURFACE_APP_USER_MODEL_ID,
    HOST_TITLE,
    MAIN_NATIVE_TITLE,
    applyAppUserModelId,
    applyHostTaskbarIdentity,
    applyMainTaskbarExclusion,
    createTaskbarHost,
    parkHostWindow,
};

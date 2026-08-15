const { Tray, Menu, nativeImage } = require("electron");
const { resolveAppIcon } = require("./app-icon");

function createAppTray({ onShow, onShowFloat, onQuit }) {
    const iconFile = resolveAppIcon();
    const image = nativeImage.createFromPath(iconFile);
    const tray = new Tray(image.isEmpty() ? iconFile : image);
    tray.setToolTip("Codex Account Manager");
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: "打开窗口", click: () => onShow() },
        { label: "打开桌面额度", click: () => onShowFloat && onShowFloat() },
        { type: "separator" },
        { label: "退出", click: () => onQuit() },
    ]));
    tray.on("click", () => onShow());
    return tray;
}

module.exports = { createAppTray };

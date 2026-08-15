const { app } = require("electron");
const fs = require("fs");
const path = require("path");

function resolveAppIcon() {
    const fromSource = path.join(__dirname, "..", "..", "resources", "icon.ico");
    const fromPack = path.join(process.resourcesPath, "icon.ico");
    if (app.isPackaged && fs.existsSync(fromPack)) return fromPack;
    return fromSource;
}

module.exports = { resolveAppIcon };

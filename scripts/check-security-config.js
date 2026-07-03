const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "src", "main", "main.js"), "utf8");
const ipcSource = fs.readFileSync(path.join(root, "src", "main", "ipc-handlers.js"), "utf8");
const rendererHtml = fs.readFileSync(path.join(root, "src", "renderer-react", "index.html"), "utf8");
const failures = [];

function requirePattern(source, pattern, message) {
    if (!pattern.test(source)) failures.push(message);
}

requirePattern(mainSource, /contextIsolation\s*:\s*true/, "Electron contextIsolation must stay enabled.");
requirePattern(mainSource, /nodeIntegration\s*:\s*false/, "Electron nodeIntegration must stay disabled.");
requirePattern(mainSource, /sandbox\s*:\s*true/, "Electron renderer sandbox must stay enabled.");
requirePattern(mainSource, /requestSingleInstanceLock\(\)/, "The application must prevent concurrent manager instances.");
requirePattern(mainSource, /app\.on\(["']second-instance["']/, "A second launch must focus the existing window.");
requirePattern(mainSource, /setWindowOpenHandler/, "New renderer windows must be intercepted.");
requirePattern(mainSource, /webContents\.on\(["']will-navigate["']\s*,\s*guardNavigation\)/, "Renderer navigation must use guardNavigation.");
requirePattern(mainSource, /webContents\.on\(["']will-redirect["']\s*,\s*guardNavigation\)/, "Renderer redirects must use guardNavigation.");
requirePattern(mainSource, /trustedWebContentsId\s*:\s*win\.webContents\.id/, "IPC handlers must be scoped to the main window webContents.");
requirePattern(ipcSource, /event\?\.sender\?\.id\s*===\s*trustedWebContentsId/, "IPC handlers must reject untrusted senders.");
requirePattern(ipcSource, /Untrusted IPC sender/, "Untrusted IPC requests must fail without running handlers.");

const navigationGuard = mainSource.match(/const guardNavigation\s*=\s*\([\s\S]*?\n\s*\};/u)?.[0] || "";
requirePattern(navigationGuard, /event\.preventDefault\(\)/, "guardNavigation must deny non-current navigation.");

const cspMeta = rendererHtml.match(/<meta(?=[^>]*http-equiv=["']Content-Security-Policy["'])[^>]*>/iu)?.[0] || "";
const csp = cspMeta.match(/content="([^"]+)"/iu)?.[1]
    || cspMeta.match(/content='([^']+)'/iu)?.[1]
    || "";
for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
]) {
    if (!csp.includes(directive)) failures.push(`Renderer CSP is missing: ${directive}`);
}

const rendererFiles = [];
function collectRendererSource(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) collectRendererSource(target);
        else if (/\.(?:css|html|ts|tsx)$/i.test(entry.name)) rendererFiles.push(target);
    }
}
collectRendererSource(path.join(root, "src", "renderer-react"));
for (const file of rendererFiles) {
    if (fs.readFileSync(file, "utf8").includes("images.unsplash.com")) {
        failures.push(`Runtime image host remains in ${path.relative(root, file)}.`);
    }
}

if (failures.length) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
}

console.log("Security configuration OK: sandbox, trusted IPC, navigation guard, CSP, and local renderer assets.");

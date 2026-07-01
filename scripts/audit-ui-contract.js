const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const rendererSource = read("src/renderer/app.js");
const reactDesktopSource = read("src/renderer-react/api/desktop.ts");
const preloadSource = read("src/preload/preload.js");
const mainSource = [
  "src/main/ipc-handlers.js",
  "src/main/main.js",
  "src/main/updater.js",
]
  .filter((file) => fs.existsSync(path.join(root, file)))
  .map(read)
  .join("\n");

const collect = (source, pattern, group = 1) => {
  const values = new Set();
  for (const match of source.matchAll(pattern)) values.add(match[group]);
  return values;
};

const rendererMethods = collect(rendererSource, /\bAPI(?:\?\.|\.)([A-Za-z_$][\w$]*)/g);
for (const method of collect(reactDesktopSource, /\bbridge\(\)\.([A-Za-z_$][\w$]*)/g)) rendererMethods.add(method);
for (const method of collect(reactDesktopSource, /\bapi\.([A-Za-z_$][\w$]*)/g)) rendererMethods.add(method);
const mainHandlers = collect(mainSource, /ipcMain\.handle\(["']([^"']+)["']/g);
const mainEvents = collect(mainSource, /webContents\.send\(["']([^"']+)["']/g);
const invokedChannels = new Set();
const subscribedChannels = new Set();
let exposedApi = null;

const electronMock = {
  contextBridge: {
    exposeInMainWorld(name, api) {
      if (name === "codexDeskep") exposedApi = api;
    },
  },
  ipcRenderer: {
    invoke(channel) {
      invokedChannels.add(channel);
      return Promise.resolve({ success: true, data: null });
    },
    on(channel) {
      subscribedChannels.add(channel);
    },
    removeListener() {},
  },
};

const wrapper = vm.runInNewContext(
  `(function(require, module, exports, __filename, __dirname) {${preloadSource}\n})`,
  {},
  { filename: "preload.js" },
);
const preloadModule = { exports: {} };
wrapper(
  (request) => {
    if (request === "electron") return electronMock;
    throw new Error(`Unexpected preload dependency: ${request}`);
  },
  preloadModule,
  preloadModule.exports,
  path.join(root, "src/preload/preload.js"),
  path.join(root, "src/preload"),
);

if (!exposedApi) throw new Error("preload did not expose window.codexDeskep");

for (const [name, method] of Object.entries(exposedApi)) {
  if (typeof method !== "function") continue;
  if (name.startsWith("on")) method(() => {});
  else method("__audit__", false);
}

const errors = [];
for (const method of rendererMethods) {
  if (typeof exposedApi[method] !== "function") errors.push(`Renderer method missing from preload: ${method}`);
}
for (const channel of invokedChannels) {
  if (!mainHandlers.has(channel)) errors.push(`Preload invoke missing IPC handler: ${channel}`);
}
for (const channel of subscribedChannels) {
  if (!mainEvents.has(channel)) errors.push(`Preload event has no main-process sender: ${channel}`);
}

const auxiliaryMethods = new Set(["getAccount", "getTokenStatus"]);
const unusedMethods = Object.keys(exposedApi).filter((name) => !rendererMethods.has(name) && !auxiliaryMethods.has(name));
if (unusedMethods.length) errors.push(`Exposed methods unused by active UI: ${unusedMethods.join(", ")}`);

for (const fakeName of ["getTheme", "setTheme", "onMenuAction"]) {
  if (fakeName in exposedApi) errors.push(`Removed fake interface is still exposed: ${fakeName}`);
}
for (const fakeChannel of ["theme:get", "theme:set"]) {
  if (mainHandlers.has(fakeChannel)) errors.push(`Removed fake IPC handler still exists: ${fakeChannel}`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`UI contract OK: ${rendererMethods.size} renderer methods, ${invokedChannels.size} invoke channels, ${subscribedChannels.size} event channels.`);
}

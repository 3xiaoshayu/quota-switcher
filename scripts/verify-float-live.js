const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const cdpHost = process.env.README_CDP_URL || "http://127.0.0.1:9222";
const outDir = path.resolve(__dirname, "..", "tmp-verify");
const shotPath = path.join(outDir, "float-window.png");
const infoPath = path.join(outDir, "float-window.json");

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${cdpHost}${urlPath}`, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result || {});
    }
  });
  return {
    async send(method, params) {
      await ready;
      const id = nextId;
      nextId += 1;
      const result = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      ws.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      ws.close();
    },
  };
}

function isMainTarget(target) {
  const url = String(target.url || "");
  return target.type === "page" && url.includes("renderer-dist") && !url.includes("#float");
}

function isFloatTarget(target) {
  const url = String(target.url || "");
  return target.type === "page" && url.includes("#float");
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const targets = await getJson("/json/list");
  const mainTarget = targets.find(isMainTarget);
  if (!mainTarget?.webSocketDebuggerUrl) {
    throw new Error(`main window not found: ${JSON.stringify(targets.map((item) => ({ type: item.type, url: item.url })))}`);
  }

  const mainSession = cdpSession(mainTarget.webSocketDebuggerUrl);
  await mainSession.send("Runtime.enable");
  await mainSession.send("Runtime.evaluate", {
    expression: `document.querySelector('#sidebar-nav-settings')?.click(); !!document.querySelector('#sidebar-nav-settings')`,
    returnByValue: true,
  });
  await sleep(500);
  const click = await mainSession.send("Runtime.evaluate", {
    expression: `(() => {
      const button = document.querySelector('#btn-show-float-lens');
      if (!button) return { ok: false, reason: 'missing-open-button' };
      button.click();
      return { ok: true, href: location.href };
    })()`,
    returnByValue: true,
  });
  mainSession.close();
  if (!click.result?.value?.ok) {
    throw new Error(`failed to click open: ${JSON.stringify(click)}`);
  }

  let floatTarget = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(300);
    const next = await getJson("/json/list");
    floatTarget = next.find(isFloatTarget);
    if (floatTarget?.webSocketDebuggerUrl) break;
  }
  if (!floatTarget?.webSocketDebuggerUrl) {
    const latest = await getJson("/json/list");
    throw new Error(`float window not found: ${JSON.stringify(latest.map((item) => ({ type: item.type, url: item.url })))}`);
  }

  const floatSession = cdpSession(floatTarget.webSocketDebuggerUrl);
  await floatSession.send("Runtime.enable");
  await floatSession.send("Page.enable");
  const probe = await floatSession.send("Runtime.evaluate", {
    expression: `({
      hash: location.hash,
      crashed: !!document.querySelector('#root') && !document.querySelector('.float-lens-shell'),
      shell: !!document.querySelector('.float-lens-shell'),
      text: (document.querySelector('.float-lens-shell')?.innerText || '').slice(0, 200),
    })`,
    returnByValue: true,
  });
  const shot = await floatSession.send("Page.captureScreenshot", { format: "png" });
  floatSession.close();

  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  fs.writeFileSync(infoPath, JSON.stringify({
    url: floatTarget.url,
    probe: probe.result?.value || probe,
    shot: shotPath,
  }, null, 2));
  console.log(JSON.stringify({
    url: floatTarget.url,
    probe: probe.result?.value || probe,
    shot: shotPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

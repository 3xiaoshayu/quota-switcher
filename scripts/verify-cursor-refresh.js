const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const CDP = "http://127.0.0.1:9355";
const outDir = path.join(process.env.TEMP || ".", "cam-cursor-verify");

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    }).on("error", reject);
  });
}

async function main() {
  const targets = await getJson(`${CDP}/json/list`);
  const page = targets.find((item) => item.type === "page" && !String(item.url || "").includes("#float"));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let id = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => {
    const current = id++;
    ws.send(JSON.stringify({ id: current, method, params }));
    return new Promise((resolve, reject) => pending.set(current, { resolve, reject }));
  };
  const evalExpr = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "eval failed");
    return result.result?.value;
  };

  await send("Page.enable");
  await evalExpr(`document.querySelector('#sidebar-product-cursor')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await evalExpr(`document.querySelector('#sidebar-nav-accounts')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const before = await evalExpr(`document.querySelector('[id^="action-refresh-"]:not([id^="action-reauth-"])')?.id || ''`);
  console.log("refresh-button", before);
  await evalExpr(`document.querySelector('[id^="action-refresh-"]:not([id^="action-reauth-"])')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const after = await evalExpr(`({
    card: document.querySelector('[id^="account-manage-card-"]')?.innerText || '',
    toast: [...document.querySelectorAll('[id^="toast-"]')].map((el) => el.innerText).slice(-3)
  })`);
  console.log(JSON.stringify(after, null, 2));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, "06-after-refresh.png"), Buffer.from(shot.data, "base64"));
  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

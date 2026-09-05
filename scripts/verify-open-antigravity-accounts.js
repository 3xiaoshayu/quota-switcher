const http = require("node:http");

const CDP = process.env.VERIFY_CDP_URL || "http://127.0.0.1:9355";

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

(async () => {
  const targets = await getJson(`${CDP}/json/list`);
  const page = targets.find((item) => item.type === "page" && !String(item.url || "").includes("#float"));
  if (!page) throw new Error("main page not found");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = 1;
    ws.send(JSON.stringify({ id, method, params }));
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    ws.addEventListener("message", onMessage);
  });
  await send("Runtime.evaluate", {
    expression: `document.querySelector("#sidebar-product-antigravity")?.click(); document.querySelector("#sidebar-nav-accounts")?.click();`,
  });
  ws.close();
  console.log("opened Antigravity accounts");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

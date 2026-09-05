const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const CDP = process.env.VERIFY_CDP_URL || "http://127.0.0.1:9355";
const outDir = path.join(process.env.TEMP || ".", "cam-antigravity-verify");

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

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", reject);
      this.ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || "CDP error"));
        else waiter.resolve(message.result);
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "evaluate failed");
    }
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function waitForMainPage(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const targets = await getJson(`${CDP}/json/list`);
      const page = targets.find((item) => item.type === "page" && !String(item.url || "").includes("#float"));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("main page not found");
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const page = await waitForMainPage();
  const client = new Cdp(page.webSocketDebuggerUrl);
  await client.ready();
  await client.send("Page.enable");

  const shot = async (name) => {
    const result = await client.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(outDir, name);
    fs.writeFileSync(file, Buffer.from(result.data, "base64"));
    console.log(`wrote ${file}`);
  };

  await client.eval(`document.querySelector("#sidebar-product-antigravity")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await client.eval(`document.querySelector("#sidebar-nav-accounts")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const accounts = await client.eval(`({
    product: document.querySelector("#sidebar-product-antigravity")?.innerText || "",
    autoswitch: !!document.querySelector("#sidebar-nav-autoswitch"),
    empty: document.querySelector("#accounts-empty-state")?.innerText || "",
    cards: document.querySelectorAll('[id^="account-manage-card-"]').length,
    header: document.querySelector("#header-current-email")?.innerText || "",
    hasBan: document.body.innerText.includes("已封号"),
    bars: [...document.querySelectorAll('[id^="quota-box-"]')].slice(0, 8).map((el) => (el.innerText || "").replace(/\\s+/g, " ").trim()),
  })`);
  console.log("antigravity-accounts", JSON.stringify(accounts, null, 2));
  await shot("01-antigravity-accounts.png");

  await client.eval(`document.querySelector("#btn-add-account-modal-trigger")?.click() || document.querySelector("#accounts-empty-add")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const modal = await client.eval(`({
    open: !!document.querySelector("#add-account-modal"),
    text: document.querySelector("#add-account-modal")?.innerText || "",
    importBtn: document.querySelector("#btn-import-local-account")?.innerText || "",
    callback: !!document.querySelector("#oauth-manual-callback-input"),
  })`);
  console.log("add-modal", JSON.stringify(modal, null, 2));
  await shot("02-antigravity-add-modal.png");
  await client.eval(`document.querySelector("#btn-close-modal")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 250));

  await client.eval(`document.querySelector("#sidebar-nav-quotas")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const quotas = await client.eval(`({
    title: document.querySelector("#quotas-view-container h2")?.innerText || document.body.innerText.slice(0, 80),
    empty: document.querySelector("#quotas-empty-state")?.innerText || "",
    hasBan: document.body.innerText.includes("已封号"),
    bars: [...document.querySelectorAll('[id^="quota-"]')].slice(0, 12).map((el) => (el.innerText || el.id || "").replace(/\\s+/g, " ").trim()),
  })`);
  console.log("antigravity-quotas", JSON.stringify(quotas, null, 2));
  await shot("03-antigravity-quotas.png");

  await client.eval(`document.querySelector("#sidebar-nav-settings")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const settings = await client.eval(`({
    chips: document.querySelector("#daemon-product-chips")?.innerText || "",
    client: document.querySelector("#card-client-detect")?.innerText || "",
    tokens: document.querySelector("#card-tokens")?.innerText || "",
    float: !!document.querySelector("#btn-show-float-lens"),
  })`);
  console.log("settings", JSON.stringify(settings, null, 2));
  await shot("04-antigravity-settings.png");

  if (settings.float) {
    await client.eval(`document.querySelector("#btn-show-float-lens")?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  client.close();

  const targets = await getJson(`${CDP}/json/list`);
  const floatPage = targets.find((item) => item.type === "page" && String(item.url || "").includes("#float"));
  if (floatPage?.webSocketDebuggerUrl) {
    const floatClient = new Cdp(floatPage.webSocketDebuggerUrl);
    await floatClient.ready();
    await floatClient.send("Page.enable");
    const floatInfo = await floatClient.eval(`({
      mark: document.querySelector("#float-product-mark")?.innerText || document.body.innerText.slice(0, 120),
      hasBan: document.body.innerText.includes("已封号"),
      text: document.body.innerText.slice(0, 240),
    })`);
    console.log("float", JSON.stringify(floatInfo, null, 2));
    const shotResult = await floatClient.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(outDir, "05-antigravity-float.png");
    fs.writeFileSync(file, Buffer.from(shotResult.data, "base64"));
    console.log(`wrote ${file}`);
    floatClient.close();
  } else {
    console.log("float page not found");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

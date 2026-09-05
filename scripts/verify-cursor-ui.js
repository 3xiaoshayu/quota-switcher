const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const CDP = process.env.VERIFY_CDP_URL || "http://127.0.0.1:9355";
const outDir = path.join(process.env.TEMP || ".", "cam-cursor-verify");

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

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const targets = await getJson(`${CDP}/json/list`);
  const page = targets.find((item) => item.type === "page" && !String(item.url || "").includes("#float"));
  if (!page) throw new Error("main page not found");
  const client = new Cdp(page.webSocketDebuggerUrl);
  await client.ready();
  await client.send("Page.enable");

  const shot = async (name) => {
    const result = await client.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(outDir, name);
    fs.writeFileSync(file, Buffer.from(result.data, "base64"));
    console.log(`wrote ${file}`);
  };

  const info = await client.eval(`({
    productCodex: !!document.querySelector('#sidebar-product-codex'),
    productCursor: !!document.querySelector('#sidebar-product-cursor'),
    autoswitch: !!document.querySelector('#sidebar-nav-autoswitch'),
    title: document.title,
    body: document.body.innerText.slice(0, 400)
  })`);
  console.log("codex-tab", JSON.stringify(info, null, 2));
  await shot("01-codex-current.png");

  await client.eval(`document.querySelector("#sidebar-product-codex")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await client.eval(`document.querySelector("#sidebar-nav-accounts")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const badges = await client.eval(`(() => {
    const nav = document.querySelector("#sidebar-nav-accounts");
    const count = document.querySelector("#filter-handling-count");
    const box = count?.getBoundingClientRect();
    return {
      sidebarText: (nav?.innerText || "").replace(/\\s+/g, " ").trim(),
      filterCount: count?.innerText || "",
      width: box ? Math.round(box.width * 10) / 10 : 0,
      height: box ? Math.round(box.height * 10) / 10 : 0,
    };
  })()`);
  console.log("handling-badges", JSON.stringify(badges, null, 2));
  await shot("01b-codex-accounts-badges.png");

  await client.eval(`document.querySelector('#sidebar-product-cursor')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await client.eval(`document.querySelector('#sidebar-nav-accounts')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const cursorInfo = await client.eval(`({
    autoswitch: !!document.querySelector('#sidebar-nav-autoswitch'),
    empty: !!document.querySelector('#accounts-empty-state'),
    emptyText: document.querySelector('#accounts-empty-state')?.innerText || '',
    addBtn: !!document.querySelector('#btn-add-account-modal-trigger'),
    cards: document.querySelectorAll('[id^="account-manage-card-"]').length,
    header: document.querySelector('#header-current-email')?.innerText || '',
    productActive: document.querySelector('#sidebar-product-cursor')?.className || ''
  })`);
  console.log("cursor-accounts", JSON.stringify(cursorInfo, null, 2));
  await shot("02-cursor-accounts.png");

  const cardAudit = await client.eval(`(() => {
    const cards = [...document.querySelectorAll('[id^="account-manage-card-"]')];
    return cards.slice(0, 3).map((card) => ({
      status: card.querySelector('[id^="account-m-badges-"]')?.innerText || '',
      bars: [...card.querySelectorAll('[id^="quota-box-"]')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim()),
      text: card.innerText,
      hasBan: card.innerText.includes('已封号'),
      hasLimited: card.innerText.includes('额度限流'),
      decimals: (card.innerText.match(/\\d+\\.\\d+%/) || []).length,
    }));
  })()`);
  console.log("cursor-cards", JSON.stringify(cardAudit, null, 2));

  const tokenBars = await client.eval(`(() => {
    const rows = [...document.querySelectorAll('[id^="token-validity-row-"]')];
    return rows.map((row) => {
      const fill = row.querySelector('[id^="token-validity-fill-"]');
      return {
        text: (row.innerText || "").replace(/\\s+/g, " ").trim(),
        hasFill: !!fill,
        width: fill?.style?.width || "",
      };
    });
  })()`);
  console.log("cursor-token-bars", JSON.stringify(tokenBars, null, 2));

  await client.eval(`document.querySelector('#filter-tab-all')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const currentAudit = await client.eval(`({
    header: document.querySelector('#header-current-email')?.innerText || '',
    subtitle: document.querySelector('#accounts-view-container h2')?.parentElement?.innerText || document.body.innerText.slice(0, 180),
    currentBadges: [...document.querySelectorAll('#current-account-badge')].map((el) => el.innerText),
    currentButtons: [...document.querySelectorAll('[id^="action-current-"]')].map((el) => el.innerText)
  })`);
  console.log("cursor-current", JSON.stringify(currentAudit, null, 2));
  await client.eval(`document.querySelector('#filter-tab-current')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const currentFilter = await client.eval(`({
    empty: document.querySelector('#accounts-empty-state')?.innerText || '',
    cards: document.querySelectorAll('[id^="account-manage-card-"]').length,
    badge: document.querySelector('#current-account-badge')?.innerText || ''
  })`);
  console.log("cursor-current-filter", JSON.stringify(currentFilter, null, 2));
  await shot("02b-cursor-current-filter.png");
  await client.eval(`document.querySelector('#filter-tab-all')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  await client.eval(`document.querySelector('#btn-add-account-modal-trigger')?.click() || document.querySelector('#accounts-empty-add')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const modal = await client.eval(`({
    open: !!document.querySelector('#add-account-modal'),
    text: document.querySelector('#add-account-modal')?.innerText || '',
    importBtn: !!document.querySelector('#btn-import-local-account'),
    callback: !!document.querySelector('#oauth-manual-callback-input')
  })`);
  console.log("add-modal", JSON.stringify(modal, null, 2));
  await shot("03-cursor-add-modal.png");
  await client.eval(`document.querySelector('#btn-close-modal')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await shot("03b-cursor-accounts.png");

  await client.eval(`document.querySelector('#sidebar-nav-quotas')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const quotas = await client.eval(`({
    empty: document.querySelector('#quotas-empty-state')?.innerText || '',
    bars: [...document.querySelectorAll('[id^="quota-"]')].slice(0, 12).map((el) => el.innerText || el.id)
  })`);
  console.log("cursor-quotas", JSON.stringify(quotas, null, 2));
  await shot("04-cursor-quotas.png");

  await client.eval(`document.querySelector('#sidebar-nav-settings')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const settings = await client.eval(`({
    client: document.querySelector('#card-client-detect')?.innerText || '',
    tokens: document.querySelector('#card-tokens')?.innerText || '',
    footer: document.querySelector('#settings-view-container')?.innerText.slice(-120) || document.body.innerText.slice(-120)
  })`);
  console.log("settings", JSON.stringify(settings, null, 2));
  await shot("05-settings.png");

  await client.eval(`document.querySelector('#sidebar-nav-accounts')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await client.eval(`document.querySelector('[id^="action-switch-"]')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const switchModal = await client.eval(`({
    open: !!document.querySelector('#cursor-switch-confirm-modal'),
    text: document.querySelector('#cursor-switch-confirm-modal')?.innerText || '',
    accept: !!document.querySelector('#cursor-switch-confirm-accept')
  })`);
  console.log("switch-confirm", JSON.stringify(switchModal, null, 2));
  await shot("07-cursor-switch-confirm.png");
  await client.eval(`document.querySelector('#cursor-switch-confirm-cancel')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 250));

  await client.eval(`document.querySelector('#sidebar-product-codex')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await client.eval(`document.querySelector('#sidebar-nav-accounts')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const codex = await client.eval(`({
    autoswitch: !!document.querySelector('#sidebar-nav-autoswitch'),
    cards: document.querySelectorAll('[id^="account-manage-card-"]').length,
    fiveHour: document.querySelectorAll('[id^="quota-box-fiveHour-"]').length,
    plan: document.querySelectorAll('[id^="quota-box-plan-"]').length
  })`);
  console.log("codex-tab", JSON.stringify(codex, null, 2));
  await shot("08-codex-accounts.png");

  await client.eval(`document.querySelector('#btn-add-account-modal-trigger')?.click() || document.querySelector('#accounts-empty-add')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const codexModal = await client.eval(`({
    open: !!document.querySelector('#add-account-modal'),
    text: document.querySelector('#add-account-modal')?.innerText || '',
    importBtn: document.querySelector('#btn-import-local-account')?.innerText || '',
    callback: !!document.querySelector('#oauth-manual-callback-input')
  })`);
  console.log("codex-add-modal", JSON.stringify(codexModal, null, 2));
  await shot("09-codex-add-modal.png");
  await client.eval(`document.querySelector('#btn-close-modal')?.click()`);

  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const drift = require("../engine/upstream-drift");
const { OAUTH_ITEM_KEY } = require("../engine/antigravity-db");
const { encodeItemTableValue, encodeOauthTokenTopic } = require("../engine/antigravity-proto");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-switcher-drift-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeVscdb(dbPath, rows, { withTable = true } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    if (withTable) {
      db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
      const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
      for (const [key, value] of Object.entries(rows)) insert.run(key, value);
    } else {
      db.exec("CREATE TABLE Something (id INTEGER)");
    }
  } finally {
    db.close();
  }
}

test("cursor key classification: known login, renamed keys, signed out", () => {
  assert.equal(drift.classifyCursorKeys(["cursorAuth/accessToken", "cursorAuth/cachedEmail", "other"]).status, "ok");
  assert.equal(drift.classifyCursorKeys(["workbench.panel", "storage.x"]).status, "signed_out");
  const renamed = drift.classifyCursorKeys(["cursorAuth/sessionToken", "cursorAuth/cachedEmail2", "workbench.panel"]);
  assert.equal(renamed.status, "drift");
  assert.match(renamed.detail, /登录键名变了/);
  assert.deepEqual(renamed.sample, ["cursorAuth/sessionToken", "cursorAuth/cachedEmail2"]);
  assert.equal(drift.classifyCursorKeys(null).status, "drift");
  // Known keys without the access token are a plain sign-out, not drift.
  assert.equal(drift.classifyCursorKeys(["cursorAuth/cachedEmail", "cursorAuth/cachedTeam"]).status, "signed_out");
});

test("antigravity item classification: decodable token, undecodable blob, renamed key", () => {
  assert.equal(drift.classifyAntigravityItem([OAUTH_ITEM_KEY], { access_token: "ya29.x", refresh_token: "1//y" }).status, "ok");
  assert.equal(drift.classifyAntigravityItem([OAUTH_ITEM_KEY], null).status, "drift");
  assert.equal(drift.classifyAntigravityItem([OAUTH_ITEM_KEY], {}).status, "drift");
  const renamed = drift.classifyAntigravityItem(["antigravityUnifiedStateSync.session", "workbench.x"], undefined);
  assert.equal(renamed.status, "drift");
  assert.match(renamed.detail, /antigravityUnifiedStateSync\.session/);
  assert.equal(drift.classifyAntigravityItem(["workbench.x"], undefined).status, "signed_out");
  assert.equal(drift.classifyAntigravityItem(null, undefined).status, "drift");
});

test("codex auth.json classification: tokens, agent identity, api key, unknown shape", () => {
  assert.equal(drift.classifyCodexAuthValue(null).status, "signed_out");
  assert.equal(drift.classifyCodexAuthValue({ tokens: { access_token: "a", refresh_token: "r" } }).status, "ok");
  assert.equal(drift.classifyCodexAuthValue({ tokens: { id_token: "i" } }).status, "ok");
  assert.equal(drift.classifyCodexAuthValue({ agent_identity: { email: "a@b" } }).status, "unsupported");
  assert.equal(drift.classifyCodexAuthValue({ OPENAI_API_KEY: "sk-x" }).status, "unsupported");
  assert.equal(drift.classifyCodexAuthValue({ auth_mode: "apikey" }).status, "unsupported");
  assert.equal(drift.classifyCodexAuthValue({}).status, "signed_out");
  assert.equal(drift.classifyCodexAuthValue({ tokens: {} }).status, "signed_out");
  const unknown = drift.classifyCodexAuthValue({ credentials: { bearer: "x" }, schema: 2 });
  assert.equal(unknown.status, "drift");
  assert.match(unknown.detail, /credentials, schema/);
  assert.equal(drift.classifyCodexAuthValue(["nope"]).status, "drift");
});

test("cursor and antigravity readers inspect a real state.vscdb without writing to it", async (t) => {
  const dir = tempDir(t);

  const cursorOk = path.join(dir, "cursor-ok.vscdb");
  writeVscdb(cursorOk, { "cursorAuth/accessToken": "tok", "cursorAuth/cachedEmail": "a@b.com" });
  assert.equal((await drift.inspectCursorFormat(cursorOk)).status, "ok");

  const cursorRenamed = path.join(dir, "cursor-renamed.vscdb");
  writeVscdb(cursorRenamed, { "cursorAuth/sessionToken": "tok" });
  const before = fs.statSync(cursorRenamed).mtimeMs;
  const renamed = await drift.inspectCursorFormat(cursorRenamed);
  assert.equal(renamed.status, "drift");
  assert.equal(fs.statSync(cursorRenamed).mtimeMs, before, "read-only inspection");

  const noTable = path.join(dir, "cursor-notable.vscdb");
  writeVscdb(noTable, {}, { withTable: false });
  assert.equal((await drift.inspectCursorFormat(noTable)).status, "drift");

  assert.equal((await drift.inspectCursorFormat(path.join(dir, "missing.vscdb"))).status, "signed_out");
  assert.equal((await drift.inspectCursorFormat(null)).status, "signed_out");

  const antigravityOk = path.join(dir, "antigravity-ok.vscdb");
  const topic = encodeOauthTokenTopic({
    access_token: "ya29.ok",
    refresh_token: "1//ok",
    token_type: "Bearer",
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
  }, null);
  writeVscdb(antigravityOk, { [OAUTH_ITEM_KEY]: encodeItemTableValue(topic) });
  assert.equal((await drift.inspectAntigravityFormat(antigravityOk)).status, "ok");

  const antigravityGarbage = path.join(dir, "antigravity-garbage.vscdb");
  writeVscdb(antigravityGarbage, { [OAUTH_ITEM_KEY]: Buffer.from("not a protobuf topic at all") });
  const garbage = await drift.inspectAntigravityFormat(antigravityGarbage);
  assert.equal(garbage.status, "drift");
  assert.match(garbage.detail, /编码变了/);

  const antigravitySignedOut = path.join(dir, "antigravity-out.vscdb");
  writeVscdb(antigravitySignedOut, { "workbench.panel": "x" });
  assert.equal((await drift.inspectAntigravityFormat(antigravitySignedOut)).status, "signed_out");
});

test("codex reader tolerates missing and malformed auth.json", (t) => {
  const dir = tempDir(t);
  assert.equal(drift.inspectCodexFormat(path.join(dir, "auth.json")).status, "signed_out");

  const good = path.join(dir, "good.json");
  fs.writeFileSync(good, JSON.stringify({ tokens: { access_token: "a" } }));
  assert.equal(drift.inspectCodexFormat(good).status, "ok");

  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{ not json");
  const brokenResult = drift.inspectCodexFormat(broken);
  assert.ok(["drift", "signed_out", "unknown"].includes(brokenResult.status));
  assert.notEqual(brokenResult.status, "ok");

  const foreign = path.join(dir, "foreign.json");
  fs.writeFileSync(foreign, JSON.stringify({ session: { bearer: "x" } }));
  assert.equal(drift.inspectCodexFormat(foreign).status, "drift");
});

test("status IPC carries the official-format verdict and warns once", async () => {
  const handlers = new Map();
  const electron = {
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
    BrowserWindow: { getAllWindows: () => [] },
    app: { getVersion: () => "0.0.0-test", isPackaged: false },
    shell: { async openExternal() {}, async openPath() { return ""; } },
  };
  let inspected = 0;
  const engine = {
    getCursorInstallationStatusAsync: async () => ({ installed: true, vscdbPath: "C:/fake/state.vscdb", vscdbPresent: true }),
    inspectCursorFormat: async (dbPath) => {
      inspected += 1;
      assert.equal(dbPath, "C:/fake/state.vscdb");
      return { status: "drift", detail: "renamed", sample: ["cursorAuth/sessionToken"] };
    },
    getCodexInstallationStatus: () => ({ installed: false }),
    inspectCodexFormat: () => { throw new Error("boom"); },
    getAntigravityInstallationStatus: () => ({ installed: false, vscdbPath: null }),
  };
  delete require.cache[require.resolve("../src/main/ipc-handlers")];
  const { registerIpcHandlers } = require("../src/main/ipc-handlers");
  registerIpcHandlers(engine, { electron, setInterval: () => 0, clearInterval: () => {} });

  const cursor = await handlers.get("cursor:status")({ sender: { id: 1 } });
  assert.equal(cursor.success, true);
  assert.equal(cursor.data.installed, true);
  assert.deepEqual(cursor.data.officialFormat, { status: "drift", detail: "renamed", sample: ["cursorAuth/sessionToken"] });
  await handlers.get("cursor:status")({ sender: { id: 1 } });
  assert.equal(inspected, 2, "an explicit status call (重新检测) always re-inspects; only the log is deduplicated");

  const codex = await handlers.get("codex:status")({ sender: { id: 1 } });
  assert.equal(codex.success, true);
  assert.equal(codex.data.officialFormat.status, "unknown", "an inspector crash is unknown, never drift");

  const antigravity = await handlers.get("antigravity:status")({ sender: { id: 1 } });
  assert.equal(antigravity.success, true);
  assert.equal(antigravity.data.officialFormat, undefined, "no inspector, no verdict");
});

test("the desktop snapshot carries the same verdict and reuses it for a minute", () => {
  // The snapshot is what the window actually renders on first paint and on
  // every daemon-tick reload; without this the drift line would only appear
  // after a manual 重新检测.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main", "ipc-handlers.js"), "utf8");
  assert.match(source, /const FORMAT_VERDICT_TTL_MS = 60 \* 1000;/);
  assert.match(source, /if \(cached && remembered && Date\.now\(\) - remembered\.at < FORMAT_VERDICT_TTL_MS\)/);
  assert.match(source, /withOfficialFormat\("codex", rawCodexStatus, eng\.inspectCodexFormat, \{ cached: true \}\)/);
  assert.match(source, /withOfficialFormat\("cursor", rawCursorStatus, cursorFormatInspector\(rawCursorStatus\), \{ cached: true \}\)/);
  assert.match(source, /withOfficialFormat\("antigravity", rawAntigravityStatus, antigravityFormatInspector\(rawAntigravityStatus\), \{ cached: true \}\)/);
});

test("settings and the top banner show drift with the main-process reason and a releases link", () => {
  const settings = fs.readFileSync(path.join(__dirname, "..", "src", "renderer-react", "components", "SettingsView.tsx"), "utf8");
  assert.match(settings, /settings\.formatDrift\?\.\[item\.id\]/);
  assert.match(settings, /登录格式变了，切号和同步可能失效，请更新软件/);
  assert.match(settings, /id=\{`client-format-drift-\$\{item\.id\}`\}/);
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "renderer-react", "App.tsx"), "utf8");
  assert.match(app, /const formatDrift = formatDriftFrom\(\{ codex: codexStatus, cursor: cursorStatus, antigravity: antigravityStatus \}\)/);
  assert.match(app, /settings=\{\{ \.\.\.settings, formatDrift \}\}/);
  assert.match(app, /<FormatDriftBanner[\s\S]{0,200}onOpenReleases=\{\(\) => void handleOpenExternal\(`\$\{appInfo\?\.repository \|\| APP_GITHUB_URL\}\/releases`\)\}/);
  assert.match(app, /onDismiss=\{\(\) => setFormatDriftDismissedKey\(formatDriftKey\)\}/);
  const banner = fs.readFileSync(path.join(__dirname, "..", "src", "renderer-react", "components", "FormatDriftBanner.tsx"), "utf8");
  assert.match(banner, /if \(!products\.length\) return null/);
  assert.match(banner, /的登录格式变了/);
  assert.match(banner, /查看新版本/);
  assert.match(banner, /id="format-drift-dismiss"/);
});

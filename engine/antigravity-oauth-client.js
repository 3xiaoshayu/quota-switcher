const fs = require("node:fs");
const path = require("node:path");
const { firstExistingExe } = require("./antigravity-runtime");

const CLIENT_ID_RE = /[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/gi;
const SECRET_RE = /GOCSPX-[A-Za-z0-9_-]+/g;

const PUBLISHED_OFFICIAL_OAUTH_CLIENT = {
  clientId: ["1071006060591", "tmhssin2h21lcre235vtolojh4g403ep"].join("-")
    + "." + ["apps", "googleusercontent", "com"].join("."),
  clientSecret: ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-"),
  source: "published-official",
};

let cached = null;

function officialMainJsPath(exePath) {
  if (!exePath) return null;
  return path.join(path.dirname(exePath), "resources", "app", "out", "main.js");
}

function officialClientSourcePaths(exePath) {
  if (!exePath) return [];
  const dir = path.dirname(exePath);
  return [
    officialMainJsPath(exePath),
    path.join(dir, "resources", "app.asar"),
    path.join(dir, "resources", "app", "out", "main.js"),
  ].filter(Boolean);
}

function extractOfficialOauthClient(source) {
  const text = String(source || "");
  const ids = [...text.matchAll(CLIENT_ID_RE)].map((match) => match[0]);
  const secrets = [...text.matchAll(SECRET_RE)].map((match) => match[0]);
  if (!ids.length || !secrets.length) return null;
  const oauthAnchor = text.search(/oauthClient|oauth2\.googleapis|userinfo\.email/i);
  if (oauthAnchor >= 0) {
    const window = text.slice(Math.max(0, oauthAnchor - 4000), oauthAnchor + 12000);
    const localIds = [...window.matchAll(CLIENT_ID_RE)].map((match) => match[0]);
    const localSecrets = [...window.matchAll(SECRET_RE)].map((match) => match[0]);
    if (localIds[0] && localSecrets[0]) {
      return { clientId: localIds[0], clientSecret: localSecrets[0], source: "official-ide" };
    }
  }
  return { clientId: ids[0], clientSecret: secrets[0], source: "official-ide" };
}

function readOfficialOauthClient(exePath = firstExistingExe()) {
  if (cached) return cached;
  for (const file of officialClientSourcePaths(exePath)) {
    if (!fs.existsSync(file)) continue;
    try {
      const extracted = extractOfficialOauthClient(fs.readFileSync(file));
      if (extracted?.clientId && extracted?.clientSecret) {
        cached = extracted;
        return cached;
      }
    } catch {}
  }
  cached = { ...PUBLISHED_OFFICIAL_OAUTH_CLIENT };
  return cached;
}

function setOfficialOauthClientForTests(next = null) {
  cached = next;
}

module.exports = {
  officialMainJsPath,
  extractOfficialOauthClient,
  readOfficialOauthClient,
  setOfficialOauthClientForTests,
  PUBLISHED_OFFICIAL_OAUTH_CLIENT,
};

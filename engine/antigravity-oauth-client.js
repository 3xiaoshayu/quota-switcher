const path = require("node:path");
const { firstExistingExe } = require("./antigravity-runtime");
const { readFileWithRetry } = require("./atomic-file");

const CLIENT_ID_RE = /[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/gi;
// Hub binaries concatenate two GOCSPX values. Stop before the next GOCSPX-
// so the first secret is not swallowed into the second.
const SECRET_RE = /GOCSPX-(?:(?!GOCSPX-|https?:|[0-9]{6,}-)[A-Za-z0-9_-]){8,40}/g;
const ANCHOR_RE = /\[AuthProvider\]|oauthClient|userinfo\.email|oauth2\.googleapis|auth\.cloud\.google\/authorize/gi;

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
    path.join(dir, "resources", "bin", "language_server.exe"),
  ].filter(Boolean);
}

function collectMatches(text, regex) {
  return [...text.matchAll(regex)].map((match) => ({
    value: match[0],
    index: match.index,
  }));
}

function nearestMatch(items, targetIndex, options = {}) {
  if (!items.length) return null;
  const candidates = options.before === true
    ? items.filter((item) => item.index < targetIndex)
    : items;
  const pool = candidates.length ? candidates : items;
  return pool.reduce((best, item) => (
    Math.abs(item.index - targetIndex) < Math.abs(best.index - targetIndex) ? item : best
  ));
}

function pickAnchorIndex(text, ids) {
  let adjacent = -1;
  let searchFrom = 0;
  while (true) {
    const pos = text.indexOf("[AuthProvider]", searchFrom);
    if (pos < 0) break;
    for (const id of ids) {
      const end = id.index + id.value.length;
      if (end <= pos && pos - end <= 16) adjacent = pos;
    }
    searchFrom = pos + 1;
  }
  if (adjacent >= 0) return adjacent;
  const anchors = collectMatches(text, ANCHOR_RE);
  return anchors.length ? anchors[0].index : -1;
}

function extractOfficialOauthClient(source) {
  const text = String(source || "");
  const ids = collectMatches(text, CLIENT_ID_RE);
  const secrets = collectMatches(text, SECRET_RE);
  if (!ids.length || !secrets.length) return null;
  const anchorIndex = pickAnchorIndex(text, ids);
  const id = nearestMatch(ids, anchorIndex >= 0 ? anchorIndex : ids[0].index, { before: anchorIndex >= 0 });
  const secret = nearestMatch(secrets, id.index);
  if (!id || !secret) return null;
  return { clientId: id.value, clientSecret: secret.value, source: "official-ide" };
}

function readExtractedOfficialOauthClient(exePath = firstExistingExe()) {
  for (const file of officialClientSourcePaths(exePath)) {
    try {
      const extracted = extractOfficialOauthClient(readFileWithRetry(file));
      if (extracted?.clientId && extracted?.clientSecret) return extracted;
    } catch {}
  }
  return null;
}

function readOfficialOauthClient(exePath = firstExistingExe()) {
  if (cached) return cached;
  cached = readExtractedOfficialOauthClient(exePath) || { ...PUBLISHED_OFFICIAL_OAUTH_CLIENT };
  return cached;
}

function listOfficialOauthClients(exePath = firstExistingExe()) {
  const primary = readOfficialOauthClient(exePath);
  const clients = [primary];
  if (primary.clientId !== PUBLISHED_OFFICIAL_OAUTH_CLIENT.clientId) {
    clients.push({ ...PUBLISHED_OFFICIAL_OAUTH_CLIENT });
  }
  return clients;
}

function setOfficialOauthClientForTests(next = null) {
  cached = next;
}

module.exports = {
  officialMainJsPath,
  officialClientSourcePaths,
  extractOfficialOauthClient,
  readExtractedOfficialOauthClient,
  readOfficialOauthClient,
  listOfficialOauthClients,
  setOfficialOauthClientForTests,
  PUBLISHED_OFFICIAL_OAUTH_CLIENT,
};

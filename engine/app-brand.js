"use strict";

const APP_DISPLAY_NAME = "Quota Switcher";
const APP_GITHUB_OWNER = "3xiaoshayu";
const APP_GITHUB_REPO = "codex-account-manager";
const APP_GITHUB_URL = `https://github.com/${APP_GITHUB_OWNER}/${APP_GITHUB_REPO}`;

function isThisAppPath(exePath) {
  const exe = String(exePath || "").replace(/\//g, "\\").toLowerCase();
  return exe.includes("codex-account-manager")
    || exe.includes("codex-deskep")
    || exe.includes("quota-switcher")
    || exe.includes("quota switcher");
}

module.exports = {
  APP_DISPLAY_NAME,
  APP_GITHUB_OWNER,
  APP_GITHUB_REPO,
  APP_GITHUB_URL,
  isThisAppPath,
};

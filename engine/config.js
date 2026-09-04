const os = require("node:os");
const path = require("node:path");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SCOPES = "openid profile email offline_access";
const CALLBACK_PORT = Number(process.env.CODEX_MANAGER_CALLBACK_PORT || 1455);
const REFRESH_MINUTES = 1;
const TOKEN_SKEW_SEC = 300;
const REFRESH_TIMEOUT = 25000;

// Without a home the data path would become a relative ".codex-switch" next
// to whatever the current directory happens to be.
const HOME = process.env.USERPROFILE || (() => {
  try { return os.homedir(); } catch { return ""; }
})();

// Official Codex honors the CODEX_HOME environment variable; strip quotes that
// setx/shell usage may leave around the value.
function resolveCodexHomeFromEnv() {
  const raw = String(process.env.CODEX_HOME || "").trim();
  if (!raw) return null;
  const unquoted = raw.replace(/^["']+|["']+$/g, "").trim();
  return unquoted || null;
}

const CODEX_DIR = process.env.CODEX_MANAGER_CODEX_DIR || resolveCodexHomeFromEnv() || path.join(HOME, ".codex");
const DATA_DIR = process.env.CODEX_MANAGER_DATA_DIR || path.join(HOME, ".codex-switch");
const ACCTS_DIR = path.join(DATA_DIR, "accounts");
const IDX_PATH = path.join(DATA_DIR, "accounts.json");
const CURSOR_ACCTS_DIR = path.join(DATA_DIR, "cursor-accounts");
const CURSOR_IDX_PATH = path.join(DATA_DIR, "cursor-accounts.json");
const CFG_FILE = path.join(DATA_DIR, "auto-switch.json");

const CURSOR_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_TOKEN_URL = "https://api2.cursor.sh/oauth/token";
const CURSOR_USAGE_URL = "https://cursor.com/api/usage-summary";
const CURSOR_META_URL = "https://api2.cursor.sh/aiserver.v1.AuthService/GetUserMeta";
const CURSOR_OAUTH_PENDING_PATH = path.join(DATA_DIR, "cursor_oauth_pending.json");
const ANTIGRAVITY_ACCTS_DIR = path.join(DATA_DIR, "antigravity-accounts");
const ANTIGRAVITY_IDX_PATH = path.join(DATA_DIR, "antigravity-accounts.json");
const ANTIGRAVITY_OAUTH_PENDING_PATH = path.join(DATA_DIR, "antigravity_oauth_pending.json");
const ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANTIGRAVITY_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const ANTIGRAVITY_CLOUDCODE_URL = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_CLOUDCODE_DAILY_URL = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_CALLBACK_PORT = Number(process.env.ANTIGRAVITY_MANAGER_CALLBACK_PORT || 51121);
const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

const PRODUCT_ACCOUNT_PREFIXES = {
  codex: "codex_",
  cursor: "cursor_",
  antigravity: "antigravity_",
};

const CODEX_AUMID = "OpenAI.Codex_2p2nqsd0c76g0!App";

module.exports = {
  CLIENT_ID, AUTH_URL, TOKEN_URL, USAGE_URL,
  SCOPES, CALLBACK_PORT, REFRESH_MINUTES, TOKEN_SKEW_SEC, REFRESH_TIMEOUT,
  HOME, CODEX_DIR, DATA_DIR, ACCTS_DIR, IDX_PATH, CFG_FILE,
  CURSOR_ACCTS_DIR, CURSOR_IDX_PATH, CURSOR_CLIENT_ID, CURSOR_LOGIN_URL,
  CURSOR_POLL_URL, CURSOR_TOKEN_URL, CURSOR_USAGE_URL, CURSOR_META_URL,
  CURSOR_OAUTH_PENDING_PATH, PRODUCT_ACCOUNT_PREFIXES,
  ANTIGRAVITY_ACCTS_DIR, ANTIGRAVITY_IDX_PATH, ANTIGRAVITY_OAUTH_PENDING_PATH,
  ANTIGRAVITY_AUTH_URL, ANTIGRAVITY_TOKEN_URL, ANTIGRAVITY_USERINFO_URL,
  ANTIGRAVITY_CLOUDCODE_URL, ANTIGRAVITY_CLOUDCODE_DAILY_URL, ANTIGRAVITY_CALLBACK_PORT, ANTIGRAVITY_SCOPES,
  CODEX_AUMID, resolveCodexHomeFromEnv,
};

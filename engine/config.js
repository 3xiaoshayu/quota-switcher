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

const HOME = process.env.USERPROFILE || "";

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

const PRODUCT_ACCOUNT_PREFIXES = {
  codex: "codex_",
  cursor: "cursor_",
};

const CODEX_AUMID = "OpenAI.Codex_2p2nqsd0c76g0!App";

module.exports = {
  CLIENT_ID, AUTH_URL, TOKEN_URL, USAGE_URL,
  SCOPES, CALLBACK_PORT, REFRESH_MINUTES, TOKEN_SKEW_SEC, REFRESH_TIMEOUT,
  HOME, CODEX_DIR, DATA_DIR, ACCTS_DIR, IDX_PATH, CFG_FILE,
  CURSOR_ACCTS_DIR, CURSOR_IDX_PATH, CURSOR_CLIENT_ID, CURSOR_LOGIN_URL,
  CURSOR_POLL_URL, CURSOR_TOKEN_URL, CURSOR_USAGE_URL, CURSOR_META_URL,
  CURSOR_OAUTH_PENDING_PATH, PRODUCT_ACCOUNT_PREFIXES,
  CODEX_AUMID, resolveCodexHomeFromEnv,
};

const path = require("node:path");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const RESET_CONSUME_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const ACCOUNT_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const SUBSCRIPTIONS_URL = "https://chatgpt.com/backend-api/subscriptions";
const SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CALLBACK_PORT = 1455;
const REFRESH_MINUTES = 10;
const TOKEN_SKEW_SEC = 300;
const REFRESH_TIMEOUT = 25000;
const SUB_RETRY_SEC = 1800;

const HOME = process.env.USERPROFILE || "";
const CODEX_DIR = path.join(HOME, ".codex");
const DATA_DIR = path.join(HOME, ".codex-switch");
const ACCTS_DIR = path.join(DATA_DIR, "accounts");
const IDX_PATH = path.join(DATA_DIR, "accounts.json");
const CFG_FILE = path.join(DATA_DIR, "auto-switch.json");

const CODEX_AUMID = "OpenAI.Codex_2p2nqsd0c76g0!App";

module.exports = {
  CLIENT_ID, AUTH_URL, TOKEN_URL, USAGE_URL,
  RESET_CREDITS_URL, RESET_CONSUME_URL, ACCOUNT_CHECK_URL, SUBSCRIPTIONS_URL,
  SCOPES, CALLBACK_PORT, REFRESH_MINUTES, TOKEN_SKEW_SEC, REFRESH_TIMEOUT,
  SUB_RETRY_SEC, HOME, CODEX_DIR, DATA_DIR, ACCTS_DIR, IDX_PATH, CFG_FILE,
  CODEX_AUMID,
};

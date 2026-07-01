# Privacy

Codex Account Manager is local-first. It does not operate a project-owned
backend, telemetry pipeline, advertising service, or cross-device account sync.

## Local data

| Path | Contents |
| --- | --- |
| `%USERPROFILE%\.codex-switch\accounts.json` | Account index and current account ID |
| `%USERPROFILE%\.codex-switch\auto-switch.json` | Thresholds, scope, and daemon settings |
| `%USERPROFILE%\.codex-switch\accounts\*.json` | Account metadata and DPAPI-encrypted OAuth tokens |
| `%USERPROFILE%\.codex-switch\codex_oauth_pending.json` | DPAPI-encrypted temporary OAuth state removed after completion, cancellation, or expiry |
| `%USERPROFILE%\.codex-switch\logs\app-YYYY-MM-DD.log` | Sanitized operational diagnostics retained for three days |
| `%USERPROFILE%\.codex\auth.json` | Active authentication state consumed by Codex |
| `%USERPROFILE%\.codex\auth.json.bak` | Previous active authentication state |
| `%USERPROFILE%\.codex\codex_auth_projection.json` | Manager projection of the selected account |

The installer and application do not include real accounts, tokens, logs, or
usage snapshots. Repository screenshots use synthetic data.

## Token protection

Saved account tokens are encrypted through Electron `safeStorage`, backed by
Windows DPAPI. The encrypted payload can normally be decrypted only by the
same Windows user on the same installation.

This protects credentials at rest from casual file disclosure. It does not
protect against:

- malware running as the same Windows user;
- an administrator controlling the machine;
- screenshots, logs, or files that a user intentionally shares;
- a compromised upstream account or Windows login.

The active Codex `auth.json` must remain readable by Codex and should always be
treated as sensitive.

Application logs mask OAuth tokens, callback codes, state values, bearer
credentials, JWTs, and email addresses. Review diagnostic logs before sharing.

## Network requests

The application makes requests only when required by a visible feature or
background account maintenance:

| Destination | Purpose |
| --- | --- |
| `auth.openai.com` | OAuth authorization and token refresh |
| `chatgpt.com` | Quota, subscription, account, and reset-credit reads or actions |
| `github.com` and GitHub release endpoints | Release downloads and stable update checks |

No account list or token is sent to a server operated by this project.
Standard upstream service logs and policies may still apply to requests sent
to OpenAI, ChatGPT, GitHub, or the user's network provider.

## Background behavior

The app can refresh stale quota data, refresh expiring tokens, and evaluate
automatic-switching thresholds while it is running. These requests use the
saved account's local OAuth credentials.

Automatic switching is disabled unless enabled by the user. It does not create
additional quota and cannot bypass upstream limits.

## Process and file changes

Switching accounts:

- requests a normal close for the official Codex process tree and force-closes
  only matching processes that remain after a timeout;
- creates or updates `auth.json.bak`;
- removes `api_base_url` and `openai_base_url` overrides from Codex
  `%USERPROFILE%\.codex\config.toml`;
- writes the selected account to Codex `auth.json`;
- restarts the official Microsoft Store Codex app.

If official Codex authentication changes outside the manager, authentication
writes and automatic switching pause until the user adopts the official login
or reapplies the managed account.

Finish active work before switching and keep an independent backup of custom
Codex configuration when using advanced local endpoints.

## Uninstall and deletion

Uninstalling the application does not automatically delete account data.
After uninstalling, remove `%USERPROFILE%\.codex-switch` manually if you no
longer need the saved accounts.

Deleting `%USERPROFILE%\.codex-switch` is irreversible. Do not delete
`%USERPROFILE%\.codex` unless you also intend to remove Codex's own local state.

## Reporting an issue

Never attach these files or directories to a GitHub issue:

- `.codex-switch`;
- `.codex\auth.json` or its backup;
- OAuth callback URLs;
- full application or network logs containing headers;
- screenshots with real email addresses or account identifiers.

Replace personal data with synthetic values. Report suspected credential
exposure or security vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/3xiaoshayu/codex-account-manager/security/advisories/new).

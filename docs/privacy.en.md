# Privacy

[简体中文](privacy.md)

Quota Switcher is local-first. It does not operate a project-owned
backend, telemetry pipeline, advertising service, or cross-device account sync.

## Local data

| Path | Contents |
| --- | --- |
| `%USERPROFILE%\.codex-switch\accounts.json` | Codex account index and current account ID |
| `%USERPROFILE%\.codex-switch\cursor-accounts.json` | Cursor account index and current account ID |
| `%USERPROFILE%\.codex-switch\antigravity-accounts.json` | Antigravity account index and current account ID |
| `%USERPROFILE%\.codex-switch\auto-switch.json` | Thresholds, scope, and daemon settings |
| `%USERPROFILE%\.codex-switch\accounts\*.json` | Codex account metadata and DPAPI-encrypted OAuth tokens |
| `%USERPROFILE%\.codex-switch\cursor-accounts\*.json` | Cursor account metadata and DPAPI-encrypted OAuth tokens |
| `%USERPROFILE%\.codex-switch\antigravity-accounts\*.json` | Antigravity account metadata and DPAPI-encrypted OAuth tokens |
| `%USERPROFILE%\.codex-switch\codex_oauth_pending.json` | DPAPI-encrypted temporary Codex OAuth state removed after completion, cancellation, or expiry |
| `%USERPROFILE%\.codex-switch\cursor_oauth_pending.json` | DPAPI-encrypted temporary Cursor OAuth state removed after completion, cancellation, or expiry |
| `%USERPROFILE%\.codex-switch\antigravity_oauth_pending.json` | DPAPI-encrypted temporary Antigravity OAuth state removed after completion, cancellation, or expiry |
| `%USERPROFILE%\.codex-switch\logs\app-YYYY-MM-DD.log` | Sanitized operational diagnostics retained for three days |
| `%USERPROFILE%\.codex\auth.json` | Active authentication state consumed by official Codex |
| `%USERPROFILE%\.codex\auth.json.bak` | Previous active Codex authentication state |
| `%USERPROFILE%\.codex\codex_auth_projection.json` | Manager projection of the selected Codex account |
| `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | Official Cursor login database written during a Cursor switch |
| `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` | Official Antigravity login database written during an Antigravity switch |

The installer and application do not include tokens, logs, or usage snapshots.
Public README screenshots are redacted. Do not attach live emails.

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

The active Codex `auth.json` must remain readable by Codex. Official Cursor and
Antigravity `state.vscdb` files must remain readable by those apps. Treat them
as sensitive.

Application logs mask OAuth tokens, callback codes, state values, bearer
credentials, JWTs, and email addresses. Review diagnostic logs before sharing.

## Network requests

The application makes requests only when required by a visible feature or
background account maintenance:

Interface backgrounds are bundled with the application and do not trigger
third-party image requests at runtime.

| Destination | Purpose |
| --- | --- |
| `auth.openai.com` | Codex OAuth authorization and token refresh |
| `chatgpt.com` | Codex quota and account profile reads |
| `cursor.com` | Cursor sign-in and usage reads |
| `api2.cursor.sh` | Cursor token refresh, poll, and account metadata |
| `accounts.google.com` | Antigravity browser authorization |
| `oauth2.googleapis.com` | Antigravity token exchange and refresh |
| `www.googleapis.com` | Antigravity Google account email |
| `cloudcode-pa.googleapis.com` | Antigravity quota |
| `github.com` and GitHub release endpoints | Release downloads and stable update checks |

No account list or token is sent to a server operated by this project.
Standard upstream service logs and policies may still apply to requests sent
to OpenAI, ChatGPT, Cursor, Google, GitHub, or the user's network provider.

Google third-party sign-in is discussed as a risk. Phase 1 only manages the
official **Antigravity IDE** already logged in on this PC. Failed quota reads
are shown as unclear, not as a Codex-style banned account.

A local HTTP or SOCKS proxy may be discovered and reused so quota refresh can
follow the same outbound path as the browser. Proxy credentials are redacted
in logs.

## Background behavior

The app can refresh stale quota data, refresh expiring tokens, and evaluate
automatic-switching thresholds while it is running. These requests use the
saved account's local OAuth credentials.

Automatic switching is Codex-only and disabled unless enabled by the user. It
does not create additional quota and cannot bypass upstream limits. Cursor
and Antigravity accounts are not candidates for automatic switching.

## Process and file changes

Switching a Codex account:

- requests a normal close for the official Codex process tree and force-closes
  only matching processes that remain after a timeout;
- creates or updates `auth.json.bak`;
- removes `api_base_url` and `openai_base_url` overrides from Codex
  `%USERPROFILE%\.codex\config.toml`;
- writes the selected account to Codex `auth.json`;
- restarts the official Microsoft Store Codex app.

Switching a Cursor account:

- requests a normal close for official Cursor and force-closes only matching
  processes that remain after a timeout;
- updates only the login keys in `state.vscdb` in place;
- refuses the write if the official app still holds the login database;
- relaunches official Cursor.

Switching an Antigravity account:

- requests a normal close for official Antigravity IDE and force-closes only
  matching processes that remain after a timeout;
- replaces only the OAuth token item in `state.vscdb`;
- refuses the write if the official app still holds the login database;
- relaunches official Antigravity IDE.

Phase 1 does not manage the legacy `Antigravity.exe` runtime and does not
open multiple instances.

If official Codex authentication changes outside the manager, authentication
writes and automatic switching pause until the user chooses **采用官方账号**
or **写回管理账号**.

Finish active work before switching. Switching Cursor or Antigravity closes
the official window, including unsaved editor work.

## Uninstall and deletion

Uninstalling the application does not automatically delete account data.
After uninstalling, remove `%USERPROFILE%\.codex-switch` manually if you no
longer need the saved accounts.

Deleting `%USERPROFILE%\.codex-switch` is irreversible. Do not delete
`%USERPROFILE%\.codex` unless you also intend to remove Codex's own local
state. Do not delete `%APPDATA%\Cursor` unless you also intend to remove
Cursor's own local state. Do not delete `%APPDATA%\Antigravity IDE` unless you
also intend to remove Antigravity's own local state.

## Reporting an issue

Never attach these files or directories to a GitHub issue:

- `.codex-switch`;
- `.codex\auth.json` or its backup;
- Cursor or Antigravity `state.vscdb` or its WAL/SHM files;
- OAuth callback URLs;
- full application or network logs containing headers.

Redact emails in screenshots. Do not attach tokens or account files. Report
suspected credential exposure through
[GitHub private vulnerability reporting](https://github.com/3xiaoshayu/codex-account-manager/security/advisories/new).

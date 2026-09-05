# Troubleshooting

[简体中文](troubleshooting.md)

## Windows shows an unknown publisher

2.0.6 is still unsigned, so Microsoft Defender SmartScreen may display an
unknown-publisher warning.

1. Download only from this repository's Releases page.
2. Compare the installer SHA-256 with `SHA256SUMS.txt`.
3. Do not run a build received through chat, email, or an unrelated mirror.

## Codex is reported as not installed

The current Windows build supports the official Microsoft Store Codex package
with AUMID:

```text
OpenAI.Codex_2p2nqsd0c76g0!App
```

Install or update Codex from the Microsoft Store, launch it once, then select
**重新检测** in Settings. Other package sources are not supported yet.

## Cursor is reported as not found

Cursor features need the official Cursor app on this PC. Install Cursor, launch
it once, then select **重新检测** in Settings. Portable copies that are not
registered as `Cursor.exe` may not be detected.

## Antigravity is reported as not found

Phase 1 only detects official **Antigravity IDE** (`Antigravity IDE.exe`).
Install it, launch and sign in once, then select **重新检测** in Settings.
Legacy `Antigravity.exe` is out of scope. Multiple instances are not supported.

## Adding a Codex account does not complete

The Codex OAuth callback listens on local port `1455`.

- Keep the manager open while signing in.
- Allow the browser to return to `http://localhost:1455`.
- Close software already using port `1455`.
- Check whether firewall or security software blocks local loopback traffic.
- Retry **添加账号** after the previous login attempt has ended.
- If automatic return fails, paste the complete callback URL into the
  **添加账号** dialog.
- Pending OAuth authorization is restored after an app restart for up to five
  minutes.

If the modal reports `Client network socket disconnected before secure TLS
connection was established`, or an error starting with `授权已返回，但交换
Token 失败`, the browser authorization step has already returned to the app,
but the token exchange request could not reach the OpenAI authorization
endpoint. Check whether your proxy, VPN, TUN mode, firewall, or security
software applies to desktop applications as well as the browser. If the browser
works but the app does not, switch the proxy from browser-only mode to system or
TUN mode, then retry **添加账号**.

Do not post the callback URL in an issue; it can contain sensitive authorization
data.

## Adding a Cursor account does not complete

Cursor sign-in opens the official login page and waits for the browser flow to
finish. There is no callback URL to paste.

- Keep the manager open while signing in.
- Finish the Cursor login in the browser with the account you intend to add.
- If Cursor is already open, close unsaved editor work first; a later switch
  will restart official Cursor.
- Retry **添加账号** after the previous login attempt has ended.

You can also use **导入本机已登录的 Cursor** instead of opening the browser
flow.

## Quota says it could not refresh, but the login is still there

When the card or banner says **额度暂时没刷到，登录还在**, the login has not
dropped. Timeouts, proxy 5xx responses, empty or HTML token bodies, and a
usage-endpoint 429 all use this line. The app does not ask for re-auth for
those cases.

- Leftover remaining quota stays on the card. Try again later.
- A Codex `429 rate_limit` is not used-up quota.
- Check whether the proxy, VPN, or TUN mode applies to desktop apps, not
  only the browser.
- Check another saved account to distinguish an account-specific response
  from a network-wide failure.

## Quota stays unknown

An unknown quota is different from zero quota. Exhausted Cursor usage is shown
as **已用尽**, not as a missing window. A temporary miss keeps leftover
remaining quota on the card instead of rewriting it to unknown or zero.

- Wait for the background refresh or select **刷新额度** on the card.
- Confirm the account token is not expired or marked for reauthentication.
- Confirm `chatgpt.com` (Codex) or `cursor.com` (Cursor) is reachable from the
  current network.
- If Windows system proxy is off but a local HTTP/SOCKS port is still live,
  the app should follow that port. If quota hangs, check the proxy client.
- Check another saved account to distinguish an account-specific response from
  a network-wide failure.

Codex 5-hour and weekly windows are parsed independently. Some accounts or
responses may not expose both windows; those rows say **暂无此项**. Cursor
shows plan, Auto, and API independently.

## Token refresh fails

If a refresh token has expired, been revoked, or already been rotated
elsewhere, use **重新授权** from the affected account card. If the
new login belongs to a different identity, it is saved as a separate account
instead of overwriting the original record.

Never paste a refresh token, `auth.json`, Cursor `state.vscdb`, or account file
into a GitHub issue.

## Switching succeeds but Codex shows the previous account

1. Finish active Codex work.
2. Close all remaining Codex windows.
3. Switch again from the manager.
4. Confirm the manager marks the selected card as current.
5. Restart Windows if a stale Store app process cannot be terminated.

Switching intentionally restarts the Codex application. A session that was
already running may be interrupted.

## Switching Cursor is refused or rolls back

- Finish unsaved work in official Cursor first. The switch closes that app.
- If the manager says the official app still holds the login database, close
  that app and retry. Switching updates login keys in place and does not
  rewrite the whole `state.vscdb` file.
- If you are working inside official Cursor, finish or save that session
  first. The switch will close it.

## Official Codex login changed

The manager pauses background authentication writes when the official Codex
login differs from its managed current account. Choose
**采用官方账号** to import and use the official login, or
**写回管理账号** to restore the manager-selected identity.

## The window closed but the app is still running

The title-bar close button hides the main window to the tray. The background
login renewal and quota sync keep running. Left-click the tray icon, or choose
**打开窗口**, to show the window again. To quit, right-click the tray icon and
choose **退出**.

## The desktop quota lens does not appear

Open it from the tray menu item **打开桌面额度**, or from
**系统设置 > 桌面额度 > 打开**. If no accounts are saved yet, the lens
shows an empty state until you add one. The lens follows the sidebar product:
Codex shows nested 5-hour / weekly rings, Cursor shows Auto and API.

## Account files appear missing

Open **系统设置 > 日志** and inspect the latest diagnostic file. Malformed JSON
is restored from `.bak` when possible. DPAPI decryption failures are left in
place so the original encrypted account file is not destroyed.

## A custom API base URL disappeared

Account switching removes `api_base_url` and `openai_base_url` entries from
`%USERPROFILE%\.codex\config.toml` so the selected account starts against the
standard Codex service.

Back up advanced Codex configuration before switching if you depend on a
custom endpoint.

## Build downloads time out

Retry the release build with an electron-builder mirror:

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run build:windows
```

This environment variable affects only local build dependency downloads.

## Preparing a bug report

Include:

- application version;
- Windows version and architecture;
- whether the issue is Codex, Cursor, or both;
- Codex / Cursor install source;
- exact steps and expected behavior;
- whether the issue occurs for one account or all accounts;
- a screenshot when useful.

Do not attach tokens, account files, callback URLs, or authorization headers.
Emails in screenshots are fine. Use the repository's bug report form.

# Troubleshooting

## Windows shows an unknown publisher

Current prerelease installers are not code-signed, so Microsoft Defender
SmartScreen may display an unknown-publisher warning.

1. Download only from this repository's Releases page.
2. Compare the installer SHA-256 with `SHA256SUMS.txt`.
3. Do not run a build received through chat, email, or an unrelated mirror.

This warning can only be removed reliably by signing future releases with a
trusted Windows code-signing certificate.

## Codex is reported as not installed

The current Windows build supports the official Microsoft Store Codex package
with AUMID:

```text
OpenAI.Codex_2p2nqsd0c76g0!App
```

Install or update Codex from the Microsoft Store, launch it once, then select
**Re-detect** in Settings. Other package sources are not supported yet.

## Adding an account does not complete

The OAuth callback listens on local port `1455`.

- Keep the manager open while signing in.
- Allow the browser to return to `http://localhost:1455`.
- Close software already using port `1455`.
- Check whether firewall or security software blocks local loopback traffic.
- Retry **Add account** after the previous login attempt has ended.

If the modal reports `Client network socket disconnected before secure TLS
connection was established`, or an error starting with `授权已返回，但交换
Token 失败`, the browser authorization step has already returned to the app,
but the token exchange request could not reach the OpenAI authorization
endpoint. Check whether your proxy, VPN, TUN mode, firewall, or security
software applies to desktop applications as well as the browser. If the browser
works but the app does not, switch the proxy from browser-only mode to system or
TUN mode, then retry **Add account**.

Do not post the callback URL in an issue; it can contain sensitive authorization
data.

## Quota stays unknown

An unknown quota is different from zero quota.

- Wait for the background refresh or select **Refresh quota** on the card.
- Confirm the account token is not expired or marked for reauthentication.
- Confirm `chatgpt.com` is reachable from the current network.
- Check another saved account to distinguish an account-specific response from
  a network-wide failure.

The 5-hour and weekly windows are parsed independently. Some accounts or
responses may not expose both windows.

## Token refresh fails

If a refresh token has expired, been revoked, or already been rotated
elsewhere, the account must be authenticated again. Remove and add the affected
account only after confirming that another usable account exists.

Never paste a refresh token, `auth.json`, or account file into a GitHub issue.

## Switching succeeds but Codex shows the previous account

1. Finish active Codex work.
2. Close all remaining Codex windows.
3. Switch again from the manager.
4. Confirm the manager marks the selected card as current.
5. Restart Windows if a stale Store app process cannot be terminated.

Switching intentionally restarts the Codex application. A session that was
already running may be interrupted.

## A custom API base URL disappeared

Account switching removes `api_base_url` and `openai_base_url` entries from
`%USERPROFILE%\.codex\config.toml` so the selected account starts against the
standard Codex service.

Back up advanced Codex configuration before switching if you depend on a
custom endpoint.

## Reset-credit controls are unavailable

The manager can only display or consume reset credits returned for the
authenticated account. It cannot create credits. If the upstream response does
not expose credits, the consume action remains disabled.

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
- Codex install source;
- exact steps and expected behavior;
- whether the issue occurs for one account or all accounts;
- a redacted screenshot when useful.

Exclude all tokens, account files, callback URLs, real email addresses, and
authorization headers. Use the repository's bug report form.

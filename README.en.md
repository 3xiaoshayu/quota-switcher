<div align="center">

# Quota Switcher

View and switch Codex, Cursor, and Antigravity accounts on Windows.
Quotas, logins, and credentials stay on this PC and are encrypted for the
current Windows user.

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
[![CI](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/code-MIT-2f855a)](LICENSE)

[Download](https://github.com/3xiaoshayu/codex-account-manager/releases) ·
[Troubleshooting](docs/troubleshooting.en.md) ·
[Privacy](docs/privacy.en.md) ·
[简体中文](README.md)

</div>

![Cursor accounts and quotas; the sidebar switches to Codex or Antigravity](docs/images/account-dashboard.png)

> [!IMPORTANT]
> The installer is not code-signed. Windows may warn about an unknown
> publisher. Download only from this repository's
> [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases)
> page and check the SHA-256 in `SHA256SUMS.txt` on the same release.

## Features

- **Three products, one window.** The sidebar switches between Codex, Cursor,
  and Antigravity. Each account is a card with remaining quota and plan status.
- **Writes the official client.** A switch updates the local official login.
  It does not create a separate cloud session.
- **Codex can auto-switch in the background.** When usage falls below the
  threshold you set, a worker switches accounts. Closing the window does not
  stop it. Cursor and Antigravity support viewing and manual switching only.
- **Local-first.** The account store is encrypted with Windows DPAPI. There is
  no telemetry and no project-operated cloud.
- **Tray and desktop quota lens.** Close to the tray, keep a desktop quota
  window, and check how long the login still lasts.

A switch closes the matching official process first. Save your work before you
switch. This app cannot raise anyone's official limits.

Antigravity currently targets official **Antigravity IDE** (local import,
Google browser sign-in, switch, quota refresh, float window). It does not
manage legacy `Antigravity.exe`. A failed quota read is not shown as a ban.

## Compared with Cockpit Tools

A common community reference is
[Cockpit Tools](https://github.com/jlcodes99/cockpit-tools), a general cockpit
for many AI IDEs. Quota Switcher takes a different path: a complete
**Windows-local vault, quota view, and switch path** for Codex, Cursor, and
Antigravity. Relative to a general-purpose cockpit, these are the parts we
built in depth.

**A Windows vault.** Accounts and tokens are encrypted with current-user DPAPI
via Electron `safeStorage`. Another Windows user or another PC generally
cannot decrypt them. The UI receives metadata only; tokens are not decrypted
into the renderer. There is no telemetry and no project-operated cloud.

**Codex switches as a transaction.** The official login, managed projection,
and index are snapshotted first. If a later step fails, the whole transaction
rolls back. It does not write `auth.json` first and try to repair afterwards.
When official Codex and this app disagree, the window offers **采用官方账号**
or **写回管理账号**. It does not overwrite in silence.

**Cursor and Antigravity update the official login database in place.** A
switch uses WAL and `BEGIN IMMEDIATE` on `state.vscdb` instead of copying a
large file. A Cursor switch restores the target account's profile, team
session, and usage identity, and clears leftover team cache from the previous
login so a Pro account is not left on someone else's team.

**Quota HTTP does not use the Chromium session.** Outbound calls go through
Node keep-alive agents keyed by proxy signature, so the main window is less
likely to freeze as “未响应”. All three products refresh five at a time. The
window and desktop lens apply a snapshot plus patches instead of a full
reload. Batch refresh skips accounts that already need re-auth or are banned,
instead of queuing requests that will fail.

**Codex auto-switch keeps running after the window is closed.** A background
worker switches at the threshold you set. The same window holds account cards,
quota overview, and the desktop lens for Codex, Cursor, and Antigravity IDE.

## Interface

The hero image is the Cursor account page. The close button hides the window
to the tray; it does not quit.

<table>
  <tr>
    <td align="center"><sub><b>Codex accounts</b></sub></td>
    <td align="center"><sub><b>Quota overview</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/codex-accounts.png" alt="Codex accounts" /></td>
    <td><img src="docs/images/quota-overview.png" alt="Cursor quota overview" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Codex auto-switch</b></sub></td>
    <td align="center"><sub><b>Desktop quota lens</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/auto-switch.png" alt="Codex automatic switching" /></td>
    <td><img src="docs/images/float-lens.png" alt="Desktop quota lens" /></td>
  </tr>
</table>

## Install

Windows 10 or 11 (x64). Codex needs the official Microsoft Store Codex app.
Cursor needs official Cursor. Antigravity needs official Antigravity IDE. Any
subset can be used on its own.

1. Open [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases) and download `Quota-Switcher-Setup-<version>-x64.exe`
2. Install and open it
3. Choose a product in the sidebar, then **导入本机已登录** or **打开网页授权**
4. Account cards and quotas appear when you return

The ZIP also runs; data still lives in the user profile. Upgrading from
`1.0.x` to 2.0 requires this Setup once so the desktop shortcut is renamed to
Quota Switcher. Later `2.0.x` builds can be checked from inside the app.

```powershell
Get-FileHash ".\Quota-Switcher-Setup-<version>-x64.exe" -Algorithm SHA256
```

Compare the result with `SHA256SUMS.txt` from the same release.

## Where data lives

| Path | Use |
| --- | --- |
| `%USERPROFILE%\.codex-switch` | This app's accounts, settings, and logs |
| `%USERPROFILE%\.codex\auth.json` | Written on a Codex switch, after `auth.json.bak` |
| `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | Official Cursor login written on a Cursor switch |
| `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` | Official Antigravity login written on an Antigravity switch |

Outbound calls go to OpenAI / ChatGPT, Cursor, Google, and GitHub. Windows
encryption will not help if someone already controls this PC. Details are in
[Privacy](docs/privacy.en.md).

If official Codex and this app disagree, the window offers **采用官方账号**
(use the official login) or **写回管理账号** (write the managed one back).

## Running from source

Node.js 22 or newer (CI uses 24 LTS):

```powershell
git clone https://github.com/3xiaoshayu/codex-account-manager.git
cd codex-account-manager
npm ci
npm test
npm start
```

Package with `npm run build:dir` or `npm run build:windows`. Implementation
notes are in [Architecture](docs/architecture.md).

## Docs

[Privacy](docs/privacy.en.md) ·
[Troubleshooting](docs/troubleshooting.en.md) ·
[Support](SUPPORT.en.md) ·
[Security](SECURITY.en.md) ·
[Code of Conduct](CODE_OF_CONDUCT.en.md) ·
[Changelog](CHANGELOG.md)

For contributors: [Architecture](docs/architecture.md) ·
[Contributing](CONTRIBUTING.en.md) ·
[Releasing](docs/releasing.md)

## Notes

This is an independent community project, not affiliated with or endorsed by
OpenAI, Anysphere / Cursor, or Google. OpenAI, Codex, ChatGPT, Cursor, and
Antigravity are trademarks of their respective owners.

Only manage accounts you own or are clearly allowed to use. Windows x64 only.
Auto-switch is Codex-only. Antigravity is official IDE only. The installer is
not code-signed yet.

The code is [MIT](LICENSE). Icon and installer art are covered by
[ASSET_LICENSE.md](ASSET_LICENSE.md).

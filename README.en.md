<div align="center">

# Quota Switcher

Several Codex, Cursor, and Antigravity accounts, one Windows window.

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
[![CI](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/code-MIT-2f855a)](LICENSE)

[Download](https://github.com/3xiaoshayu/codex-account-manager/releases) ·
[Troubleshooting](docs/troubleshooting.en.md) ·
[Privacy](docs/privacy.en.md) ·
[简体中文](README.md)

</div>

![Cursor account page; the sidebar switches back to Codex](docs/images/account-dashboard.png)

> [!IMPORTANT]
> The installer is not signed yet, so Windows may warn about an unknown
> publisher. Download only from this repository's
> [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases)
> page and check the SHA-256.

## What this is

**1.0.0 is the first stable release.** The sidebar switches **Codex** /
**Cursor** / **Antigravity**. One card per account, remaining quota at a
glance. When you switch, it updates the official client's login. Accounts stay
on this PC and are encrypted for the current Windows user. Nothing is uploaded
to us.

It cannot raise anyone's limits. Auto-switch only moves between your saved
Codex accounts. Cursor and Antigravity can show usage and switch by hand; they
do not auto-switch.

Antigravity phase 1 is official **Antigravity IDE** only: import the local
login, browser Google OAuth, switch, refresh quota, and the float window. It
does not manage legacy `Antigravity.exe` and does not open multiple instances.
Failed quota reads are not shown as a Codex-style banned account.

## What it does

**Codex** — 5-hour and weekly quota. Import the login already on this PC, or
sign in through the browser. A switch writes the official Microsoft Store
Codex app. When usage is low, a background worker switches at the line you
set. Closing the window does not stop it.

**Cursor** — plan, Auto, and API. Import the local login or sign in through
the browser, then write official Cursor. The official current login is marked
as current.

**Antigravity** — plan/credits and primary model remaining. Import the local
Antigravity IDE login or sign in with Google, then write official Antigravity
IDE.

**All three** — close to the tray, a desktop quota lens, and a check for how
long the login still lasts. No telemetry and no cloud of ours.

A switch closes the matching official app first. Finish the work in front of
you before you switch.

## Why this one

A common community reference is
[Cockpit Tools](https://github.com/jlcodes99/cockpit-tools), a serious
Tauri + Rust project. This app is not a replacement for it. The goal here is a
solid **Windows vault, switch transaction, and three-product window**.

| Area | Quota Switcher |
| --- | --- |
| Codex switch | Snapshot the official login, managed projection, and index first; roll the whole transaction back if a later step fails. It does not write `auth.json` first and hope to repair afterwards. |
| Windows secrets | Current-user DPAPI via Electron `safeStorage`. Another Windows user or another PC generally cannot decrypt them. |
| Official-login conflict | The window offers **采用官方账号** (use the official login) or **写回管理账号** (write the managed one back). It does not overwrite in silence. |
| Batch refresh | Skip accounts that already need re-auth or are banned, instead of queuing requests that will fail. |
| Network | Node HTTP with keep-alive Agents keyed by proxy signature. Quota calls do not use the Chromium session, so the main window is less likely to freeze as “未响应”. |
| Account list | The UI receives metadata only. Tokens are not decrypted into the renderer. |
| Quotas | All three products refresh five at a time. The window and float use a snapshot plus patches instead of a full reload. |
| Cursor / Antigravity | In-place `state.vscdb` updates (`BEGIN IMMEDIATE`, WAL) instead of copying a large database around. |
| Scope | One window for Codex, Cursor, and Antigravity IDE. Codex auto-switch keeps running after the window is closed. |

Where the other project is still a better fit, we say so:

- A Rust / Tauri runtime is lighter, and the installer is smaller.
- WSL, timed wakeup, and opening multiple official clients are intentionally
  out of scope here.
- This installer is still unsigned. Windows may warn; check the SHA-256.

## Interface

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
    <td align="center"><sub><b>Settings</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/auto-switch.png" alt="Codex automatic switching" /></td>
    <td><img src="docs/images/settings.png" alt="Settings" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Login</b></sub></td>
    <td align="center"><sub><b>Desktop quota lens</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/login.png" alt="Login" /></td>
    <td><img src="docs/images/float-lens.png" alt="Desktop quota lens" /></td>
  </tr>
</table>

The first image is the Cursor account page. The close button hides the window
to the tray; it does not quit.

## Install

Windows 10 or 11 (x64). Codex needs the official Microsoft Store Codex app.
Cursor needs official Cursor. Antigravity needs official Antigravity IDE. You
can use any subset on its own.

1. Open [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases) and download `Quota-Switcher-Setup-<version>-x64.exe`
2. Install and open it
3. Pick Codex, Cursor, or Antigravity in the sidebar, then use the matching
   **导入本机已登录** action, or **打开网页授权**
4. The cards and quotas should be there when you come back

The ZIP also runs; data still lives in your user profile. Upgrading from
`0.1.0-beta.*` to 1.0.0 needs a manual Setup install. After that, later
`1.0.x` builds can be checked from inside the app.

```powershell
Get-FileHash ".\Quota-Switcher-Setup-<version>-x64.exe" -Algorithm SHA256
```

Compare that with `SHA256SUMS.txt` from the same release.

## Where data lives

| Path | Use |
| --- | --- |
| `%USERPROFILE%\.codex-switch` | The manager's own accounts, settings, and logs |
| `%USERPROFILE%\.codex\auth.json` | Written on a Codex switch, after `auth.json.bak` |
| `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | Official Cursor login written on a Cursor switch |
| `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` | Official Antigravity login written on an Antigravity switch |

Outbound calls go to OpenAI / ChatGPT, Cursor, Google, and GitHub. Windows
encryption will not help if someone already controls this PC. Details are in
[Privacy](docs/privacy.en.md).

If official Codex and the manager disagree, the window offers **采用官方账号**
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

Package with `npm run build:dir` or `npm run build:windows`.

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

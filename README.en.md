<div align="center">

# Codex Account Manager

Keep several Codex and Cursor accounts in one Windows window. Quotas,
identity, and switching stay on your machine.

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?include_prereleases&sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
[![CI](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/code-MIT-2f855a)](LICENSE)

[Download 0.1.0-beta.25](https://github.com/3xiaoshayu/codex-account-manager/releases/tag/v0.1.0-beta.25) ·
[Troubleshooting](docs/troubleshooting.md) ·
[Privacy](docs/privacy.md) ·
[简体中文](README.md)

</div>

![The sidebar switches between Codex and Cursor](docs/images/account-dashboard.png)

> [!IMPORTANT]
> This is a prerelease. The installer is not code-signed yet, so Windows may
> warn about an unknown publisher. Download only from this repository's
> [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases) page
> and check the SHA-256.

## What this is

The sidebar switches **Codex** / **Cursor**. One card per account, quotas you
can read at a glance, and switching that updates the official client. Accounts
and tokens stay on this PC.

It cannot raise anyone's limits. Automatic switching only chooses among the
Codex accounts you saved. Cursor can show usage, refresh login, and switch
manually; it stays out of auto-switch.

## What it does

**Codex** — 5-hour and weekly quota, import the local login or sign in through
the browser, and write the official Microsoft Store Codex app. When usage is
low, a local daemon switches at the threshold you set. Closing the main window
does not stop it.

**Cursor** — plan, Auto, and API usage, import the local login or sign in
through the browser, and write official Cursor. The official current login is
marked as the current Cursor account.

**Shared** — close to tray, a desktop quota lens, token checks, and Windows
DPAPI. No telemetry and no cloud service of ours.

Switching Codex stops the official Codex client and starts it again. Switching
Cursor closes official Cursor and rewrites its login database. Let in-flight
work finish first.

## Interface

<table>
  <tr>
    <td align="center"><sub><b>Codex accounts</b></sub></td>
    <td align="center"><sub><b>Cursor quotas</b></sub></td>
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

The hero is the Cursor account page. Closing the window hides it to the tray.

## Install

Windows 10 or 11 (x64). Codex features need the official Microsoft Store Codex
app. Cursor features need official Cursor. You can use either product on its
own.

1. Download `Codex-Account-Manager-Setup-<version>-x64.exe` from [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases)
2. Install and open it
3. Pick Codex or Cursor in the sidebar, then import the official login already on this PC or finish sign-in in the browser
4. The card and quota should appear when you return

The ZIP runs unpacked; app data still lives in your user profile. Betas update
manually.

```powershell
Get-FileHash ".\Codex-Account-Manager-Setup-<version>-x64.exe" -Algorithm SHA256
```

Compare that with `SHA256SUMS.txt` from the same release.

## Where data lives

| Path | Use |
| --- | --- |
| `%USERPROFILE%\.codex-switch` | Manager accounts, settings, and logs |
| `%USERPROFILE%\.codex\auth.json` | Written on a Codex switch, after `auth.json.bak` |
| `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | Official Cursor login written on a Cursor switch |

Network calls go to OpenAI / ChatGPT, Cursor, and GitHub. DPAPI will not help
if someone already controls your Windows session. Details are in
[Privacy](docs/privacy.md).

If the official Codex login is not the identity the manager has selected, a
banner lets you adopt the official account or write the managed one back.

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

[Architecture](docs/architecture.md) ·
[Privacy](docs/privacy.md) ·
[Troubleshooting](docs/troubleshooting.md) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md) ·
[Releasing](docs/releasing.md) ·
[Changelog](CHANGELOG.md) ·
[Support](SUPPORT.md)

## Notes

This is an independent community project, not affiliated with or endorsed by
OpenAI or Anysphere / Cursor. OpenAI, Codex, ChatGPT, and Cursor are trademarks
of their respective owners.

Only manage accounts you own or are authorized to use. Windows x64 only, for
now. Storage and quota parsing may still change during prerelease.

The code is [MIT](LICENSE). Icon and installer art are covered by
[ASSET_LICENSE.md](ASSET_LICENSE.md).

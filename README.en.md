<div align="center">

# Codex Account Manager

Keep several Codex and Cursor accounts in one Windows window. Quotas,
identity, and switching stay on your machine.

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?include_prereleases&sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
[![CI](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/code-MIT-2f855a)](LICENSE)

[Download](https://github.com/3xiaoshayu/codex-account-manager/releases) ·
[Troubleshooting](docs/troubleshooting.md) ·
[Privacy](docs/privacy.md) ·
[简体中文](README.md)

</div>

![Codex Account Manager account view](docs/images/account-dashboard.png)

> [!IMPORTANT]
> This is a prerelease. The installer is not code-signed yet, so Windows may
> warn about an unknown publisher. Download only from this repository's
> [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases) page
> and check the SHA-256.

## What this is

Once you have more than one Codex or Cursor account, checking remaining quota
and changing identity gets tedious. This app puts that in a single Windows
window: one card per account, quotas you can read at a glance, and switching
that updates the official client for you. The sidebar switches between the
two products.

It cannot raise anyone's limits. Automatic switching only chooses among the
accounts you saved.

## What you can do

- **Account cards** — 5-hour quota, weekly quota, reset times, and token lifetime on each card. Search, filter, add, refresh, switch, reauthorize, or delete. The header shows the current mailbox; click it to copy.
- **Quota overview** — every account on one page. A failed read shows as unknown, never as zero.
- **Automatic switching** — a local daemon moves to the next usable Codex account at the threshold you set. Closing the main window does not stop it. Cursor stays out of auto-switch.
- **Close to tray** — the close button hides the window. Click the tray icon to bring it back; choose **Exit** on the tray menu to quit.
- **Desktop quota lens** — a small desktop ring for the tighter remaining window. Page through accounts, pin, refresh, or switch from there.
- **Local only** — accounts and tokens stay on this PC, with tokens encrypted by Windows DPAPI. No telemetry and no cloud service of ours.

Switching stops the running Codex client and starts it again. Let in-flight work finish first.

## Interface

<table>
  <tr>
    <td align="center"><sub><b>Quota overview</b></sub></td>
    <td align="center"><sub><b>Automatic switching</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/quota-overview.png" alt="Quota overview" /></td>
    <td><img src="docs/images/auto-switch.png" alt="Automatic switching" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Settings</b></sub></td>
    <td align="center"><sub><b>Login</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/settings.png" alt="Settings" /></td>
    <td><img src="docs/images/login.png" alt="Login" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Desktop quota lens</b></sub></td>
    <td align="center"><sub><b>Tray menu</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/float-lens.png" alt="Desktop quota lens" /></td>
    <td><img src="docs/images/tray-menu.png" alt="Tray menu" /></td>
  </tr>
</table>

Emails in the screenshots are masked so real accounts are not published.

## Install

Windows 10 or 11 (x64) and the official Microsoft Store Codex app.

1. Download `Codex-Account-Manager-Setup-<version>-x64.exe` from [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases)
2. Install and open it
3. Add an account and finish sign-in in the browser
4. The card and quota should appear when you return

The ZIP runs unpacked, but app data still lives in your user profile — the installer is the usual choice. Betas update manually.

To verify a build, compare it with `SHA256SUMS.txt` from the same release:

```powershell
Get-FileHash ".\Codex-Account-Manager-Setup-<version>-x64.exe" -Algorithm SHA256
```

## Where data lives

- App data: `%USERPROFILE%\.codex-switch`
- Switching writes `%USERPROFILE%\.codex\auth.json` after saving `auth.json.bak`
- Network calls go to OpenAI / ChatGPT (sign-in, refresh, quota) and GitHub (update checks)

DPAPI will not help if someone already controls your Windows session. Details are in [Privacy](docs/privacy.md).

If the official Codex login is not the identity the manager has selected, a banner lets you adopt the official account or write the managed one back.

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
OpenAI. OpenAI, Codex, and ChatGPT are trademarks of their respective owners.

Only manage accounts you own or are authorized to use. Production API traffic
belongs on the OpenAI Platform API.

Windows x64 and Microsoft Store Codex only, for now. Storage and quota parsing
may still change during prerelease.

The code is [MIT](LICENSE). Icon and installer art are covered by
[ASSET_LICENSE.md](ASSET_LICENSE.md).

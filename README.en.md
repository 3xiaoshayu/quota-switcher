<div align="center">

# Codex Account Manager

A local-first multi-account control panel for Codex on Windows.

See each account's 5-hour and weekly quota, token health, and active Codex identity in one place.

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?include_prereleases&sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
[![CI](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/code-MIT-2f855a)](LICENSE)

[Download](https://github.com/3xiaoshayu/codex-account-manager/releases) ·
[Troubleshooting](docs/troubleshooting.md) ·
[Privacy](docs/privacy.md) ·
[简体中文](README.md)

</div>

![Codex Account Manager account cards with synthetic demo accounts](docs/images/account-dashboard.png)

> [!IMPORTANT]
> The current Windows x64 release is a prerelease and is not code-signed.
> Windows SmartScreen may show an unknown-publisher warning. Download builds
> only from this repository and verify their SHA-256 checksum.

## Why this project

Codex Account Manager is deliberately focused: make multiple Codex accounts
easy to inspect and safe to switch.

| Capability | What it does |
| --- | --- |
| Quota on every card | Shows the 5-hour and weekly windows with reset times |
| Background sync | Refreshes missing or stale quota data without removing manual control |
| One-click switching | Updates local Codex auth state and restarts the official Codex app |
| Token health | Shows expiry state and refreshes one or all saved accounts |
| Automatic switching | Uses local thresholds, account scope, and a local daemon |
| Account maintenance | OAuth add, delete, subscription refresh, and reset-credit controls |
| Local-first storage | Runs without a project-operated cloud service or token sync |

The app does not create, bypass, or modify account limits. Automatic switching
only selects among accounts that you explicitly saved.

## Install

### Requirements

- Windows 10 or Windows 11, x64
- The official Codex app from the Microsoft Store
- Network access to OpenAI OAuth, ChatGPT, and GitHub Releases

### Download and first run

1. Open [GitHub Releases](https://github.com/3xiaoshayu/codex-account-manager/releases).
2. Download `Codex.Account.Manager-Setup-<version>-x64.exe` from the newest release.
3. Install and launch the app.
4. Select **Add account** and complete OAuth in your browser.
5. Return to the app and confirm the account card, quota, and active-account state.

The ZIP asset can run without installation, but application data is still
stored in the Windows user profile; it is not a fully portable build.
The Setup executable is recommended for most users.

Beta releases update manually. Future stable versions without a prerelease
suffix will download updates in the background and ask before restarting.

### Verify a download

Each release includes `SHA256SUMS.txt`:

```powershell
Get-FileHash ".\Codex.Account.Manager-Setup-<version>-x64.exe" -Algorithm SHA256
```

Compare the output with the matching line in `SHA256SUMS.txt`.

## Data and privacy

- Manager data lives under `%USERPROFILE%\.codex-switch`.
- OAuth tokens are encrypted with Windows DPAPI and can only be decrypted by
  the same Windows login.
- The active Codex identity is written to `%USERPROFILE%\.codex\auth.json`.
- Account switching first preserves `%USERPROFILE%\.codex\auth.json.bak`.
- The app contains no telemetry, advertising, or project-operated account-sync service.
- OAuth, token refresh, quota, subscription, and update checks contact the
  relevant OpenAI, ChatGPT, and GitHub services.

DPAPI does not protect against malware or an administrator that already
controls the current Windows user session. See [Privacy](docs/privacy.md) for
the full data inventory, network behavior, and uninstall notes.

> [!WARNING]
> Switching accounts stops running `Codex.exe` and associated `node_repl.exe`
> processes, writes the new authentication state, and restarts Codex. Let
> active work finish before switching.

## How it works

1. After OAuth, account metadata and DPAPI-encrypted tokens are stored locally.
2. Quota sync uses that account's local auth state to read 5-hour and weekly windows.
3. A switch backs up and atomically replaces Codex's `auth.json`.
4. The local auto-switch daemon evaluates configured thresholds and uses the
   same switch path when a change is required.

Quota and reset-credit data depend on authenticated ChatGPT backend endpoints.
Those endpoints can change. When a read fails, the app keeps an explicit error
state instead of presenting missing data as zero quota.

See [Architecture](docs/architecture.md) for module boundaries and data flow.

## Run from source

Node.js 20 or newer is required.

```powershell
git clone https://github.com/3xiaoshayu/codex-account-manager.git
cd codex-account-manager
npm ci
npm run check
npm start
```

Build an unpacked Windows application:

```powershell
npm run build:dir
```

Build the NSIS installer and ZIP:

```powershell
npm run build:windows
```

If an electron-builder helper download times out:

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run build:windows
```

## Documentation

- [Architecture](docs/architecture.md)
- [Privacy](docs/privacy.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Release process](docs/releasing.md)
- [Changelog](CHANGELOG.md)
- [Support](SUPPORT.md)

## Project status

The current build supports Windows x64 and the official Microsoft Store Codex
app only. Prereleases may change local storage migrations, endpoint parsing,
and automatic-switching policy.

## Responsibility and trademarks

This is an independent community project. It is not affiliated with,
authorized by, or endorsed by OpenAI. OpenAI, Codex, and ChatGPT are
trademarks of their respective owners.

Only manage accounts that you own or are explicitly authorized to use, and
follow applicable service terms and organization policies. Production or
commercial API workloads should use the OpenAI Platform API rather than
account rotation through this application.

## License

Source code is available under the [MIT License](LICENSE). The Mount Fuji
background has a separate distribution license and is not covered by MIT;
see [ASSET_LICENSE.md](ASSET_LICENSE.md). Third-party notices are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

All emails, quota values, and dates in repository screenshots are synthetic.

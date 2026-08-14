<div align="center">

# Codex Account Manager

A local-first Windows manager for Codex accounts: quotas at a glance, one-click
switching, close-to-tray, and a desktop quota lens. Nothing leaves your machine.

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
> This is a prerelease and the installer is not code-signed yet, so Windows
> SmartScreen may warn about an unknown publisher. Only download builds from
> this repository's Releases page and check the SHA-256.

## What this is

If you keep more than one Codex account around, you know the drill: log into
each one just to see what's left of the quota, then hand-edit the auth file
and restart Codex whenever you want to switch. With a few accounts, that gets
old fast.

This app tidies that up. It does not (and cannot) change any account's limits.
Automatic switching only picks among the accounts you saved.

## Features

**Account cards.** One card per account, with the 5-hour window, weekly window,
reset times, and token lifetime right on it. Search by email or plan, and filter
All / Current / Needs attention. **Add account** runs browser OAuth. From a card
you can refresh quota, switch to that identity, reauthorize, or delete it.
A switch stops Codex, backs up and replaces `auth.json`, then relaunches the
official client.

**Quota overview.** Every saved account on one page. Remaining quota is colored
roughly green above 55%, yellow through 25%, and red below that. A failed read
shows as unknown, never as zero.

**Automatic switching.** A local daemon rotates to the next usable account when
your 5-hour or weekly threshold is hit. The pool can be every account or only
the ones you tick. **Check now** inspects quotas without switching if the global
toggle is off. Closing the main window does not stop the daemon.

**Close to tray.** The title-bar close button hides the window; it does not quit.
Left-click the tray icon, or choose **Open window**, to bring it back. The only
way to exit is **Exit** on the tray menu.

**Desktop quota lens.** A separate compact window: two vertical rings, with the
tighter remaining window in the middle. Page through other accounts (preview
uses a dashed ring), pin it on top, refresh, or switch from the lens itself.
Open it from the tray item **Open desktop quota**, or from **Settings**.

**Settings.** Start or stop the daemon, change the check interval, re-detect the
Microsoft Store Codex app, batch-check tokens, open the quota lens, and see the
update channel. Betas update manually; **Open release page** goes to GitHub
Releases.

**Login and encryption.** After you sign in to the manager, it reads the local
account store. OAuth tokens are encrypted with Windows DPAPI, so only your
Windows login can decrypt them. No telemetry, no ads, no cloud service of ours.

**Installer.** The setup wizard uses this project's sidebar and header art, not
the default NSIS chrome.

**Official-login conflicts.** If the official Codex login is not the identity
the manager currently has selected, a banner appears. You can adopt the official
account or write the managed one back. Finish in-flight Codex work before you
switch.

## A quick look

<table>
  <tr>
    <td align="center"><sub><b>Quota overview</b></sub></td>
    <td align="center"><sub><b>Automatic switching</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/quota-overview.png" alt="Quota overview across all accounts" /></td>
    <td><img src="docs/images/auto-switch.png" alt="Automatic switching thresholds and account scope" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Settings</b></sub></td>
    <td align="center"><sub><b>Login</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/settings.png" alt="Settings with daemon, desktop quota, and update channel" /></td>
    <td><img src="docs/images/login.png" alt="Login screen with the DPAPI protection note" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Desktop quota lens</b></sub></td>
    <td align="center"><sub><b>Tray menu</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/float-lens.png" alt="Desktop quota lens showing the current account and a preview account" /></td>
    <td><img src="docs/images/tray-menu.png" alt="Tray menu: Open window, Open desktop quota, Exit" /></td>
  </tr>
</table>

All screenshots use synthetic demo data.

## Install

You'll need Windows 10 or 11 (x64) and the official Codex app from the
Microsoft Store.

1. Grab the latest `Codex-Account-Manager-Setup-<version>-x64.exe` from [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases)
2. Install and launch it
3. Click **Add account** and finish the OAuth login in your browser
4. Back in the app, your account card and quota should be there

The ZIP runs without installing, but app data still lives in your user
profile, so it isn't truly portable — the installer is the way to go for most
people. Betas update manually; stable releases will update in the background.

### Verifying a download

Every release ships with a `SHA256SUMS.txt`. In PowerShell:

```powershell
Get-FileHash ".\Codex-Account-Manager-Setup-<version>-x64.exe" -Algorithm SHA256
```

If the output matches the corresponding line in `SHA256SUMS.txt`, you're good.

## Where your data lives

- The manager keeps its own data under `%USERPROFILE%\.codex-switch`
- OAuth tokens are encrypted with Windows DPAPI, so only your Windows login can decrypt them
- Switching writes `%USERPROFILE%\.codex\auth.json`, saving an `auth.json.bak` first
- No telemetry, no ads, no cloud service of any kind — your account list and tokens never leave your machine
- The only network calls go to OpenAI / ChatGPT (OAuth, token refresh, quota reads) and GitHub (update checks)

One caveat: DPAPI won't protect you from malware or an admin that already
controls your Windows session. The full data inventory, network behavior, and
uninstall notes are in [Privacy](docs/privacy.md).

> [!WARNING]
> Switching stops the running Codex process tree and restarts it. Let any
> in-flight work finish before you switch.

## How it works

Nothing fancy: after OAuth, account metadata and encrypted tokens are stored
locally. Quota reads use each account's own credentials. A switch backs up and
atomically replaces Codex's `auth.json`, then relaunches the official client.
The auto-switch daemon evaluates your thresholds locally and goes through the
exact same switch path. After the main window is hidden to the tray, the daemon
and the desktop quota lens can keep running.

Quota data comes from ChatGPT backend endpoints, which can change upstream at
any time. When a read fails, the UI shows an explicit error instead of
dressing up missing data as zero quota.

Module boundaries and data flow are covered in [Architecture](docs/architecture.md).

## Running from source

Node.js 22 or newer (CI and release builds use 24 LTS):

```powershell
git clone https://github.com/3xiaoshayu/codex-account-manager.git
cd codex-account-manager
npm ci
npm test
npm start
```

Package with `npm run build:dir` (unpacked directory) or
`npm run build:windows` (NSIS installer + ZIP).

If an electron-builder helper download times out, set a mirror first:

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run build:windows
```

## More docs

[Architecture](docs/architecture.md) ·
[Privacy](docs/privacy.md) ·
[Troubleshooting](docs/troubleshooting.md) ·
[Contributing](CONTRIBUTING.md) ·
[Security policy](SECURITY.md) ·
[Release process](docs/releasing.md) ·
[Changelog](CHANGELOG.md) ·
[Support](SUPPORT.md)

## The fine print

This is an independent community project with no affiliation, authorization,
or endorsement from OpenAI. OpenAI, Codex, and ChatGPT are trademarks of their
respective owners.

Only manage accounts you own or are explicitly authorized to use, and follow
the applicable terms of service and organization policies. If you're running
production or commercial API workloads, use the OpenAI Platform API — account
rotation is not the answer there.

Right now this supports Windows x64 with the official Microsoft Store Codex
only. While in prerelease, local storage formats, endpoint parsing, and the
auto-switch policy may still change. Please skim
[Troubleshooting](docs/troubleshooting.md) before filing an issue.

## License

The code is [MIT](LICENSE). Application icon and installer artwork are covered
by [ASSET_LICENSE.md](ASSET_LICENSE.md). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Every email, quota figure, and date in the screenshots is made up.

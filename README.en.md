<div align="center">

# Codex Account Manager

Juggling multiple Codex accounts on Windows? See every quota at a glance and switch identities in one click.

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

This app tidies all of that up:

- One card per account, with the 5-hour window, weekly window, and reset times right on it
- One-click switching — it stops Codex, writes the new auth state, and restarts the client for you
- Tokens refresh before they expire; you can also refresh one account or all of them by hand
- Once an account hits the threshold you set, a local daemon can rotate to the next usable one
- Everything stays on your machine, with tokens encrypted via Windows DPAPI

To be clear: it does not (and cannot) change any account's limits. Automatic
switching just picks among the accounts you saved. That's all it does.

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
exact same switch path.

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

The code is [MIT](LICENSE). Background images keep their original third-party
licenses — see [ASSET_LICENSE.md](ASSET_LICENSE.md) — and third-party notices
are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Every email, quota figure, and date in the screenshots is made up.

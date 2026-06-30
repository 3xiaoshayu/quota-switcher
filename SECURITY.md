# Security Policy

Codex Account Manager handles OAuth credentials and modifies the local Codex
authentication state. Security reports are treated as a priority.

## Supported versions

| Version | Security fixes |
| --- | --- |
| Latest stable release | Supported |
| Latest prerelease | Supported during beta |
| Older releases | Not supported |

## Report a vulnerability

Use
[GitHub private vulnerability reporting](https://github.com/3xiaoshayu/codex-account-manager/security/advisories/new).

Do not open a public issue for:

- exposed or recoverable tokens;
- OAuth callback or state validation problems;
- arbitrary file access or command execution;
- unsafe update delivery;
- credential migration or DPAPI failures;
- account switching that can corrupt unrelated local data.

Include the affected version, Windows version, reproduction steps, impact, and
the smallest redacted proof needed to understand the issue. Do not send a real
token or complete authentication file.

The maintainers will acknowledge a valid report as soon as practical, keep
discussion private while a fix is prepared, and credit the reporter when
requested and appropriate.

## Sensitive local files

- `%USERPROFILE%\.codex-switch` contains encrypted account credentials and configuration.
- `%USERPROFILE%\.codex\auth.json` contains the active Codex credential state.
- `%USERPROFILE%\.codex\auth.json.bak` may contain the previous credential state.

Never attach these files or directories to an issue. Remove email addresses,
account identifiers, callback URLs, and authorization headers from screenshots
and logs.

## Security boundaries

- Saved manager tokens are encrypted with Windows DPAPI.
- The active Codex `auth.json` remains readable by Codex.
- DPAPI does not protect against code already running as the same Windows user
  or against a machine administrator.
- The application relies on upstream OpenAI, ChatGPT, GitHub, Electron, and
  Windows security properties.
- Unsigned prerelease installers can trigger SmartScreen and must be verified
  against the release checksum.

See [docs/privacy.md](docs/privacy.md) for the complete local data and network
behavior description.

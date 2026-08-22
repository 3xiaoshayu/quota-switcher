# Security Policy

[简体中文](SECURITY.md)

Quota Switcher handles OAuth credentials and modifies the local Codex,
Cursor, and Antigravity authentication state. Security reports are treated as
a priority.

## Supported versions

| Version | Security fixes |
| --- | --- |
| Latest stable release | Supported |
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
- `%APPDATA%\Cursor\User\globalStorage\state.vscdb` contains the official Cursor login.
- `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` contains the official Antigravity login.

Never attach these files or directories to an issue. Redact emails in
screenshots. Strip callback URLs, tokens, and authorization headers from logs.

## Security boundaries

- Saved manager tokens are encrypted with Windows DPAPI.
- The active Codex `auth.json` remains readable by Codex.
- The official Cursor `state.vscdb` remains readable by Cursor.
- DPAPI does not protect against code already running as the same Windows user
  or against a machine administrator.
- The application relies on upstream OpenAI, ChatGPT, Cursor, GitHub, Electron,
  and Windows security properties.
- Unsigned installers can trigger SmartScreen and must be verified against the
  release checksum.

See [docs/privacy.md](docs/privacy.md) (Chinese) or
[docs/privacy.en.md](docs/privacy.en.md) for local data and network behavior.

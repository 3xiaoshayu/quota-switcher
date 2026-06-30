# Security Policy

## Supported Versions

Only the latest release receives security fixes during the private beta.

## Reporting a Vulnerability

Do not open a public issue containing tokens, account identifiers, logs, or
authentication files. Report vulnerabilities privately through GitHub's
security advisory feature for this repository.

## Sensitive Local Files

- `%USERPROFILE%\.codex-switch` contains encrypted account credentials and local configuration.
- `%USERPROFILE%\.codex\auth.json` contains the active Codex credential state.

Never attach either directory to an issue. Remove tokens and personal data from
screenshots and logs before sharing them.

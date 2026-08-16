# Support

## Usage and bug reports

Use the repository's issue forms for reproducible bugs and focused feature
requests:

- [Report a bug](https://github.com/3xiaoshayu/codex-account-manager/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/3xiaoshayu/codex-account-manager/issues/new?template=feature_request.yml)

Before opening an issue:

1. update to the newest release;
2. read [Troubleshooting](docs/troubleshooting.md);
3. say whether the issue is Codex, Cursor, or both;
4. confirm the matching official client is installed when the issue depends on
   switching or local import;
5. do not attach tokens, auth files, or OAuth callback URLs. Emails in
   screenshots are fine.

This community project is maintained on a best-effort basis and does not
provide guaranteed response times.

## Security

Do not use a public issue for suspected vulnerabilities or credential
exposure. Follow [SECURITY.md](SECURITY.md) and use
[private vulnerability reporting](https://github.com/3xiaoshayu/codex-account-manager/security/advisories/new).

## What not to share

Never upload:

- `%USERPROFILE%\.codex-switch`;
- `%USERPROFILE%\.codex\auth.json` or `auth.json.bak`;
- `%APPDATA%\Cursor\User\globalStorage\state.vscdb` or its WAL/SHM files;
- OAuth callback URLs;
- access, ID, or refresh tokens;
- logs containing authorization headers.

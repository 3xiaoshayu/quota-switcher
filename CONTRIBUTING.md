# Contributing

Contributions are welcome when they keep the project focused, local-first, and
safe around authentication data.

## Before opening a pull request

- Search existing issues and pull requests.
- Keep changes narrow and explain the user workflow they improve.
- Open an issue first for storage migrations, OAuth changes, switching
  behavior, new network destinations, or large UI restructuring.
- Never include real accounts, tokens, callback URLs, logs, or screenshots
  containing personal information.

Security vulnerabilities must be reported through
[private vulnerability reporting](https://github.com/3xiaoshayu/codex-account-manager/security/advisories/new),
not a public issue.

## Development setup

Requirements:

- Windows 10 or 11 x64;
- Node.js 20 or newer;
- the official Microsoft Store Codex app for integration checks.

```powershell
git clone https://github.com/3xiaoshayu/codex-account-manager.git
cd codex-account-manager
npm ci
npm run check
npm start
```

`npm run check` performs JavaScript syntax checks, renderer/preload/IPC contract
validation, and release metadata validation.

## Project conventions

- Follow the existing CommonJS and plain JavaScript style.
- Keep the renderer isolated from Node.js and privileged filesystem access.
- Add IPC operations through the renderer, preload, and main handler contract.
- Use structured JSON APIs instead of editing authentication data with string
  replacement.
- Preserve atomic writes and existing backups around credential state.
- Do not log tokens, authorization headers, OAuth callbacks, or complete
  account objects.
- Keep screenshots and fixtures synthetic.
- Treat missing quota windows as unknown, not zero.
- Keep new dependencies limited and explain why they are required.

## Verification

Run before submitting:

```powershell
npm run check
npm run build:dir
```

For UI changes, also verify:

- desktop and narrow window sizes;
- keyboard focus, hover, pressed, disabled, busy, success, and failure states;
- current, attention, expired-token, and missing-quota accounts;
- no horizontal overflow or clipped action controls.

Actions that switch a real account, delete data, or consume a reset credit
should be tested only with dedicated test accounts.

## Pull requests

Include:

- a concise description of the behavior change;
- the reason for the change;
- commands and manual scenarios used for verification;
- synthetic screenshots for visible UI changes;
- migration or rollback notes when local data changes.

By contributing, you agree that your contribution is licensed under the
project's MIT License. Do not submit assets or code that you do not have the
right to redistribute.

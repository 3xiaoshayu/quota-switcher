# Contributing

[简体中文](CONTRIBUTING.md)

The product is feature-complete. Serious bugs, documentation, and translations
are welcome. Do not open a pull request for a large UI redesign or a new
product tab without an issue first.

Keep the project local-first and safe around authentication data.

## Before opening a pull request

- Search existing issues and pull requests.
- Keep changes narrow and explain the user workflow they improve.
- Open an issue first for storage migrations, OAuth changes, switching
  behavior, new network destinations, a new product tab, or large UI
  restructuring.
- Never include tokens, callback URLs, account files, or raw logs.

Security vulnerabilities must be reported through
[private vulnerability reporting](https://github.com/3xiaoshayu/quota-switcher/security/advisories/new),
not a public issue.

## Development setup

Requirements:

- Windows 10 or 11 x64;
- Node.js 22 or newer;
- the official Microsoft Store Codex app for Codex integration checks;
- official Cursor for Cursor integration checks.

```powershell
git clone https://github.com/3xiaoshayu/quota-switcher.git
cd quota-switcher
npm ci
npm test
npm start
```

`npm test` runs the engine behavior suite, TypeScript checks, JavaScript syntax
checks, renderer/preload/IPC contract validation, documentation checks, and
release metadata validation. `npm run test:e2e` starts the real app against a
throw-away data directory (your accounts and official login databases are not
touched) and drives the sidebar, the three pages, and the dialogs over the
DevTools Protocol, once with an empty store and once with seeded fake accounts
whose quota calls are answered by a local stub server instead of the real
services.

## Project conventions

- Follow the existing CommonJS and plain JavaScript style.
- Keep the renderer isolated from Node.js and privileged filesystem access.
- Add IPC operations through the renderer, preload, and main handler contract.
- Use structured JSON APIs instead of editing authentication data with string
  replacement.
- Preserve atomic writes and existing backups around credential state.
- Do not log tokens, authorization headers, OAuth callbacks, or complete
  account objects.
- Keep fixtures free of tokens. Live screenshots may show account emails.
- Treat missing quota windows as unknown, not zero.
- Keep Codex and Cursor storage, OAuth, and switch paths separate. Do not scan
  one product's files as the other.
- Cursor must not use Codex ban status. Switching stays a user action; do not
  add background account switching for any product.
- Keep new dependencies limited and explain why they are required.

## Verification

Run before submitting:

```powershell
npm test
npm run test:e2e
npm run build:dir
```

For UI changes, also verify:

- desktop and narrow window sizes;
- keyboard focus, hover, pressed, disabled, busy, success, and failure states;
- current, attention, expired-token, and missing-quota accounts;
- both the Codex and Cursor sidebar products;
- no horizontal overflow or clipped action controls.

Actions that switch a real account or delete data should be tested only with
dedicated test accounts.

## Pull requests

Include:

- a concise description of the behavior change;
- the reason for the change;
- commands and manual scenarios used for verification;
- screenshots for visible UI changes;
- migration or rollback notes when local data changes.

By contributing, you agree that your contribution is licensed under the
project's MIT License. Do not submit assets or code that you do not have the
right to redistribute.

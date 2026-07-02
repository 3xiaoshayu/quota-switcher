# Changelog

All notable changes to Codex Account Manager are documented here.

The project follows [Semantic Versioning](https://semver.org/) once a stable
release is published.

## [Unreleased]

No unreleased changes.

## [0.1.0-beta.9] - 2026-07-02

- Prevent Microsoft Store activation exit codes from causing false switch
  rollbacks, and move switch waiting and process control off blocking sleeps.
- Treat official token rotation for the same identity as a safe synchronization
  instead of an external-account conflict.
- Repair invalidated quota access tokens once before retrying usage requests,
  while preserving retry backoff for automatic UI synchronization.
- Serialize auto-switch configuration writes and add busy-state guards to
  destructive or long-running account controls.
- Correct quota-window labels, account-plan summaries, daemon timestamps,
  attention counts, and beta update behavior in the renderer.

## [0.1.0-beta.8] - 2026-07-01

- Detect official Codex authentication changes and require an explicit adopt or
  reapply decision before managed credentials can be written again.
- Make account switching transactional with exact process targeting, atomic
  writes, launch verification, and rollback on failure.
- Recover damaged account indexes and JSON records from backups while
  preserving undecryptable DPAPI records for diagnosis.
- Preserve missing quota windows as unknown, clamp percentages, clear stale
  reset-credit balances, and stop automatic switching after refresh failures.
- Persist pending OAuth sessions across restarts, support cancellation and
  manual callback completion, and prevent reauthorization identity mismatches
  from overwriting an existing account.
- Add redacted three-day diagnostic logs, structured daemon status, and
  reliability behavior tests for storage, OAuth, switching, quota, and auth
  conflict handling.

## [0.1.0-beta.7] - 2026-07-01

- Add a second token-exchange network path and a single transient retry for
  OAuth account additions.
- Show clearer diagnostics when browser authorization succeeds but token
  exchange fails.
- Keep the add-account modal locked while OAuth is in progress so the pending
  request cannot be dismissed accidentally.

## [0.1.0-beta.6] - 2026-07-01

- Route API requests through Electron's network stack first so system proxy,
  VPN, and TUN-mode environments behave closer to the installed app.
- Keep the Node HTTP stack as a fallback when Electron networking is not
  available.

## [0.1.0-beta.5] - 2026-07-01

- Connect the redesigned renderer to desktop account, quota, token, subscription,
  update, daemon, and external-link services.
- Make the sync interval configurable and reload the daemon timer after changes.
- Fix fake or wrongly disabled UI entries, including reset-credit menus,
  subscription refresh, update install gating, and external documentation links.
- Add static UI contract checks for renderer APIs and IPC handlers.

## [0.1.0-beta.4] - 2026-06-30

- Follow the active system or environment proxy for quota and token requests.
- Treat manual token refresh as a login check and avoid unnecessary OAuth calls.
- Keep all account actions on the card and remove the duplicate detail page.
- Show reset-credit controls only when an account has a consumable credit.
- Adopt the new transparent, multi-resolution Windows application icon.

## [0.1.0-beta.3] - 2026-06-30

- Reorganize the repository for public open-source release.
- Add synthetic product screenshots and complete install, privacy, security,
  architecture, troubleshooting, contribution, and release documentation.
- Remove an unused legacy renderer implementation and local-only IPC test page.
- Make the Windows development launcher independent of a local filesystem path.

## [0.1.0-beta.2] - 2026-06-30

- Show fixed 5-hour and weekly quota rows directly on every account card.
- Automatically synchronize stale or missing quota data in the background.
- Keep account cards focused on daily actions without requiring detail-page navigation.
- Adopt the bundled Windows application icon for installers and shortcuts.

## [0.1.0-beta.1] - 2026-06-30

- Private Windows beta packaging.
- DPAPI protection for stored OAuth tokens.
- Codex installation diagnostics.
- GitHub Release automation and update preparation.

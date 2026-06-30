# Changelog

All notable changes to Codex Account Manager are documented here.

The project follows [Semantic Versioning](https://semver.org/) once a stable
release is published.

## [Unreleased]

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

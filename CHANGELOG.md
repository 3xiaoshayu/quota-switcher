# Changelog

All notable changes to Codex Account Manager are documented here.

The project follows [Semantic Versioning](https://semver.org/) once a stable
release is published.

## [0.1.0-beta.22] - 2026-08-16

- Fix the desktop quota lens: it crashed on first paint, then hid behind the
  main window. Opening it now pins the widget so it stays visible.
- Stop the first screen from waiting on Codex detection, and copy the app icon
  into packaged extraResources so the window and tray show the mark.
- Keep quota refresh, authorization, and error toasts in short Chinese, and do
  not report a successful refresh when the quota still failed to sync.

## [0.1.0-beta.21] - 2026-08-15

- Close the main window to the tray so auto-switch keeps running; quit only
  from the tray menu.
- Add a desktop quota lens: a compact Codex ring for remaining usage, with
  account paging, pin, refresh, and switch without opening the main window.

## [0.1.0-beta.20] - 2026-08-15

- Replace the default NSIS wizard chrome with branded sidebar and header art,
  a welcome/finish flow, and plain-language install copy.
- Color quota bars green at 55% remaining, yellow through 25%, and red below
  that; token lifetime uses a quiet gray bar instead of the accent blue.
- Drop the empty red-alert placeholder on account cards, and use an @ mark
  instead of the two-person glyph for account navigation.

## [0.1.0-beta.19] - 2026-08-15

- Fix the Windows installer script so the setup executable actually builds.

## [0.1.0-beta.18] - 2026-08-15

- Cut transparent rounded corners into the app icon so the desktop, taskbar,
  and installer show a squircle instead of a sharp black square.
- Show the install-folder page even when upgrading an existing copy.

## [0.1.0-beta.17] - 2026-08-14

- Redraw the app icon as a restrained cyan-to-violet twisted loop on a black
  squircle. The same mark is used for the window, taskbar, installer, sidebar,
  and login screen; the letter C and chip glyph are gone.
- Open the OAuth page through the system HTTPS handler instead of explorer.exe,
  which was dropping the query string. Callback pages and in-app errors are in
  Chinese.
- Treat ChatGPT.exe as the official Codex GUI, close it through the window
  first, and fail a switch if a crash-recovery window appears instead of a
  working session.
- Keep "check now" from switching accounts when the global auto-switch toggle
  is off.
- Clarify auto-switch and settings copy, and send Beta's "Open release page"
  to GitHub Releases. Official-login conflicts use a quiet banner instead of
  blocking the whole window.

## [0.1.0-beta.16] - 2026-08-12

A full visual redesign following Apple's dark-mode design language.

- Replace the photographic wallpapers with flat Apple-style surface layering
  (a near-black base, hairline-ringed cards, and a faint top light); the
  bundled Unsplash backgrounds are gone entirely.
- Restrain the palette to Apple system colors: one blue accent plus
  green/orange/red reserved for status. Quota numerals render white with
  thin flat progress bars carrying the state color; the loud gradients,
  glows, and heavy shadows are removed.
- Replace uppercase tracked labels and colored status pills with
  normal-case 12-13px captions and quiet dot-plus-text status indicators
  in Chinese.
- Rebuild the sidebar as a macOS source list (gray selection block, accent
  icons, no indicator bar), tighten the header, and switch avatars to
  circular low-saturation tints.
- Rework the login screen around a filled accent button and centered card;
  modals sit on opaque elevated surfaces with a calm dimming layer.
- Refresh the README gallery with the redesigned interface.

## [0.1.0-beta.15] - 2026-08-12

- Redesign the application icon: a glossy cyan-to-violet twisted loop on a
  dark squircle replaces the busy light-background mark. The silhouette
  stays crisp at taskbar sizes and matches the app's dark glass interface.
- Ship only the Chinese and English Chromium locales instead of all 55
  (about 47 MB uncompressed), shrinking the installer accordingly.
- Load only the Latin subsets of the Inter typeface - Chinese text uses the
  system font stack anyway - cutting the bundled font payload from about
  1 MB to a seventh of that.
- Convert the wallpaper backgrounds to WebP (445 KB saved) for a faster
  first paint, and exclude a stale local directory from packaging.
- Speed up batch token checks by shortening the fixed pause between
  accounts, and scan the account store after the window is visible instead
  of before it opens.

## [0.1.0-beta.14] - 2026-08-12

A five-angle audit of the whole codebase (auth and token flows, storage and
the switch transaction, quota and auto-switching, the main process and IPC,
and the renderer) surfaced 57 findings. This release fixes everything that
can lose data plus the correctness and interaction issues behind them.

Data safety:

- Never retry or replay the OAuth token refresh and code-exchange requests:
  after a timeout the server may already have rotated the refresh token, and
  replaying the old one killed healthy accounts with `refresh_token_reused`.
- Treat transiently locked files (antivirus, indexers) as retryable IO
  errors. They were previously handled as JSON corruption, which could
  quarantine a perfectly healthy account file forever and drop the current
  account from the index.
- Make account decoding a pure read. The legacy plaintext migration used to
  fire inside the backup recovery chain, copying the corrupt primary over
  the good backup; in the worst case the account's tokens were lost. The
  migration also stops leaving plaintext tokens in `.bak` files.
- Hold per-account locks in every write path: OAuth completion, adopting the
  official login, reapplying managed auth (which now also takes the switch
  transaction locks), official-token rotation sync, and the current-account
  sync after batch refreshes. A reauthorization finishing during an in-flight
  refresh could previously be overwritten by stale data and flagged
  requires_reauth again with the new refresh token lost.
- Discard out-of-order dashboard snapshots in the renderer so a slow older
  load can no longer overwrite newer state or silently revert configuration
  edits made in between.

Correctness:

- Carry fetch-time quota reset times through the cache correction introduced
  in beta.13; reset countdowns no longer drift on every read.
- The daemon leaves reauth-required current accounts alone (their self-heal
  marker used to be destroyed), no longer double-refreshes the current
  account every tick, and a retry backoff no longer counts as a failure or
  stalls automatic switching while fresh cached data is available.
- Enabling automatic switching now starts the daemon immediately instead of
  waiting for the next app restart.
- Startup failures show an error dialog and exit instead of leaving a
  windowless process holding the single-instance lock.
- Window state: the maximize flag survives closing from the taskbar while
  minimized, and restored positions are clamped to a reachable strip of a
  visible display.
- OAuth identity merging keeps known profile fields when new tokens carry
  thinner claims, and a mismatched reauthorization merges into an existing
  record for the same identity instead of duplicating the account.
- The switch transaction terminates orphaned helper processes, tolerates
  transient process-enumeration failures during launch verification instead
  of rolling back a switch that already succeeded, and locks the outgoing
  account so token rotation cannot be destroyed by a rollback.
- Auto-switch configuration recovery no longer resurrects stale backups
  after an intentional reset, validates backups before restoring them, and
  quarantines double corruption instead of silently reverting to defaults.

Interface:

- Accounts whose access token expired but whose refresh token still works
  keep their refresh affordances instead of being locked down as SUSPENDED.
- Notification timestamps use local time (they were UTC, eight hours off).
- Per-card refreshes track concurrency correctly, card menus close when
  clicking anywhere outside, OAuth waits no longer yank you back to the
  accounts tab on every sync, completions report exactly one toast, and a
  failed authorization keeps its error visible instead of closing the modal.
- Assorted polish: the "1h 60m" duration carry bug, the average-remaining
  stat shows `--` without data, Escape no longer operates overlays hidden
  under the auth-conflict dialog, and the remaining English copy in toasts,
  tooltips, and notification logs is localized.

The reliability suite grew from 40 to 48 tests.

## [0.1.0-beta.13] - 2026-08-12

- Classify quota windows by their duration instead of their position in the
  upstream response. OpenAI currently ships only the weekly window and places
  it in the primary slot, which the app previously mislabeled as the 5-hour
  quota - affecting both the account cards and automatic-switching decisions.
- Re-derive the classification for already-saved quota records from their raw
  payload, so existing caches display correctly without waiting for a sync.
- Keep the 5-hour quota row visible when upstream omits the window, showing
  an explicit "not currently provided" state instead of hiding the row or
  borrowing the weekly numbers.

## [0.1.0-beta.12] - 2026-08-12

- Track current upstream Codex client behavior: narrow OAuth scopes to
  `openid profile email offline_access`, send token refresh requests as
  form-encoded OAuth requests, and drop browser-imitation API headers.
- Migrate the account profile check to `backend-api/wham/accounts/check` and
  stop calling the retired subscriptions endpoint; a resolved account profile
  now counts as a successful subscription refresh even without an expiry.
- Read the newer `chatgpt_account_id` JWT claim and additional organization-id
  claim names so new tokens keep their `ChatGPT-Account-Id` header and stable
  account identity; merge re-added accounts into the existing record when the
  derived storage id changes.
- Honor the official `CODEX_HOME` environment variable when locating the Codex
  data directory.
- Recognize the official `agentIdentity` authentication format in `auth.json`
  and report it clearly instead of a generic unsupported message.
- Clear a stale missing-refresh-token reauthorization flag once a refresh
  token is available again, and treat invalidated-token error text as a
  reauthorization signal.
- Parse FastAPI-style `detail.code` error bodies and log `request-id`/`cf-ray`
  diagnostics when quota requests fail.
- Classify the upstream `invalid_refresh_token` error as a reauthorization
  signal so dead accounts stop retrying and surface the reauthorize action
  (found during live verification against the current API).
- Make tab switching smooth by rendering the dashboard backdrops as two
  persistent pre-decoded layers that cross-fade with GPU-composited opacity,
  keeping the exact same visuals.
- Retry atomic file swaps and transaction rollbacks when antivirus or indexer
  tools briefly lock the target file, treat the retired reset-credit endpoint
  as an absent feature in the daemon, cap the in-app notification feed, and
  clamp user-edited auto-switch thresholds into the valid percentage range.
- Remove the unused `lucide` runtime dependency, delete the orphaned
  `src/main/window.js`, correct dotted installer names in the English README,
  and ignore IDE project folders.
- Remove features whose upstream endpoints were retired: the reset-credit
  consumption flow and the manual subscription refresh (plan type now comes
  from quota responses automatically).
- Deduplicate UI entry points: the header refresh icon, the card menu's
  duplicate sync action, the footer Release Notes link, the redundant
  needs-action and daemon-status statistics, and the manual account re-read
  button.
- Replace decorative placeholders with real data: the token validity bar now
  shows the actual remaining lifetime, session switch events count real
  switches, and the quota header shows the true last sync time. The hardcoded
  online badge was removed.
- Adopt a frameless window with a custom dark title bar: the header is now a
  drag region with minimize/maximize/close controls, and the login screen has
  its own drag strip and close button.
- Replace the native delete confirmation with an in-app dialog, use
  letter-avatar gradients so every account is visually distinct, add empty
  states for the account and quota pages, and calm decorative animations.
- Unify the interface language: action buttons, labels, toasts, and log
  messages now use Chinese while status codes and technical terms stay in
  English; the sidebar navigation is simplified to single-line items and the
  login screen replaces the fake password field with a DPAPI protection note.
- Polish every surface: all dialogs and the notification drawer now animate
  out as well as in (with fading backdrops and a sliding drawer), account
  cards animate smoothly when filtered or refreshed, button radii and header
  action rhythm are consistent across pages, the header avatar joins the
  letter-avatar system, the session switch counter moved next to the daemon
  capsule, and the settings cards align naturally without fixed heights.
- Remember the window size, position, and maximize state across restarts,
  falling back to the centered default when the saved position is no longer
  on a visible display.
- Close the topmost overlay with the Escape key (delete confirmation,
  notification drawer, support and release dialogs, and the add-account
  modal outside OAuth waiting); the authentication conflict dialog still
  requires an explicit decision.

## [0.1.0-beta.11] - 2026-07-04

- Correct the in-app Release Notes dialog so it matches the latest verified
  token-validation and OAuth add-account fixes.
- Rebuild and republish the Windows installer after visual verification of the
  updated release dialog.

## [0.1.0-beta.10] - 2026-07-04

- Clarify batch token validation results by separating accounts that require
  reauthorization from real check failures.
- Remove misleading OAuth add-account plan and priority selectors while keeping
  the same modal layout and automatic account detection flow.
- Publish a refreshed Windows installer with the latest verified renderer build.

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

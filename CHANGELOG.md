# Changelog

All notable changes to Quota Switcher are documented here.

The project follows [Semantic Versioning](https://semver.org/) once a stable
release is published.

## Unreleased

## [2.0.11] - 2026-09-05

- The end-to-end smoke test now also runs against a store seeded with Codex,
  Cursor, and Antigravity accounts, with every upstream API answered by a
  local stub (`CODEX_MANAGER_API_ORIGIN`, unset in normal runs): account cards
  with quota bars, the "needs reauthorization" copy after a rejected refresh
  token, a manual refresh, the quotas page, and the quota lens with data are
  all exercised without real credentials or network.
- Electron 42 → 44 (Chromium 152, Node 24), taking two majors of Chromium and
  Node security fixes. `npm audit` is clean again: the `fast-uri` override was
  pinning a vulnerable release, and the remaining override pins are now
  same-major minimums so future audit fixes are not blocked.
- Build toolchain: Vite 8 (Rolldown) with `@vitejs/plugin-react` 6, and
  TypeScript 7 (the native compiler). TypeScript 7 no longer exposes the
  in-process `transpileModule` API, so the tests that load renderer modules
  into a `vm` sandbox now lower TypeScript with esbuild
  (`test/helpers/transpile-ts.js`); type checking is unchanged.
- Runtime: `proxy-agent` 6 → 8 and `proxy-from-env` 1 → 2 (both now ESM,
  loaded through Node 24's `require(esm)`; verified in the packaged asar build,
  which the smoke test can now drive via `E2E_APP_BINARY`).
- UI libraries: `lucide-react` 1.x (brand marks are gone from Lucide, so the
  GitHub button in Settings uses the external-link icon), `motion` 13,
  `@types/node` 26. The Vite config is now `vite.renderer.config.mts` so the
  upcoming native config loader reads it as ESM. Dependabot groups only minor
  and patch updates; majors come one per PR.

## [2.0.10] - 2026-09-05

- Every failure the engine raises now carries a stable code (`codedError`),
  including account-store, OAuth, switch, and network errors that used to be
  plain messages; a test fails the build if a bare `throw new Error` comes
  back. OAuth statuses, the daemon's last error and per-account failures, and a
  post-login switch error carry their codes too, so the window translates them
  by code and only falls back to message matching for string-only fields.
- Daemon failures are reported per account with their own copy instead of one
  joined English string.
- An end-to-end smoke test (`npm run test:e2e`) starts the real app in a
  sandbox and drives it over the DevTools Protocol, including the desktop
  quota lens; CI and the release workflow run it after the unit tests.
- Internal: the float lens's drawing rules (which dials to show, what the
  caption says, why refresh or switch is blocked) moved into
  `app/float-lens-model.ts` with behaviour tests. Tests that matched renderer
  source text were cut down to state-ownership invariants and hand-tuned
  visual values.

## [2.0.9] - 2026-09-05

- A switch no longer fails with "did not exit" when the operating system
  handed the closed app's process id to an unrelated program: after the exit
  wait, a PID that no longer belongs to an official process is ignored, and
  that unrelated program is never force-closed.
- The official-format check now also runs with every desktop snapshot (reused
  for a minute), so drift shows on first paint and after each daemon tick,
  not only after 重新检测. A banner above the content names the product,
  carries the reason, and links to the releases page; it can be dismissed for
  the session.
- Internal: `App.tsx` is now a composition root (about 760 lines, down from
  2200). The desktop snapshot loader, the browser-authorization flow, the
  main-process event subscription, and every account action live in
  `src/renderer-react/app/` as hooks, with the decision logic they use
  (snapshot merging, load ordering, OAuth outcome planning) as pure modules
  covered by behaviour tests. Behaviour is unchanged.
- Internal: tests that used to match the shape of `App.tsx` source now read
  the whole renderer logic or test the extracted modules directly, so moving
  code between files no longer breaks them.

## [2.0.8] - 2026-09-05

- Remove Codex automatic switching: the sidebar page, the thresholds and
  account scope, the daemon's switch step, and the `autoswitch:*` IPC
  channels are gone. Every switch is a user action now. The background
  worker keeps renewing Codex logins and refreshing quotas; its on/off switch
  and interval stay in `auto-switch.json` under the historical file name, so
  an upgrade keeps the user's interval.
- Login-state banner copy says which background work paused instead of
  referring to the removed feature.
- Errors keep a stable code from the engine all the way to the window. IPC
  failures answer `{ success: false, error, code }`, the renderer raises a
  `DesktopError` with that code, and user-facing copy is chosen by code
  first (`CODE_MESSAGES`) with message matching only as the fallback. A test
  keeps the copy table in step with every code the engine produces.
- Settings warns when an official client changed its login format: the
  status checks now inspect Codex `auth.json`, Cursor `state.vscdb` keys,
  and the Antigravity OAuth item, and report "登录格式变了" before a switch
  would fail on it. Read-only; a locked or missing file is never reported as
  drift.
- A render error shows an in-window crash screen with a reload button
  instead of a blank window.
- Internal: the toast/activity feed, the settings derivation, and the
  daemon-config save sequencing moved out of `App.tsx` into `app/` with
  behaviour tests; toast timers are cleared on unmount.

## [2.0.7] - 2026-09-05

- Stop sending the ChatGPT, Cursor, or Google bearer along when a quota or
  token request is redirected to another host, and never follow a redirect
  from https to plain http. POST bodies now carry an exact Content-Length.
- Remember a "no proxy" discovery for 30 seconds per host, so a PC without a
  local proxy no longer re-reads the registry, DNS, PAC, and ten local ports
  on every quota request.
- A 401/403 whose body is a web page (Cloudflare challenge, proxy block page)
  is a temporary miss for Cursor and Antigravity quota and token refresh, not
  a lost login.
- After a Cursor or Antigravity switch rolls back, the official IDE is
  relaunched on the previous login instead of staying closed.
- A dropped network round while the Cursor browser login is still open no
  longer aborts the whole authorization.
- A failed Store Codex detection is only remembered for five seconds so the
  next switch re-checks instead of failing for a minute.
- The Antigravity Hub credential payload is handed to PowerShell through the
  environment; no plaintext token file is written to %TEMP% any more. The
  IDE build no longer spawns the Credential Manager read on every sync.
- The daemon no longer rewrites official `auth.json` every minute when the
  vault already holds the same tokens.
- Log retention is pruned on date rollover, not only at startup.
- Window fixes: the 官方登录了另一个账号 toast shows the right copy for the
  raw `conflict` status; a lock-busy daemon tick cannot hide a real conflict
  banner or lift the quota auto-sync gate; refresh and reauth feedback reads
  the fresher snapshot instead of "列表还在更新"; one browser authorization
  guard covers all three products; the desktop lens keeps its 60-second
  silent refresh cadence across list updates; an in-flight auto-switch config
  save is not reverted by an older snapshot.
- `playwright-core` is a dev dependency again and the lockfile is back in
  sync, so `npm ci` works on a fresh clone.
- The installer is still unsigned. Download only from GitHub Releases and
  check SHA-256.

## [2.0.6] - 2026-08-22

- Treat temporary quota and token misses (timeouts, proxy 5xx, empty or HTML
  token bodies, and usage 429 rate_limit) as leftover login instead of asking
  to reauthorize or marking quota used up.
- Fail over a hung or gateway-error proxy, a truncated body, and an Antigravity
  Cloud Code host 500, and honor Retry-After plus x-ratelimit-reset duration
  headers.
- Keep leftover quota visible after a temporary miss. Codex auto-switch does
  not leave the current account just because usage returned 429 rate_limit.
- Pin Dependabot-related overrides so production audit stays clean. The
  installer is still unsigned. Download only from GitHub Releases and check
  SHA-256.

## [2.0.5] - 2026-08-22

- Keep the official-login banner and toasts honest: leftover file locks are
  not a conflict, and switch or daemon failures stay in Chinese.
- After a successful Codex or Antigravity write, do not roll the login back
  just because the follow-up read is locked. A real mismatch still rolls back.
- Codex auto-switch only leaves when quota is strictly below the threshold,
  skips accounts with no access token, and does not treat a leftover lock as a
  background-check failure.
- Check-now and the daemon apply the post-switch login state and current
  badge. First add or import does not invent a current account.
- The installer is still unsigned. Download only from GitHub Releases and
  check SHA-256.

## [2.0.4] - 2026-08-21

- Show Cursor Ultra and Pro+, Codex Business and Edu, and Antigravity Pro on
  account cards. Cursor organization `enterprise` stays Team; Antigravity
  `standard-tier` stays Free.
- Stop clipping the `g` in the Antigravity sidebar label.
- Keep current accounts, official logins, and in-progress OAuth when Windows
  reports a leftover lock or a non-JSON read error, instead of promoting a
  stale backup or deleting a live credential.
- Do not push older official Codex tokens over a fresher vault. Rebuild a
  missing index from the most recently used account so background refresh does
  not pause as a login conflict.
- The installer is still unsigned. Download only from GitHub Releases and
  check SHA-256.

## [2.0.3] - 2026-08-21

- Read the current Antigravity Hub Google OAuth client from the official
  language server instead of a withdrawn published client, so browser sign-in
  no longer fails with `invalid_client`. Token refresh can still retry the
  older published client once if Hub rejects it.
- Keep account files, indexes, OAuth pending state, and proxy settings
  readable through brief Windows locks and torn writes. Restore from backup
  only when the live file is corrupt, not when it was deleted.
- Bound quota HTTP to a wall-clock deadline so a slow drip of bytes cannot
  hang refresh forever.
- The installer is still unsigned. Download only from GitHub Releases and
  check SHA-256.

## [2.0.2] - 2026-08-20

- Keep the dashboard, current-account badge, and quota refresh correct when
  Windows briefly locks local files, and skip extra vault unlocks on those
  paths.
- Snapshot Codex after the official client closes, wait for Cursor and
  Antigravity databases to finish writing, then switch. If a later step fails,
  roll the whole switch back.
- Restart the background worker at most three times if it crashes, instead of
  looping forever.
- The installer is still unsigned. Download only from GitHub Releases and check
  SHA-256.

## [2.0.1] - 2026-08-20

- Remove the unused browser preview lock screen. The desktop app opens on the
  account and quota window.
- Spell out, in the GitHub intro, the Windows vault, Codex switch transaction,
  in-place Cursor/Antigravity login writes, and background Codex auto-switch
  relative to a general-purpose cockpit.

## [2.0.0] - 2026-08-20

Quota Switcher's first product release. The GitHub repo, Windows app id, and
`%USERPROFILE%\.codex-switch` data path are unchanged, so 1.0.x installs can
upgrade in place and keep their accounts.

- Ship the visible name Quota Switcher in the window, sidebar, installer,
  tray, and docs. Desktop and Start menu shortcuts pick up the new name after
  this Setup is installed once.
- Replace the stiff sidebar title with the signed wordmark. Daemon status stays
  in Settings, not under the name.
- Show Cursor quota as Auto + Composer Usage and API Usage on account cards and
  the quota overview. The float lens stays Auto / API.
- Speed up Antigravity switching, keep weekly-only free quotas honest, and
  avoid fake 5-hour bars.
- The installer is still unsigned. Download only from GitHub Releases and check
  SHA-256.
- 1.0.x builds do not rename the desktop shortcut by themselves. Install this
  Setup once; later `2.0.x` updates can arrive in the app.

## [1.0.1] - 2026-08-19

- Restore the target Cursor profile, team session, and usage identity after a
  switch, and clear leftover team cache so a Pro account is not left on the
  previous team's session.
- Close Cursor and write the login database in one pass so switching is faster
  without changing the result.
- Flip the current badge on account cards and the float lens as soon as the
  switch succeeds, instead of waiting on a later official-login scan. A scan
  that started before the switch can no longer put the previous account back.

## [1.0.0] - 2026-08-19

First stable release after the `0.1.0-beta` series.

- One Windows window for Codex, Cursor, and Antigravity IDE: account cards,
  quotas, local import, browser sign-in, and switching into the official
  client.
- Saved logins stay on this PC and are encrypted with Windows DPAPI.
- A Codex switch snapshots the official login and rolls the whole transaction
  back if a later step fails.
- Quota refresh for saved accounts runs five at a time and skips accounts that
  already need re-auth or are banned.
- Desktop quota lens, tray, and Codex auto-switch that keeps running after the
  window is closed.
- The installer is still unsigned. Download only from GitHub Releases and check
  SHA-256.
- Packaged `0.1.0-beta.*` builds do not auto-update to 1.0.0. Install this
  Setup once; later `1.0.x` updates can arrive in the app.

## [0.1.0-beta.34] - 2026-08-19

- Replace the sidebar product switch with a dock of official Codex, Cursor,
  and Antigravity app icons so more agents stay readable later.

## [0.1.0-beta.33] - 2026-08-19

- Keep Antigravity on paired Gemini / Claude 与 GPT rings in the float,
  including reauth and unclear-quota cards, instead of a single Codex ring.
- Load Antigravity float accounts from the local store first so switching
  products feels as fast as Codex and Cursor.
- Keep unauthorized float cards readable: status, remaining time, and the
  switch label no longer clip.

## [0.1.0-beta.32] - 2026-08-18

- Write Cursor and Antigravity logins as in-place SQLite updates, so a large
  `state.vscdb` no longer blocks switching.
- After closing the official app, wait until the login database accepts a
  write lock, instead of a short sleep that left the file busy.
- Record Cursor and Antigravity switch failures in the app log, including
  the error code.

## [0.1.0-beta.31] - 2026-08-18

- Let the Windows taskbar minimize and restore the main window and the
  desktop quota float, without grouping them as one button.
- Keep the float as rounded glass, not a black rectangle, with pin and
  close only.
- Open the main window at 1440x900, centered, after a full quit. Resize
  still works until quit; close still hides to the tray.

## [0.1.0-beta.30] - 2026-08-18

- Add Antigravity IDE: import the local login, Google browser sign-in,
  switch, plan/model remaining, and the float lens. Different mailboxes
  stay two cards. Failed quota reads stay 这次没查清, not Codex 已封号.
- Fold accounts by email, and keep the previous quota_error when a
  refresh returns no new usage windows.
- Open a dark window first (#131315), copy official state.vscdb off the
  main thread, sync list and current once per short TTL, and defer proxy
  probe plus Codex decrypt until the first screen is clickable so the
  title bar does not freeze as 未响应 or flash white.
- Document Antigravity in the README, architecture, privacy, and
  troubleshooting pages.

## [0.1.0-beta.29] - 2026-08-17

- Stop quota refresh from appending NO_PROXY to itself on every call,
  which grew until Invalid string length froze the main window.

## [0.1.0-beta.28] - 2026-08-17

- Keep quota HTTP on Node only, and do not retune the UI session proxy
  while refreshing, so the main window stays responsive.

## [0.1.0-beta.27] - 2026-08-17

- Stop quota refresh from reading a huge Chromium response on the UI
  session, which froze the main window as 未响应 and left 这次没查清.
- When a local proxy is already selected, use Node plus that proxy and
  cap JSON bodies at 1MB.

## [0.1.0-beta.26] - 2026-08-17

- Give the desktop quota lens a real drop shadow instead of a second blurred
  card, and drop the empty-state key icon from the Codex ring.
- Refresh Cursor quotas on first open so the account page and float lens do
  not stay on 这次没查清 until a manual refresh.
- Keep Cursor float rings as Auto/API even when a refresh fails.
- Align public docs and community files with the Chinese UI labels, and keep
  English pages as `*.en.md` siblings.

## [0.1.0-beta.25] - 2026-08-16

- Add a parallel Cursor pipeline: import the official login, switch into
  Cursor, refresh plan/Auto/API usage, and sign in through the browser.
  Codex auto-switch and ban status stay Codex-only.
- Follow a live local HTTP/SOCKS proxy so quota refresh does not hang on
  poisoned chatgpt.com DNS, and reuse that path for Electron and Node.
- Keep a quota retry backoff from showing as a Daemon failure, and continue
  auto-switch with cached quota instead of stalling the tick.
- Polish the Chinese UI: Team 套餐, 已用尽, 知道了, and restore the sidebar
  brand to Account Manager.

## [0.1.0-beta.24] - 2026-08-16

- Make pending-account actions obvious: reauthorize on quota cards, hide empty
  menus, and show a handling count on the sidebar and account page.
- Show the current Codex mailbox in the header and copy it on click.
- Demote auto-switch “check now” so it is harder to trigger a real switch by
  accident, and refresh the public screenshots to match the current UI.

## [0.1.0-beta.23] - 2026-08-16

- Tell banned, reauthorization, usage-limited, and unclear quota states
  apart. A ban is only recorded from Codex usage deactivation codes.
- Check leftover access tokens for bans or remaining quota without burning
  the refresh token, and keep auto-switch from treating a limited or dead
  current account as healthy.
- Treat a refresh-side `account_disabled` as “needs reauthorization”, not a
  ban, and align the Chinese copy on account, quota, auto-switch, and the
  desktop lens.

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

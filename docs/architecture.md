# Architecture

User-facing copy is in Chinese. This page is for people changing the code.

Quota Switcher is a Windows-only Electron application with a small,
explicit boundary between the renderer and privileged local operations.

## Runtime layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Electron main | `src/main` | Window lifecycle, IPC handlers, DPAPI setup, updater integration |
| Preload bridge | `src/preload/preload.js` | Narrow `contextBridge` API exposed to the renderer |
| Renderer source | `src/renderer-react` | Account cards, quota views, settings, dialogs, and interaction state |
| Renderer build | `src/renderer-dist` | Generated Vite output loaded by Electron; ignored by Git |
| Domain engine | `engine` | OAuth, storage, quota, token refresh, switching, and auto-switch policy |

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and
`sandbox: true`. It cannot access Node.js APIs directly. Tokens never leave
the main process; the renderer only receives public account metadata.

## Products

The sidebar selects one product at a time. Codex, Cursor, and Antigravity keep
separate account indexes, OAuth flows, quota parsers, and switch transactions.

| Product | Storage prefix | Official write target | Auto-switch |
| --- | --- | --- | --- |
| Codex | `codex_` | `%USERPROFILE%\.codex\auth.json` | Yes |
| Cursor | `cursor_` | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | No |
| Antigravity | `antigravity_` | `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` | No |

Codex storage rejects `cursor_` and `antigravity_` ids. Cursor and Antigravity
status never use the Codex ban bucket. Phase 1 Antigravity is official IDE
only: no legacy `Antigravity.exe`, no multi-instance, no daemon auto-switch.

## Startup flow

1. Electron initializes a Windows DPAPI-backed secret codec.
2. The main process registers IPC handlers around the domain engine.
3. The BrowserWindow loads the isolated preload bridge and renderer.
4. The renderer loads a `desktop:snapshot` of Codex, Cursor, and Antigravity
   accounts, current identities, daemon state, configuration, official-client
   detection, and update status.
5. Stale quota data is refreshed in the background with `mapLimit(5)`. Accounts
   that already need re-auth, are banned, or are waiting on `quota_next_retry_at`
   are skipped. Codex quota auto-sync keeps running while another product tab
   is open.

## Account storage

The manager stores its own state under `%USERPROFILE%\.codex-switch`:

```text
.codex-switch/
  accounts.json
  accounts.json.bak
  cursor-accounts.json
  antigravity-accounts.json
  auto-switch.json
  codex_oauth_pending.json
  cursor_oauth_pending.json
  antigravity_oauth_pending.json
  logs/
  accounts/
    codex_<id>.json
    codex_<id>.json.bak
  cursor-accounts/
    cursor_<id>.json
    cursor_<id>.json.bak
  antigravity-accounts/
    antigravity_<id>.json
    antigravity_<id>.json.bak
```

Account files contain metadata plus a `tokens_encrypted` payload protected by
Electron `safeStorage`, which uses Windows DPAPI. Listing accounts for the UI
uses `secrets: false` so tokens are not decrypted. Legacy plaintext records
are queued for a deferred rewrite instead of being rewritten on every read.

The active Codex identity remains in `%USERPROFILE%\.codex\auth.json`, because
that is the state consumed by Codex. The manager creates `auth.json.bak` before
replacing it during a switch.

The active Cursor identity remains in official Cursor `state.vscdb`. The
manager updates only the login keys in place (`BEGIN IMMEDIATE`, WAL). A
leftover WAL after Cursor has exited is applied by SQLite; a locked database
still blocks the switch. Antigravity IDE uses the same in-place SQLite pattern
on its own `state.vscdb`.

## Switching flow

Codex:

1. Confirm that the official Microsoft Store Codex app is installed.
2. Request a graceful close for the official Codex process tree, then force
   only matching processes that remain after the timeout.
3. Snapshot `auth.json`, the managed projection, account index, selected
   account record, and affected configuration.
4. Remove custom root Codex API base URL overrides from `config.toml`.
5. Atomically write the selected account authentication, projection, and index.
6. Launch and verify the official Codex app through its AUMID.
7. Restore every snapshot and restart the previous state if any step fails.

Cursor:

1. Close official Cursor and wait until matching processes exit.
2. Wait until `state.vscdb` accepts a write lock, then snapshot the current
   login keys (not a 400ms read-only open).
3. Update those login keys in place, clear leftover keys the target account
   does not have, and update the Cursor index.
4. Relaunch official Cursor.
5. Roll the index and login keys back if post-write work fails. Failures
   before the write relaunch official Cursor and are written to the app log.

The Codex switching path is used by both manual and automatic switching.
The managed Codex projection contains an authentication fingerprint. A
mismatch with official `auth.json` pauses automatic authentication writes and
switching until the user resolves the conflict.

## Quota and token flow

Each managed account keeps an isolated token set. Quota reads and token refresh
requests use that account directly; they do not need to make it the active
official identity first.

Codex windows are the 5-hour and weekly quotas. Cursor windows are plan, Auto,
and API usage. Antigravity windows are plan or credits and primary model
remaining. Missing windows remain unknown rather than being converted to
zero. Batch refresh uses `mapLimit(5)` across saved accounts.

Outbound HTTP is Node `http`/`https` (not Chromium `net.fetch`), follows a
discovered local HTTP or SOCKS proxy, and reuses keep-alive Agents keyed by
proxy signature. In a packaged Electron app, HTTP and SQLite reads can run in
a `utilityProcess` worker; DPAPI and switch transactions stay in the main
process. If the worker exits, those calls fall back in-process.

## IPC contract

Renderer calls are defined in `src/preload/preload.js` and handled in
`src/main/ipc-handlers.js`. `scripts/audit-ui-contract.js` verifies that:

- every renderer bridge method exists in preload;
- every invoked channel has a main-process handler;
- expected main-process events are exposed to the renderer.

When adding an operation, update all three surfaces and run `npm run audit:ui`.

The first paint uses `desktop:snapshot`. Later quota and account changes can
arrive as `quota:updated` / `account:updated` patches instead of a full reload.

## Update channels

- Versions containing a prerelease suffix, such as `-beta.2`, use manual
  updates through GitHub Releases.
- Stable packaged versions enable `electron-updater`, download updates in the
  background, and require an explicit restart before installation.
- Development and unpacked builds never enable automatic update delivery.

## Repository structure

```text
engine/                 Domain logic and local persistence
engine/cursor-*.js      Cursor import, OAuth, quota, token, and switch
engine/antigravity-*.js Antigravity import, Google OAuth, quota, token, and switch
engine/proxy-resolve.js Outbound proxy discovery
resources/              Windows application icon
scripts/                Release and contract verification
src/main/               Electron main process, IPC, engine worker host
src/preload/            Isolated renderer bridge
src/renderer-react/     Current React UI source
src/renderer-dist/      Generated renderer build (not tracked)
docs/                   Architecture, privacy, release, and support docs
.github/                CI, release automation, and community templates
```

## Verification

Run the complete non-destructive check suite:

```powershell
npm ci
npm test
npm run build:dir
```

Actions that change a real account or remove account data must be tested with
synthetic or dedicated test accounts.

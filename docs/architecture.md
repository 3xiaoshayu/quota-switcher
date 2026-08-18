# Architecture

User-facing copy is in Chinese. This page is for people changing the code.

Codex Account Manager is a Windows-only Electron application with a small,
explicit boundary between the renderer and privileged local operations.

## Runtime layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Electron main | `src/main` | Window lifecycle, IPC handlers, DPAPI setup, updater integration |
| Preload bridge | `src/preload/preload.js` | Narrow `contextBridge` API exposed to the renderer |
| Renderer source | `src/renderer-react` | Account cards, quota views, settings, dialogs, and interaction state |
| Renderer build | `src/renderer-dist` | Generated Vite output loaded by Electron; ignored by Git |
| Domain engine | `engine` | OAuth, storage, quota, token refresh, switching, and auto-switch policy |

The renderer runs with `contextIsolation: true` and `nodeIntegration: false`.
It cannot access Node.js APIs directly. Electron sandbox hardening is planned
for a later public-release security pass.

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
4. The renderer loads Codex, Cursor, and Antigravity accounts, current identities,
   daemon state, configuration, official-client detection, and update status.
5. Missing or stale quota data is refreshed sequentially in the background.
   Codex quota auto-sync keeps running while the Cursor tab is open.

## Account storage

The manager stores its own state under `%USERPROFILE%\.codex-switch`:

```text
.codex-switch/
  accounts.json
  accounts.json.bak
  cursor-accounts.json
  auto-switch.json
  codex_oauth_pending.json
  cursor_oauth_pending.json
  logs/
  accounts/
    codex_<id>.json
    codex_<id>.json.bak
  cursor-accounts/
    cursor_<id>.json
    cursor_<id>.json.bak
```

Account files contain metadata plus a `tokens_encrypted` payload protected by
Electron `safeStorage`, which uses Windows DPAPI. Legacy plaintext account
records are migrated when read.

The active Codex identity remains in `%USERPROFILE%\.codex\auth.json`, because
that is the state consumed by Codex. The manager creates `auth.json.bak` before
replacing it during a switch.

The active Cursor identity remains in official Cursor `state.vscdb`. The
manager refuses to overwrite that file while a WAL write is still pending.

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
2. Refuse the write if `state.vscdb` still has a pending WAL.
3. Snapshot the Cursor index, selected account, and current `state.vscdb`.
4. Write the selected login, clear leftover keys the target account does not
   have, and update the Cursor index.
5. Relaunch official Cursor.
6. Roll the index and login file back if post-write work fails.

The Codex switching path is used by both manual and automatic switching.
The managed Codex projection contains an authentication fingerprint. A
mismatch with official `auth.json` pauses automatic authentication writes and
switching until the user resolves the conflict.

## Quota and token flow

Each managed account keeps an isolated token set. Quota reads and token refresh
requests use that account directly; they do not need to make it the active
official identity first.

Codex windows are the 5-hour and weekly quotas. Cursor windows are plan, Auto,
and API usage. Missing windows remain unknown rather than being converted to
zero. Automatic refresh is sequential to avoid bursts across all saved
accounts.

Outbound HTTP follows a discovered local HTTP or SOCKS proxy when one is live,
including leftover Windows proxy entries after system proxy has been turned
off. Electron and Node reuse the same signature so a doomed direct path is not
retried on every request.

## IPC contract

Renderer calls are defined in `src/preload/preload.js` and handled in
`src/main/ipc-handlers.js`. `scripts/audit-ui-contract.js` verifies that:

- every renderer bridge method exists in preload;
- every invoked channel has a main-process handler;
- expected main-process events are exposed to the renderer.

When adding an operation, update all three surfaces and run `npm run audit:ui`.

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
src/main/               Electron main process
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

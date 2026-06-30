# Architecture

Codex Account Manager is a Windows-only Electron application with a small,
explicit boundary between the renderer and privileged local operations.

## Runtime layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Electron main | `src/main` | Window lifecycle, IPC handlers, DPAPI setup, updater integration |
| Preload bridge | `src/preload/preload.js` | Narrow `contextBridge` API exposed to the renderer |
| Renderer | `src/renderer` | Account cards, quota views, settings, dialogs, and interaction state |
| Domain engine | `engine` | OAuth, storage, quota, token refresh, switching, and auto-switch policy |

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and
Electron sandboxing enabled. It cannot access Node.js APIs directly.

## Startup flow

1. Electron initializes a Windows DPAPI-backed secret codec.
2. The main process registers IPC handlers around the domain engine.
3. The BrowserWindow loads the isolated preload bridge and renderer.
4. The renderer loads accounts, current identity, daemon state, configuration,
   Codex installation status, and update status.
5. Missing or stale quota data is refreshed sequentially in the background.

## Account storage

The manager stores its own state under `%USERPROFILE%\.codex-switch`:

```text
.codex-switch/
  accounts.json
  auto-switch.json
  accounts/
    codex_<id>.json
```

Account files contain metadata plus a `tokens_encrypted` payload protected by
Electron `safeStorage`, which uses Windows DPAPI. Legacy plaintext account
records are migrated when read.

The active Codex identity remains in `%USERPROFILE%\.codex\auth.json`, because
that is the state consumed by Codex. The manager creates `auth.json.bak` before
replacing it during a switch.

## Switching flow

1. Confirm that the official Microsoft Store Codex app is installed.
2. Stop `Codex.exe` and the associated `node_repl.exe` process.
3. Back up the current Codex `auth.json`.
4. Remove custom Codex API base URL overrides from `config.toml`.
5. Write the selected account to `auth.json` through a temporary file and rename.
6. Update the manager's current-account index and last-used timestamp.
7. Launch the official Codex app through its AUMID.

The same switching path is used by both manual and automatic switching.

## Quota and token flow

Each managed account keeps an isolated token set. Quota reads and token refresh
requests use that account directly; they do not need to make it the active
Codex identity first.

The renderer treats the 5-hour and weekly windows independently. Missing
windows remain unknown rather than being converted to zero. Automatic refresh
is sequential to avoid bursts across all saved accounts.

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
resources/              Windows application icon
scripts/                Release and contract verification
src/main/               Electron main process
src/preload/            Isolated renderer bridge
src/renderer/           Current UI and bundled visual assets
docs/                   Architecture, privacy, release, and support docs
.github/                CI, release automation, and community templates
```

## Verification

Run the complete non-destructive check suite:

```powershell
npm ci
npm run check
npm run build:dir
```

Actions that change a real account, consume a reset credit, or remove account
data must be tested with synthetic or dedicated test accounts.

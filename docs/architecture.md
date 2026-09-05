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
| Domain engine | `engine` | OAuth, storage, quota, token refresh, switching, and the background sync worker |

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and
`sandbox: true`. It cannot access Node.js APIs directly. Tokens never leave
the main process; the renderer only receives public account metadata.

## Products

The sidebar selects one product at a time. Codex, Cursor, and Antigravity keep
separate account indexes, OAuth flows, quota parsers, and switch transactions.

| Product | Storage prefix | Official write target | Background worker |
| --- | --- | --- | --- |
| Codex | `codex_` | `%USERPROFILE%\.codex\auth.json` | Login renewal and quota sync |
| Cursor | `cursor_` | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | None |
| Antigravity | `antigravity_` | `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` | None |

Every switch is user-initiated; there is no automatic account switching for
any product. Codex storage rejects `cursor_` and `antigravity_` ids. Cursor and
Antigravity status never use the Codex ban bucket. Phase 1 Antigravity is
official IDE only: no legacy `Antigravity.exe`, no multi-instance.

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
  auto-switch.json          (background worker on/off and interval; historical name)
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

The managed Codex projection contains an authentication fingerprint. A
mismatch with official `auth.json` pauses the background worker's
authentication writes until the user resolves the conflict in the window.

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

## Reliability

These behaviors sit on top of the quota and token flow. They keep a jittery
network from looking like a used-up account or a broken login.

**Locks and torn writes.** Codex snapshots the official login, the managed
projection, and the account index before it writes. Any later failure rolls
the whole transaction back. A leftover file lock or a non-JSON official read
is not treated as an identity conflict. A write that already succeeded is not
rolled back because a later inspect is locked. Cursor and Antigravity update
`state.vscdb` in place with WAL and `BEGIN IMMEDIATE` instead of copying the
whole database.

**Proxy discovery and failure memory.** Outbound HTTP follows a discovered
local HTTP or SOCKS proxy and reuses keep-alive Agents keyed by proxy
signature. A proxy that fails is skipped for about 60 seconds. Idempotent
GET quota calls can fail over to a direct connection. A token POST that
times out is not replayed.

**Quota and token backoff.** Accounts record `quota_next_retry_at` and
`token_next_retry_at`. Refresh skips those rows until the timestamp. Retry-After
and related reset headers are honored instead of always waiting a fixed
interval.

**429 is not `usage_limited`.** A Codex `429 rate_limit` means the usage
endpoint asked the client to slow down. It is not treated as the account
being used up. The card keeps leftover quota and shows that the login is
still present.

**Leftover windows.** When a refresh fails for a timeout, proxy 5xx, empty
or HTML token body, or a 429 rate limit, the last known remaining quota stays
on the card. The user-facing line is “额度暂时没刷到，登录还在”. Missing
windows stay unknown; they are not converted to zero.

**XSSI.** Google responses may start with an XSSI prefix. Token and quota
parsers strip that prefix before they read JSON, so a prefixed body is not
treated as a malformed login.

**Worker boundary.** In a packaged build, HTTP and SQLite reads can run in a
`utilityProcess` worker. DPAPI and switch transactions stay in the main
process. If the worker exits, GET-style work can fall back in-process. A
non-idempotent token POST is not replayed from the main process after a
worker timeout.

**Official format drift.** `engine/upstream-drift.js` compares each official
client's on-disk login with what this manager knows: Codex `auth.json` must
carry `tokens` (or a known agent-identity / API-key shape), Cursor
`state.vscdb` must hold `cursorAuth/accessToken` or none of the `cursorAuth/`
family, and the Antigravity `antigravityUnifiedStateSync.oauthToken` item must
decode with the known protobuf topic. The three `*:status` IPC calls attach the
verdict as `officialFormat`, and Settings shows “登录格式变了” for a product
in `drift`. The checks are read-only; a missing or locked file is `signed_out`
or `unknown`, never `drift`, so a lock can not produce a false alarm.

## IPC contract

Renderer calls are defined in `src/preload/preload.js` and handled in
`src/main/ipc-handlers.js`. `scripts/audit-ui-contract.js` verifies that:

- every renderer bridge method exists in preload;
- every invoked channel has a main-process handler;
- expected main-process events are exposed to the renderer.

When adding an operation, update all three surfaces and run `npm run audit:ui`.

Failures answer `{ success: false, error, code }`. `code` is the stable
identifier the engine attached (`error.code`, for example
`cursor_vscdb_busy`); `error` is diagnostic text. The renderer wraps it in a
`DesktopError` and picks user copy by code first (`CODE_MESSAGES` in
`api/user-messages.ts`), falling back to message matching only for errors that
carry no code. `test/error-codes.test.js` fails when the engine gains a code
without copy.

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
src/renderer-react/App.tsx        Composition root: wires the hooks below and renders the shell
src/renderer-react/app/           Renderer logic: snapshot loader, OAuth flow, desktop events,
                                  account actions, notifications; pure rules next to each hook
src/renderer-react/components/    Views, cards, dialogs, float lens
src/renderer-react/api/           Bridge wrapper, product adapter, user-facing copy
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

## Related work

A common community reference is
[Cockpit Tools](https://github.com/jlcodes99/cockpit-tools). That project is a
general cockpit for many AI IDEs. This app is the Windows-local vault, quota
view, and switch path for Codex, Cursor, and Antigravity IDE. The product
comparison table lives in [README.md](../README.md#和-cockpit-tools) and
[README.en.md](../README.en.md#compared-with-cockpit-tools).

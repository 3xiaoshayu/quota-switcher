import {
  clampSyncIntervalMinutes,
  formatDateTime,
  isManagedProductAccount,
  needsQuotaAutoSync,
  quotaAutoSyncStaleMs,
} from '../api/desktop';
import { toUserMessage } from '../api/user-messages';
import type {
  AccountQuota,
  DaemonState,
  DesktopDaemonConfig,
  DesktopOAuthStatus,
  ProductKind,
} from '../types';

// Pure rules the dashboard loader applies to a snapshot. They live outside
// React so the tricky cases (stale snapshots, in-flight saves, pending OAuth)
// can be pinned down in Node tests.

// A snapshot taken before the engine recorded a browser authorization comes
// back "idle" while the window already shows "pending". Keep the local
// pending status in that one case; everything else follows the snapshot.
export function mergeOAuthStatus(
  local: DesktopOAuthStatus | null,
  incoming: DesktopOAuthStatus,
): DesktopOAuthStatus {
  if (local?.pending && !incoming.pending && incoming.status === 'idle') return local;
  return incoming;
}

interface LandingBundle {
  codexPending: boolean;
  cursorPending: boolean;
  antigravityPending: boolean;
}

// A pending browser authorization decides which product the window lands on.
export function landingProductFor(bundle: LandingBundle, current: ProductKind): ProductKind {
  if (bundle.antigravityPending) return 'antigravity';
  if (bundle.cursorPending) return 'cursor';
  if (bundle.codexPending) return 'codex';
  return current;
}

interface DaemonSnapshotFields {
  daemonRunning: boolean;
  daemonSyncInterval: number;
  daemonLastRunAt?: string | number | null;
  daemonLastSuccessAt?: string | number | null;
  daemonLastError?: string | null;
  daemonPausedReason?: string | null;
}

// While a user-initiated config save is in flight, the interval shown must be
// the one just chosen, not the one the snapshot read from disk a moment ago.
export function daemonStateFromSnapshot(
  snapshot: DaemonSnapshotFields,
  options: { saveInFlight: boolean; localConfig: DesktopDaemonConfig },
): DaemonState {
  return {
    status: snapshot.daemonRunning ? 'Running' : 'Stopped',
    syncInterval: options.saveInFlight
      ? clampSyncIntervalMinutes(options.localConfig.sync_interval_minutes)
      : snapshot.daemonSyncInterval,
    lastChecked: snapshot.daemonLastRunAt ? formatDateTime(snapshot.daemonLastRunAt) : '',
    lastSuccessAt: snapshot.daemonLastSuccessAt ?? null,
    lastError: snapshot.daemonLastError ? toUserMessage(snapshot.daemonLastError) : null,
    pausedReason: snapshot.daemonPausedReason ? toUserMessage(snapshot.daemonPausedReason) : null,
  };
}

interface AutoSyncOptions {
  // An unresolved official-login conflict blocks Codex quota reads; Cursor
  // and Antigravity accounts are unaffected.
  authBlocked: boolean;
  inFlightIds: ReadonlySet<string>;
  syncIntervalMinutes: number | undefined;
}

export function staleAccountsForAutoSync(
  candidates: AccountQuota[],
  options: AutoSyncOptions,
): AccountQuota[] {
  return candidates.filter((account) => {
    if (options.inFlightIds.has(account.id)) return false;
    if (options.authBlocked && !isManagedProductAccount(account)) return false;
    return needsQuotaAutoSync(account, quotaAutoSyncStaleMs(account, options.syncIntervalMinutes));
  });
}

// Orders dashboard loads. A slow older load must never overwrite state written
// by a newer one, and a caller whose own load was superseded should still get
// the fresher snapshot instead of a null that looks like "still updating".
export class LoadSequence<T> {
  private seq = 0;
  private latest: Promise<T | null> | null = null;

  begin(): number {
    this.seq += 1;
    return this.seq;
  }

  // Invalidates every load started so far without starting a new one.
  invalidate(): void {
    this.seq += 1;
  }

  isCurrent(seq: number): boolean {
    return seq === this.seq;
  }

  track(run: Promise<T | null>): void {
    this.latest = run;
  }

  async settle(run: Promise<T | null>, seq: number): Promise<T | null> {
    const result = await run;
    if (result !== null || this.isCurrent(seq)) return result;
    let latest = this.latest;
    while (latest && latest !== run) {
      const outcome = await latest;
      if (outcome !== null) return outcome;
      const newer = this.latest;
      if (newer === latest) return null;
      latest = newer;
    }
    return null;
  }
}

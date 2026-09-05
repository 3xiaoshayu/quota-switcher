import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { desktopApi, hasDesktopBridge, QUOTA_AUTO_SYNC_MIN_GAP_MS } from '../api/desktop';
import { toUserMessage } from '../api/user-messages';
import { setAppInfo, setUpdateStatus } from '../state/desktop-store';
import type { AccountQuota, DesktopAuthState, ProductKind, SystemSettings } from '../types';
import { latestStatusForUi, updateChannelForUi } from './dashboard-settings';
import { applyCurrentAccountBadge } from './store-helpers';
import type { LoadDashboardState } from './useDashboardLoader';
import type { SharedRefs } from './useSharedRefs';

type Notify = (message: string, type: 'success' | 'info' | 'warning' | 'error', source: ProductKind | 'auto') => void;

interface UseDesktopEventsOptions {
  refs: SharedRefs;
  loadDashboardState: LoadDashboardState;
  queueQuotaAutoSync: (accounts: AccountQuota[]) => void;
  applyAuthState: (incoming: DesktopAuthState | null | undefined) => void;
  addToast: Notify;
  addLogEntry: Notify;
  setSettings: Dispatch<SetStateAction<SystemSettings>>;
}

// Several quota:updated / account:updated events can arrive within a few
// milliseconds of each other; one reload after a short quiet period is enough.
export const PATCH_RELOAD_DEBOUNCE_MS = 150;
// A snapshot taken while the official login was still being inspected can be
// incomplete; one retry a few seconds later fills it in.
export const AUTH_RETRY_DELAY_MS = 5000;

// First load, periodic quota sync, and the main-process event subscription.
export function useDesktopEvents({
  refs,
  loadDashboardState,
  queueQuotaAutoSync,
  applyAuthState,
  addToast,
  addLogEntry,
  setSettings,
}: UseDesktopEventsOptions) {
  const bridgeAvailable = hasDesktopBridge();

  useEffect(() => {
    if (!bridgeAvailable) return;
    desktopApi.getAppInfo()
      .then((info) => {
        setAppInfo(info);
        setSettings((prev) => ({ ...prev, version: info.version || prev.version }));
      })
      .catch(() => {});
  }, [bridgeAvailable, setSettings]);

  useEffect(() => {
    if (!bridgeAvailable) return;
    let disposed = false;

    loadDashboardState(true, { skipOfficialSync: true }).then(async (snapshot) => {
      if (disposed || !snapshot) return;
      void desktopApi.notifyUiReady().catch(() => {});
      if (!disposed) void loadDashboardState(false);
      if (!disposed) {
        queueQuotaAutoSync([
          ...snapshot.accounts,
          ...(snapshot.cursorAccounts || []),
          ...(snapshot.antigravityAccounts || []),
        ]);
      }
    });
    const authRetryTimer = window.setTimeout(() => {
      if (!disposed) loadDashboardState(false);
    }, AUTH_RETRY_DELAY_MS);

    const syncTimer = window.setInterval(() => {
      if (!disposed) {
        queueQuotaAutoSync([
          ...refs.codexAccounts.current,
          ...refs.cursorAccounts.current,
          ...refs.antigravityAccounts.current,
        ]);
      }
    }, QUOTA_AUTO_SYNC_MIN_GAP_MS);

    let patchTimer: number | null = null;
    const schedulePatchReload = () => {
      if (disposed) return;
      if (patchTimer) window.clearTimeout(patchTimer);
      patchTimer = window.setTimeout(() => {
        patchTimer = null;
        if (!disposed) void loadDashboardState(false, { skipOfficialSync: true });
      }, PATCH_RELOAD_DEBOUNCE_MS);
    };

    const unsubscribe = desktopApi.subscribe({
      onDaemonTick: (payload) => {
        if (payload?.result?.authState) applyAuthState(payload.result.authState);
        loadDashboardState(false).then((snapshot) => {
          if (!disposed && snapshot) queueQuotaAutoSync(snapshot.accounts);
        });
      },
      onDaemonError: (message) => {
        const text = toUserMessage(message);
        addToast(text, 'error', 'codex');
        addLogEntry(text, 'error', 'codex');
      },
      onUpdateStatus: (status) => {
        setUpdateStatus(status);
        setSettings((prev) => ({
          ...prev,
          latestStatus: latestStatusForUi(status),
          updateChannel: updateChannelForUi(status),
        }));
      },
      onAuthConflict: (state) => {
        applyAuthState(state);
        const raw = state.status && state.status !== 'aligned'
          ? state.status
          : (state.message || '官方 Codex 登录状态已变更。');
        addToast(toUserMessage(raw), 'warning', 'codex');
      },
      onQuotaUpdated: () => schedulePatchReload(),
      onAccountUpdated: (payload) => {
        if (payload?.current) applyCurrentAccountBadge(payload.product, payload.account?.id);
        schedulePatchReload();
      },
    });

    return () => {
      disposed = true;
      if (patchTimer) window.clearTimeout(patchTimer);
      window.clearTimeout(authRetryTimer);
      window.clearInterval(syncTimer);
      unsubscribe();
    };
  }, [addLogEntry, addToast, applyAuthState, bridgeAvailable, loadDashboardState, queueQuotaAutoSync, refs, setSettings]);
}

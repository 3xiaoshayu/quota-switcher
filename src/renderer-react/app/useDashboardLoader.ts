import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  desktopApi,
  hasDesktopBridge,
  needsHandling,
  pickStartupFloatProduct,
  QUOTA_AUTO_SYNC_MIN_GAP_MS,
} from '../api/desktop';
import { toUserMessage } from '../api/user-messages';
import {
  accountsFromSnapshot,
  isManagedProduct,
  productActions,
  productOfAccount,
} from '../api/product-adapter';
import type { SidebarTab } from '../components/Sidebar';
import {
  setAntigravityAccounts,
  setAntigravityOAuthStatus,
  setAntigravityStatus,
  setAppInfo,
  setCodexAccounts,
  setCodexStatus,
  setCursorAccounts,
  setCursorOAuthStatus,
  setCursorStatus,
  setDaemonConfig,
  setDaemonState,
  setOAuthStatus,
  setUpdateStatus,
} from '../state/desktop-store';
import type { AccountQuota, DesktopAuthState, ProductKind, SystemSettings } from '../types';
import { settingsFromDesktopState } from './dashboard-settings';
import {
  daemonStateFromSnapshot,
  landingProductFor,
  LoadSequence,
  mergeOAuthStatus,
  staleAccountsForAutoSync,
} from './snapshot';
import type { SharedRefs } from './useSharedRefs';

type DashboardSnapshot = Awaited<ReturnType<typeof desktopApi.loadDashboardState>>;
type CursorSnapshot = Awaited<ReturnType<typeof desktopApi.loadCursorState>>;
type AntigravitySnapshot = Awaited<ReturnType<typeof desktopApi.loadAntigravityState>>;

export type DashboardLoadResult = DashboardSnapshot & {
  cursorAccounts: AccountQuota[];
  antigravityAccounts: AccountQuota[];
};

export type LoadDashboardState = (
  showLoading?: boolean,
  options?: { skipOfficialSync?: boolean },
) => Promise<DashboardLoadResult | null>;

interface UseDashboardLoaderOptions {
  refs: SharedRefs;
  applyAuthState: (incoming: DesktopAuthState | null | undefined) => void;
  persistProduct: (next: ProductKind) => void;
  setActiveTab: Dispatch<SetStateAction<SidebarTab>>;
  setSettings: Dispatch<SetStateAction<SystemSettings>>;
  addToast: (msg: string, type: 'success' | 'info' | 'warning' | 'error', source: ProductKind | 'auto') => void;
  addLogEntry: (message: string, type: 'success' | 'info' | 'warning' | 'error', source: ProductKind | 'auto') => void;
}

const actions = productActions();

// Owns the desktop snapshot: applying it to the store, keeping loads ordered,
// and the background quota sync that follows a load.
export function useDashboardLoader({
  refs,
  applyAuthState,
  persistProduct,
  setActiveTab,
  setSettings,
  addToast,
  addLogEntry,
}: UseDashboardLoaderOptions) {
  const bridgeAvailable = hasDesktopBridge();
  const [dashboardLoadState, setDashboardLoadState] = useState<'loading' | 'ready' | 'error'>(
    bridgeAvailable ? 'loading' : 'ready',
  );
  const [dashboardLoadError, setDashboardLoadError] = useState<string | null>(null);
  const hasLoadedDashboard = useRef(!bridgeAvailable);
  const didPickLandingTab = useRef(false);
  const didAutoShowFloat = useRef(false);
  const loads = useRef(new LoadSequence<DashboardLoadResult>());
  const quotaAutoSyncPromise = useRef<Promise<void> | null>(null);
  const lastQuotaAutoSyncAt = useRef(0);
  const wasOAuthPending = useRef(false);
  const wasCursorOAuthPending = useRef(false);
  const wasAntigravityOAuthPending = useRef(false);

  // A browser authorization that just started pulls the window to that
  // product's account list so the user sees it come back.
  const followNewPending = useCallback((kind: ProductKind, pending: boolean, was: { current: boolean }) => {
    if (pending && !was.current && refs.product.current === kind) {
      persistProduct(kind);
      setActiveTab('accounts');
    }
    was.current = pending;
  }, [persistProduct, refs, setActiveTab]);

  const applyCursorState = useCallback((snapshot: CursorSnapshot) => {
    setCursorAccounts(snapshot.accounts);
    const nextOAuth = mergeOAuthStatus(refs.cursorOAuthStatus.current, snapshot.oauthStatus);
    setCursorOAuthStatus(nextOAuth);
    refs.cursorOAuthStatus.current = nextOAuth;
    setCursorStatus(snapshot.cursorStatus);
    setSettings((prev) => ({
      ...prev,
      cursorDetected: !!snapshot.cursorStatus?.installed,
      cursorHasLocalLogin: !!snapshot.cursorStatus?.vscdbPresent,
    }));
    followNewPending('cursor', !!nextOAuth.pending, wasCursorOAuthPending);
  }, [followNewPending, refs, setSettings]);

  const applyAntigravityState = useCallback((snapshot: AntigravitySnapshot) => {
    setAntigravityAccounts(snapshot.accounts);
    const nextOAuth = mergeOAuthStatus(refs.antigravityOAuthStatus.current, snapshot.oauthStatus);
    setAntigravityOAuthStatus(nextOAuth);
    refs.antigravityOAuthStatus.current = nextOAuth;
    setAntigravityStatus(snapshot.antigravityStatus);
    setSettings((prev) => ({
      ...prev,
      antigravityDetected: !!snapshot.antigravityStatus?.installed,
      antigravityHasLocalLogin: !!snapshot.antigravityStatus?.vscdbPresent,
    }));
    followNewPending('antigravity', !!nextOAuth.pending, wasAntigravityOAuthPending);
  }, [followNewPending, refs, setSettings]);

  const applyDashboardState = useCallback((snapshot: DashboardSnapshot) => {
    setCodexAccounts(snapshot.accounts);
    refs.accounts.current = isManagedProduct(refs.product.current) ? refs.accounts.current : snapshot.accounts;
    // A snapshot that started before a Settings change must not put the old
    // interval back while that save is still in flight.
    const saveInFlight = refs.configSaves.current.pending > 0;
    const nextConfig = saveInFlight ? refs.daemonConfig.current : snapshot.config;
    setDaemonConfig(nextConfig);
    refs.daemonConfig.current = nextConfig;
    setAppInfo(snapshot.appInfo);
    setCodexStatus(snapshot.codexStatus);
    setUpdateStatus(snapshot.updateStatus);
    applyAuthState(snapshot.authState);
    const nextOAuth = mergeOAuthStatus(refs.oauthStatus.current, snapshot.oauthStatus);
    setOAuthStatus(nextOAuth);
    refs.oauthStatus.current = nextOAuth;
    followNewPending('codex', !!nextOAuth.pending, wasOAuthPending);
    setSettings((prev) => ({
      ...settingsFromDesktopState(snapshot.appInfo, snapshot.codexStatus, snapshot.updateStatus),
      cursorDetected: prev.cursorDetected,
      cursorHasLocalLogin: prev.cursorHasLocalLogin,
      antigravityDetected: prev.antigravityDetected,
      antigravityHasLocalLogin: prev.antigravityHasLocalLogin,
    }));
    setDaemonState(daemonStateFromSnapshot(snapshot, { saveInFlight, localConfig: nextConfig }));
  }, [applyAuthState, followNewPending, refs, setSettings]);

  const loadDashboardStateOnce = useCallback(async (
    seq: number,
    showLoading: boolean,
    options?: { skipOfficialSync?: boolean },
  ): Promise<DashboardLoadResult | null> => {
    if (showLoading && !hasLoadedDashboard.current) {
      setDashboardLoadState('loading');
      setDashboardLoadError(null);
    }
    try {
      const bundle = await desktopApi.loadDesktopSnapshot({ skipOfficialSync: options?.skipOfficialSync });
      if (!loads.current.isCurrent(seq)) return null;
      const snapshot = bundle.dashboard;
      const cursorSnapshot = bundle.cursor;
      const antigravitySnapshot = bundle.antigravity;
      applyDashboardState(snapshot);
      if (cursorSnapshot) applyCursorState(cursorSnapshot);
      if (antigravitySnapshot) applyAntigravityState(antigravitySnapshot);
      hasLoadedDashboard.current = true;
      const landingProduct = landingProductFor({
        codexPending: !!snapshot.oauthStatus.pending,
        cursorPending: !!cursorSnapshot?.oauthStatus?.pending,
        antigravityPending: !!antigravitySnapshot?.oauthStatus?.pending,
      }, refs.product.current);
      if (!didPickLandingTab.current) {
        didPickLandingTab.current = true;
        const landingAccounts = accountsFromSnapshot(landingProduct, {
          accounts: snapshot.accounts,
          cursorAccounts: cursorSnapshot?.accounts || [],
          antigravityAccounts: antigravitySnapshot?.accounts || [],
        });
        if (landingAccounts.some(needsHandling)) {
          setActiveTab('accounts');
        }
      }
      if (!didAutoShowFloat.current) {
        didAutoShowFloat.current = true;
        const chosen = pickStartupFloatProduct(
          landingProduct,
          snapshot.accounts,
          cursorSnapshot?.accounts || [],
          antigravitySnapshot?.accounts || [],
        );
        if (chosen) {
          void desktopApi.showFloatWindow(chosen).catch(() => {});
        }
      }
      setDashboardLoadState('ready');
      setDashboardLoadError(null);
      return {
        ...snapshot,
        cursorAccounts: cursorSnapshot?.accounts || [],
        antigravityAccounts: antigravitySnapshot?.accounts || [],
      };
    } catch (error) {
      if (!loads.current.isCurrent(seq)) return null;
      const message = toUserMessage(error);
      addToast(message, 'error', 'codex');
      addLogEntry(message, 'error', 'codex');
      if (!hasLoadedDashboard.current) {
        setDashboardLoadState('error');
        setDashboardLoadError(message);
      }
      return null;
    }
  }, [addLogEntry, addToast, applyAntigravityState, applyCursorState, applyDashboardState, refs, setActiveTab]);

  const loadDashboardState = useCallback<LoadDashboardState>(async (showLoading = false, options) => {
    if (!bridgeAvailable) return null;
    const seq = loads.current.begin();
    const run = loadDashboardStateOnce(seq, showLoading, options);
    loads.current.track(run);
    return loads.current.settle(run, seq);
  }, [bridgeAvailable, loadDashboardStateOnce]);

  // Starting a browser authorization invalidates loads already in flight so a
  // pre-click snapshot cannot overwrite the pending status just shown.
  const invalidatePendingLoads = useCallback(() => {
    loads.current.invalidate();
  }, []);

  const queueQuotaAutoSync = useCallback((candidateAccounts: AccountQuota[]) => {
    if (!bridgeAvailable || quotaAutoSyncPromise.current) return;
    if (Date.now() - lastQuotaAutoSyncAt.current < QUOTA_AUTO_SYNC_MIN_GAP_MS) return;
    const staleAccounts = staleAccountsForAutoSync(candidateAccounts, {
      authBlocked: refs.authState.current.status === 'conflict',
      inFlightIds: refs.operationIds.current,
      syncIntervalMinutes: refs.daemonConfig.current.sync_interval_minutes,
    });
    if (!staleAccounts.length) return;

    lastQuotaAutoSyncAt.current = Date.now();
    quotaAutoSyncPromise.current = (async () => {
      for (const account of staleAccounts) {
        const kind = productOfAccount(account);
        try {
          if (isManagedProduct(kind)) await actions.refreshQuota(kind, account.id, false);
          else await desktopApi.refreshQuota(account.id, false);
        } catch (error) {
          const message = toUserMessage(error);
          addLogEntry(`${account.email}: ${message}`, 'info', kind);
        }
      }
      await loadDashboardState(false);
    })().finally(() => {
      quotaAutoSyncPromise.current = null;
    });
  }, [addLogEntry, bridgeAvailable, loadDashboardState, refs]);

  return {
    dashboardLoadState,
    dashboardLoadError,
    loadDashboardState,
    invalidatePendingLoads,
    queueQuotaAutoSync,
  };
}

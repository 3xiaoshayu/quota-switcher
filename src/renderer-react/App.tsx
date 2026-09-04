import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  INITIAL_ACCOUNTS,
  INITIAL_LOGS, 
  INITIAL_SETTINGS 
} from './data/mockData';
import {
  AccountQuota,
  DesktopAppInfo,
  DesktopAutoSwitchConfig,
  DesktopAuthState,
  DesktopAntigravityStatus,
  DesktopCodexStatus,
  DesktopCursorStatus,
  DesktopOAuthStatus,
  DesktopUpdateStatus,
  ProductKind,
  LogEntry,
  SystemSettings,
} from './types';
import {
  countUnreadAlertLogs,
  desktopApi,
  formatDateTime,
  formatLogTime,
  hasDesktopBridge,
  canJoinAutoSwitch,
  accountHasVisibleQuota,
  needsHandling,
  needsQuotaAutoSync,
  isManagedProductAccount,
  pickStartupFloatProduct,
  pruneAutoSwitchAccountIds,
  quotaAutoSyncStaleMs,
  selectedAccountIdsEqual,
  summarizeRefreshAllResults,
  formatTokenCheckMessage,
  QUOTA_AUTO_SYNC_MIN_GAP_MS,
  withCurrentFlag,
  resolveAuthStateAfterSnapshot,
} from './api/desktop';
import { logTypeLabel, toAntigravityUserMessage, toCursorUserMessage, toUserMessage } from './api/user-messages';
import {
  accountsFromSnapshot,
  isManagedProduct,
  importAccountCopy,
  oauthFinishedCopy,
  officialClientLabel,
  productActions,
  productLabel,
  productOfAccount,
  syncFailedCopy,
  toProductUserMessage,
} from './api/product-adapter';
import { productById, readStoredProduct } from './data/products';
import {
  setAntigravityAccounts,
  setAntigravityOAuthStatus,
  setAntigravityStatus,
  setAppInfo,
  setAuthState,
  setAutoSwitchConfig,
  setCodexAccounts,
  setCodexStatus,
  setCursorAccounts,
  setCursorOAuthStatus,
  setCursorStatus,
  setDaemonState,
  setOAuthStatus,
  setSelectedAccountIds,
  setUpdateStatus,
  useDesktopStore,
} from './state/desktop-store';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import QuotasView from './components/QuotasView';
import AutoSwitchView from './components/AutoSwitchView';
import AccountsView from './components/AccountsView';
import SettingsView from './components/SettingsView';
import AuthStatusBanner from './components/AuthStatusBanner';
import { APP_GITHUB_URL } from './brand';
import { 
  Bell, 
  X, 
  CheckCircle, 
  AlertCircle, 
  Info, 
  ShieldAlert, 
  HelpCircle,
  Trash2,
  Activity,
  RefreshCw,
  LoaderCircle,
  ArrowLeftRight,
} from 'lucide-react';

const desktopBridgeAvailable = hasDesktopBridge();
const actions = productActions();

function updateChannelForUi(status: DesktopUpdateStatus | null): SystemSettings['updateChannel'] {
  const channel = String(status?.channel || '').toLowerCase();
  if (channel.includes('dev')) return 'Developer Channel';
  if (channel.includes('stable')) return 'Stable Channel';
  return 'Beta Channel';
}

function latestStatusForUi(status: DesktopUpdateStatus | null): string {
  if (!status) return '未知';
  if (status.status === 'error') return status.error || '检查更新失败';
  if (status.status === 'downloaded') return '可安装';
  if (status.status === 'checking') return '检查中';
  if (status.status === 'disabled') return status.message || '更新已禁用';
  return status.message || '已是最新';
}

function settingsFromDesktopState(
  config: DesktopAutoSwitchConfig,
  appInfo: DesktopAppInfo | null,
  codexStatus: DesktopCodexStatus | null,
  updateStatus: DesktopUpdateStatus | null,
  cursorStatus: DesktopCursorStatus | null = null,
  antigravityStatus: DesktopAntigravityStatus | null = null,
): SystemSettings {
  return {
    globalSwitch: !!config.enabled,
    fiveHourThreshold: Number(config.primary_threshold ?? 20),
    weeklyThreshold: Number(config.secondary_threshold ?? 30),
    clientDetected: !!codexStatus?.installed,
    cursorDetected: !!cursorStatus?.installed,
    cursorHasLocalLogin: !!cursorStatus?.vscdbPresent,
    antigravityDetected: !!antigravityStatus?.installed,
    antigravityHasLocalLogin: !!antigravityStatus?.vscdbPresent,
    updateChannel: updateChannelForUi(updateStatus),
    version: appInfo?.version || INITIAL_SETTINGS.version,
    latestStatus: latestStatusForUi(updateStatus),
  };
}

function DashboardApp() {
  // Main UI States
  const [activeTab, setActiveTab] = useState<'accounts' | 'quotas' | 'autoswitch' | 'settings'>(() => {
    if (desktopBridgeAvailable) return 'quotas';
    return INITIAL_ACCOUNTS.some(needsHandling) ? 'accounts' : 'quotas';
  });
  const [accountsFilterTab, setAccountsFilterTab] = useState<'all' | 'current' | 'warning'>('all');
  const didPickLandingTab = useRef(false);
  const didAutoShowFloat = useRef(false);
  const [product, setProduct] = useState<ProductKind>(() => readStoredProduct());
  const {
    codexAccounts,
    cursorAccounts,
    antigravityAccounts,
    daemonState,
    autoSwitchConfig,
    appInfo,
    codexStatus,
    cursorStatus,
    antigravityStatus,
    updateStatus,
    authState,
    oauthStatus,
    cursorOAuthStatus,
    antigravityOAuthStatus,
    selectedAccountIds,
  } = useDesktopStore();
  const accounts = accountsFromSnapshot(product, { accounts: codexAccounts, cursorAccounts, antigravityAccounts });
  const [settings, setSettings] = useState<SystemSettings>(INITIAL_SETTINGS);
  const [logs, setLogs] = useState<LogEntry[]>(desktopBridgeAvailable ? [] : INITIAL_LOGS);
  const [isResolvingAuth, setIsResolvingAuth] = useState(false);
  const [dashboardLoadState, setDashboardLoadState] = useState<'loading' | 'ready' | 'error'>(
    desktopBridgeAvailable ? 'loading' : 'ready',
  );
  const [dashboardLoadError, setDashboardLoadError] = useState<string | null>(null);
  const hasLoadedDashboard = useRef(!desktopBridgeAvailable);
  const quotaAutoSyncPromise = useRef<Promise<void> | null>(null);
  const lastQuotaAutoSyncAt = useRef(0);
  const accountsRef = useRef<AccountQuota[]>(accounts);
  const codexAccountsRef = useRef<AccountQuota[]>(codexAccounts);
  const cursorAccountsRef = useRef<AccountQuota[]>(cursorAccounts);
  const antigravityAccountsRef = useRef<AccountQuota[]>(antigravityAccounts);
  const productRef = useRef(product);
  const cursorOAuthStatusRef = useRef<DesktopOAuthStatus | null>(cursorOAuthStatus);
  const antigravityOAuthStatusRef = useRef<DesktopOAuthStatus | null>(antigravityOAuthStatus);
  const accountOperationIds = useRef<Set<string>>(new Set());
  const autoSwitchConfigRef = useRef<DesktopAutoSwitchConfig>(autoSwitchConfig);
  const authStateRef = useRef<DesktopAuthState>(authState);
  const configSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const configSaveRevision = useRef(0);
  // User-initiated config saves still in flight. While one is pending, a
  // snapshot that started before the click must not put the old config back.
  const configSavesPending = useRef(0);

  // Every auth-state write goes through the same busy-placeholder filter as a
  // snapshot, so a lock-busy "unknown" from a daemon tick or an OAuth result
  // cannot wipe a real conflict banner or lift the auto-sync gate.
  const applyAuthState = useCallback((incoming: DesktopAuthState | null | undefined) => {
    const next = resolveAuthStateAfterSnapshot(incoming, authStateRef.current);
    setAuthState(next);
    authStateRef.current = next;
  }, []);
  
  const selectedAccountIdsRef = useRef<string[]>(selectedAccountIds);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    codexAccountsRef.current = codexAccounts;
  }, [codexAccounts]);

  useEffect(() => {
    cursorAccountsRef.current = cursorAccounts;
  }, [cursorAccounts]);

  useEffect(() => {
    antigravityAccountsRef.current = antigravityAccounts;
  }, [antigravityAccounts]);

  useEffect(() => {
    cursorOAuthStatusRef.current = cursorOAuthStatus;
  }, [cursorOAuthStatus]);

  useEffect(() => {
    antigravityOAuthStatusRef.current = antigravityOAuthStatus;
  }, [antigravityOAuthStatus]);

  useEffect(() => {
    autoSwitchConfigRef.current = autoSwitchConfig;
  }, [autoSwitchConfig]);

  useEffect(() => {
    selectedAccountIdsRef.current = selectedAccountIds;
  }, [selectedAccountIds]);

  // UI Interactive triggers
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const refreshAllKindRef = useRef<ProductKind | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [authBannerDismissedKey, setAuthBannerDismissedKey] = useState<string | null>(null);
  const [lastReadLogId, setLastReadLogId] = useState<string | null>(null);
  const [showSupport, setShowSupport] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  // Real switch counter for this session (manual switches, manual checks, and
  // daemon auto-switches all increment it).
  const [sessionSwitchCount, setSessionSwitchCount] = useState(0);
  // In-app delete confirmation (replaces the native window.confirm).
  const [deleteTarget, setDeleteTarget] = useState<AccountQuota | null>(null);
  const [switchTarget, setSwitchTarget] = useState<AccountQuota | null>(null);
  const [isConfirmingSwitch, setIsConfirmingSwitch] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // Custom Toast notifications array
  const [toasts, setToasts] = useState<{ id: string; msg: string; type: 'success' | 'info' | 'warning' | 'error' }[]>([]);

  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissToast = useCallback((id: string) => {
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.current.delete(id);
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);
  const addToast = useCallback((msg: string, type: 'success' | 'info' | 'warning' | 'error' = 'info', source: ProductKind | 'auto' = 'auto') => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const kind = source === 'auto' ? productRef.current : source;
    const text = toProductUserMessage(kind, msg);
    setToasts(prev => [...prev, { id, msg: text, type }]);
    const timer = setTimeout(() => {
      toastTimers.current.delete(id);
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
    toastTimers.current.set(id, timer);
  }, []);

  const addLogEntry = useCallback((message: string, type: LogEntry['type'], source: ProductKind | 'auto' = 'auto') => {
    const timestamp = formatLogTime();
    const kind = source === 'auto' ? productRef.current : source;
    const newLog: LogEntry = {
      id: `l_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp,
      message: toProductUserMessage(kind, message),
      type,
    };
    // Cap the in-memory feed so long sessions cannot grow it without bound.
    setLogs(prev => [newLog, ...prev].slice(0, 500));
  }, []);

  useEffect(() => {
    if (!showNotifications) return;
    const newestId = logs[0]?.id;
    if (!newestId) return;
    setLastReadLogId(newestId);
  }, [showNotifications, logs]);

  const runAccountOperation = useCallback(async <T,>(id: string, task: () => Promise<T>): Promise<T> => {
    if (accountOperationIds.current.has(id)) {
      throw new Error('该账号已有操作正在进行，请稍候重试。');
    }
    accountOperationIds.current.add(id);
    try {
      return await task();
    } finally {
      accountOperationIds.current.delete(id);
    }
  }, []);

  // Discard out-of-order dashboard snapshots: a slow older load must never
  // overwrite state written by a newer one (or reset the config write-base
  // refs to stale values).
  const dashboardLoadSeqRef = useRef(0);
  const wasOAuthPendingRef = useRef(false);
  const wasCursorOAuthPendingRef = useRef(false);
  const wasAntigravityOAuthPendingRef = useRef(false);
  const oauthStatusRef = useRef<DesktopOAuthStatus | null>(oauthStatus);
  const oauthReportKeyRef = useRef<string | null>(null);

  useEffect(() => {
    oauthStatusRef.current = oauthStatus;
  }, [oauthStatus]);

  useEffect(() => {
    productRef.current = product;
  }, [product]);

  const persistProduct = useCallback((next: ProductKind) => {
    setProduct(next);
    localStorage.setItem('cam_product', next);
    if (hasDesktopBridge()) {
      void desktopApi.setFloatProduct(next).catch(() => {});
    }
  }, []);

  const setVisibleAccounts = useCallback((updater: SetStateAction<AccountQuota[]>) => {
    const apply = (prev: AccountQuota[]) => typeof updater === 'function' ? updater(prev) : updater;
    const current = productById(productRef.current).id;
    if (current === 'antigravity') setAntigravityAccounts(apply);
    else if (current === 'cursor') setCursorAccounts(apply);
    else setCodexAccounts(apply);
  }, []);

  const applyCurrentAccountBadge = useCallback((kind: ProductKind | undefined, currentId: string | null | undefined) => {
    if (!kind || !currentId) return;
    const apply = (prev: AccountQuota[]) => withCurrentFlag(prev, currentId);
    if (kind === 'antigravity') setAntigravityAccounts(apply);
    else if (kind === 'cursor') setCursorAccounts(apply);
    else if (kind === 'codex') setCodexAccounts(apply);
  }, []);

  const applyCursorState = useCallback((snapshot: Awaited<ReturnType<typeof desktopApi.loadCursorState>>) => {
    setCursorAccounts(snapshot.accounts);
    const incomingOAuth = snapshot.oauthStatus;
    const localOAuth = cursorOAuthStatusRef.current;
    const nextOAuth = localOAuth?.pending && !incomingOAuth.pending && incomingOAuth.status === 'idle'
      ? localOAuth
      : incomingOAuth;
    setCursorOAuthStatus(nextOAuth);
    cursorOAuthStatusRef.current = nextOAuth;
    setCursorStatus(snapshot.cursorStatus);
    setSettings((prev) => ({
      ...prev,
      cursorDetected: !!snapshot.cursorStatus?.installed,
      cursorHasLocalLogin: !!snapshot.cursorStatus?.vscdbPresent,
    }));
    const pending = !!nextOAuth.pending;
    if (pending && !wasCursorOAuthPendingRef.current && productRef.current === 'cursor') {
      persistProduct('cursor');
      setActiveTab('accounts');
    }
    wasCursorOAuthPendingRef.current = pending;
  }, [persistProduct]);

  const applyAntigravityState = useCallback((snapshot: Awaited<ReturnType<typeof desktopApi.loadAntigravityState>>) => {
    setAntigravityAccounts(snapshot.accounts);
    const incomingOAuth = snapshot.oauthStatus;
    const localOAuth = antigravityOAuthStatusRef.current;
    const nextOAuth = localOAuth?.pending && !incomingOAuth.pending && incomingOAuth.status === 'idle'
      ? localOAuth
      : incomingOAuth;
    setAntigravityOAuthStatus(nextOAuth);
    antigravityOAuthStatusRef.current = nextOAuth;
    setAntigravityStatus(snapshot.antigravityStatus);
    setSettings((prev) => ({
      ...prev,
      antigravityDetected: !!snapshot.antigravityStatus?.installed,
      antigravityHasLocalLogin: !!snapshot.antigravityStatus?.vscdbPresent,
    }));
    const pending = !!nextOAuth.pending;
    if (pending && !wasAntigravityOAuthPendingRef.current && productRef.current === 'antigravity') {
      persistProduct('antigravity');
      setActiveTab('accounts');
    }
    wasAntigravityOAuthPendingRef.current = pending;
  }, [persistProduct]);

  const applyDashboardState = useCallback((snapshot: Awaited<ReturnType<typeof desktopApi.loadDashboardState>>) => {
    setCodexAccounts(snapshot.accounts);
    accountsRef.current = isManagedProduct(productRef.current) ? accountsRef.current : snapshot.accounts;
    const baseConfig = configSavesPending.current > 0 ? autoSwitchConfigRef.current : snapshot.config;
    const prunedSelected = baseConfig.account_scope_mode === 'selected'
      ? pruneAutoSwitchAccountIds(baseConfig.selected_account_ids || [], snapshot.accounts)
      : snapshot.accounts.filter(canJoinAutoSwitch).map((account) => account.id);
    let nextConfig = baseConfig;
    if (
      baseConfig.account_scope_mode === 'selected'
      && !selectedAccountIdsEqual(baseConfig.selected_account_ids || [], prunedSelected)
    ) {
      nextConfig = {
        ...baseConfig,
        selected_account_ids: prunedSelected,
      };
      const revision = configSaveRevision.current;
      const saveOperation = configSaveQueue.current
        .catch(() => {})
        .then(() => {
          if (revision !== configSaveRevision.current) return;
          return desktopApi.saveAutoSwitchConfig(nextConfig);
        });
      configSaveQueue.current = saveOperation.catch(() => {});
    }
    setAutoSwitchConfig(nextConfig);
    autoSwitchConfigRef.current = nextConfig;
    setAppInfo(snapshot.appInfo);
    setCodexStatus(snapshot.codexStatus);
    setUpdateStatus(snapshot.updateStatus);
    applyAuthState(snapshot.authState);
    const incomingOAuth = snapshot.oauthStatus;
    const localOAuth = oauthStatusRef.current;
    const nextOAuth = localOAuth?.pending && !incomingOAuth.pending && incomingOAuth.status === 'idle'
      ? localOAuth
      : incomingOAuth;
    setOAuthStatus(nextOAuth);
    oauthStatusRef.current = nextOAuth;
    if (nextOAuth.pending && !wasOAuthPendingRef.current && productRef.current === 'codex') {
      persistProduct('codex');
      setActiveTab('accounts');
    }
    wasOAuthPendingRef.current = !!nextOAuth.pending;
    setSettings((prev) => ({
      ...settingsFromDesktopState(nextConfig, snapshot.appInfo, snapshot.codexStatus, snapshot.updateStatus),
      cursorDetected: prev.cursorDetected,
      cursorHasLocalLogin: prev.cursorHasLocalLogin,
      antigravityDetected: prev.antigravityDetected,
      antigravityHasLocalLogin: prev.antigravityHasLocalLogin,
    }));
    setDaemonState({
      status: snapshot.daemonRunning ? 'Running' : 'Stopped',
      syncInterval: snapshot.daemonSyncInterval,
      lastChecked: snapshot.daemonLastRunAt ? formatDateTime(snapshot.daemonLastRunAt) : '',
      lastSuccessAt: snapshot.daemonLastSuccessAt,
      lastError: snapshot.daemonLastError ? toUserMessage(snapshot.daemonLastError) : null,
      pausedReason: snapshot.daemonPausedReason ? toUserMessage(snapshot.daemonPausedReason) : null,
    });
    setSelectedAccountIds(prunedSelected);
    selectedAccountIdsRef.current = prunedSelected;
  }, [applyAuthState, persistProduct]);

  type DashboardLoadResult = Awaited<ReturnType<typeof desktopApi.loadDashboardState>> & {
    cursorAccounts: AccountQuota[];
    antigravityAccounts: AccountQuota[];
  };
  const latestDashboardLoadRef = useRef<Promise<DashboardLoadResult | null> | null>(null);

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
      if (seq !== dashboardLoadSeqRef.current) return null;
      const snapshot = bundle.dashboard;
      const cursorSnapshot = bundle.cursor;
      const antigravitySnapshot = bundle.antigravity;
      applyDashboardState(snapshot);
      if (cursorSnapshot) applyCursorState(cursorSnapshot);
      if (antigravitySnapshot) applyAntigravityState(antigravitySnapshot);
      hasLoadedDashboard.current = true;
      const landingProduct = antigravitySnapshot?.oauthStatus?.pending
        ? 'antigravity'
        : cursorSnapshot?.oauthStatus?.pending
          ? 'cursor'
          : snapshot.oauthStatus.pending
            ? 'codex'
            : productRef.current;
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
      if (seq !== dashboardLoadSeqRef.current) return null;
      const message = toUserMessage(error instanceof Error ? error.message : String(error));
      addToast(message, 'error', 'codex');
      addLogEntry(message, 'error', 'codex');
      if (!hasLoadedDashboard.current) {
        setDashboardLoadState('error');
        setDashboardLoadError(message);
      }
      return null;
    }
  }, [addLogEntry, addToast, applyAntigravityState, applyCursorState, applyDashboardState]);

  const loadDashboardState = useCallback(async (
    showLoading = false,
    options?: { skipOfficialSync?: boolean },
  ): Promise<DashboardLoadResult | null> => {
    if (!desktopBridgeAvailable) return null;
    const seq = ++dashboardLoadSeqRef.current;
    const run = loadDashboardStateOnce(seq, showLoading, options);
    latestDashboardLoadRef.current = run;
    const result = await run;
    if (result !== null || seq === dashboardLoadSeqRef.current) return result;
    // A newer load (typically the 150 ms patch reload that follows this
    // operation's own quota:updated event) took over and applied the fresher
    // snapshot. Callers that read the snapshot for their toast must see that
    // result instead of a null that looks like "still updating". Follow the
    // chain until a load actually finished or nothing newer exists.
    let latest = latestDashboardLoadRef.current;
    while (latest && latest !== run) {
      const outcome = await latest;
      if (outcome !== null) return outcome;
      const newer = latestDashboardLoadRef.current;
      if (newer === latest) return null;
      latest = newer;
    }
    return null;
  }, [loadDashboardStateOnce]);

  const queueQuotaAutoSync = useCallback((candidateAccounts: AccountQuota[]) => {
    if (!desktopBridgeAvailable || quotaAutoSyncPromise.current) return;
    if (Date.now() - lastQuotaAutoSyncAt.current < QUOTA_AUTO_SYNC_MIN_GAP_MS) return;
    const authBlocked = authStateRef.current.status === 'conflict';
    const staleAccounts = candidateAccounts.filter((account) => {
      if (accountOperationIds.current.has(account.id)) return false;
      if (authBlocked && !isManagedProductAccount(account)) return false;
      return needsQuotaAutoSync(
        account,
        quotaAutoSyncStaleMs(account, autoSwitchConfigRef.current.sync_interval_minutes),
      );
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
          const message = toUserMessage(error instanceof Error ? error.message : String(error));
          addLogEntry(`${account.email}: ${message}`, 'info', kind);
        }
      }
      await loadDashboardState(false);
    })().finally(() => {
      quotaAutoSyncPromise.current = null;
    });
  }, [addLogEntry, loadDashboardState]);

  // Escape closes the topmost dismissible overlay.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (deleteTarget) {
        if (!isDeletingAccount) setDeleteTarget(null);
        return;
      }
      if (switchTarget) {
        if (!isConfirmingSwitch) setSwitchTarget(null);
        return;
      }
      if (showNotifications) { setShowNotifications(false); return; }
      if (showSupport) { setShowSupport(false); return; }
      if (showUpdates) { setShowUpdates(false); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteTarget, isDeletingAccount, switchTarget, isConfirmingSwitch, showNotifications, showSupport, showUpdates]);

  useEffect(() => {
    if (deleteTarget || switchTarget || showSupport || showUpdates) {
      setShowNotifications(false);
    }
  }, [deleteTarget, switchTarget, showSupport, showUpdates]);

  useEffect(() => {
    if (!desktopBridgeAvailable) return;
    desktopApi.getAppInfo()
      .then((info) => {
        setAppInfo(info);
        setSettings(prev => ({ ...prev, version: info.version || prev.version }));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!desktopBridgeAvailable) return;
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
    }, 5000);

    const syncTimer = window.setInterval(() => {
      if (!disposed) {
        queueQuotaAutoSync([
          ...codexAccountsRef.current,
          ...cursorAccountsRef.current,
          ...antigravityAccountsRef.current,
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
      }, 150);
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
      onAutoSwitch: (result) => {
        if (result?.authState) applyAuthState(result.authState);
        if (result?.switched) {
          setSessionSwitchCount(count => count + 1);
          if (result.to?.id) applyCurrentAccountBadge('codex', result.to.id);
          addToast(`已自动切换至 ${result.to?.email || '新账号'}`, 'warning', 'codex');
        }
        loadDashboardState(false);
      },
      onUpdateStatus: (status) => {
        setUpdateStatus(status);
        setSettings(prev => ({ ...prev, latestStatus: latestStatusForUi(status), updateChannel: updateChannelForUi(status) }));
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
  }, [addLogEntry, addToast, applyAuthState, applyCurrentAccountBadge, loadDashboardState, queueQuotaAutoSync]);

  const reportOAuthFinished = useCallback((status: DesktopOAuthStatus, source: ProductKind | 'auto' = 'auto') => {
    if (status.pending) return;
    if (status.status === 'idle' || status.status === 'pending') return;
    const kind = source === 'auto' ? productRef.current : source;
    const result = status.result;
    const key = [
      kind,
      status.status,
      result?.accountId || '',
      result?.email || '',
      result?.mismatch ? '1' : '0',
      result?.updated ? '1' : '0',
      status.targetAccountId || '',
      status.message || '',
    ].join('|');
    if (oauthReportKeyRef.current === key) return;
    oauthReportKeyRef.current = key;

    if (status.status === 'cancelled') {
      addToast('授权已取消。', 'warning', kind);
      addLogEntry('授权已取消。', 'warning', kind);
      return;
    }
    if (status.status === 'error' || status.status === 'expired') {
      const message = toUserMessage(status.message || '授权未完成。');
      addToast(message, 'warning', kind);
      addLogEntry(message, 'warning', kind);
      return;
    }
    if (status.status !== 'completed') return;
    if (result?.authState) applyAuthState(result.authState);
    if (result?.mismatch) {
      if (kind === 'codex' && result?.accountId && result?.switched !== false) {
        applyCurrentAccountBadge('codex', result.accountId);
      }
      const message = oauthFinishedCopy({
        product: kind,
        email: result.email,
        mismatch: true,
      });
      addToast(message, 'warning', kind);
      addLogEntry(message, 'warning', kind);
      return;
    }
    const isReauth = !!(status.targetAccountId || result?.targetAccountId);
    if (kind === 'codex' && result?.accountId && !isReauth) {
      applyCurrentAccountBadge('codex', result.accountId);
    }
    const message = oauthFinishedCopy({
      product: kind,
      email: result?.email,
      isReauth,
      updated: !!result?.updated,
      switched: !!result?.switched,
    });
    addToast(message, 'success', kind);
    addLogEntry(message, 'success', kind);
    if (result?.switchError) {
      const switchMessage = toUserMessage(result.switchError);
      addToast(switchMessage, 'warning', kind);
      addLogEntry(switchMessage, 'warning', kind);
    }
    if (kind === 'antigravity' && result?.accountId) {
      void actions.refreshQuota('antigravity', result.accountId)
        .catch(() => {})
        .then(() => loadDashboardState(false));
    }
  }, [addLogEntry, addToast, applyAuthState, applyCurrentAccountBadge, loadDashboardState]);

  const oauthStatusFor = (kind: ProductKind) => {
    if (kind === 'antigravity') return antigravityOAuthStatusRef.current;
    if (kind === 'cursor') return cursorOAuthStatusRef.current;
    return oauthStatusRef.current;
  };

  // The engine allows one browser authorization at a time across all three
  // products, so the guard has to look at all three as well.
  const anyOAuthPending = () => !!oauthStatusFor('codex')?.pending
    || !!oauthStatusFor('cursor')?.pending
    || !!oauthStatusFor('antigravity')?.pending;

  // After the add/reauth call rejected, a settled "completed" status can only
  // belong to an earlier flow; re-reporting it would toast a stale account.
  const oauthStatusEndedThisFlow = (status: DesktopOAuthStatus | null | undefined) => !!status
    && !status.pending
    && status.status !== 'completed'
    && status.status !== 'idle'
    && status.status !== 'pending';

  const markOAuthPending = useCallback((targetAccountId: string | null) => {
    dashboardLoadSeqRef.current += 1;
    oauthReportKeyRef.current = null;
    const nextStatus: DesktopOAuthStatus = {
      status: 'pending',
      pending: true,
      targetAccountId,
      message: '请在浏览器完成授权，完成后会自动回来。',
      result: null,
      expiresAt: null,
      callbackPort: 1455,
    };
    const kind = productById(productRef.current).id;
    if (kind === 'antigravity') {
      antigravityOAuthStatusRef.current = nextStatus;
      setAntigravityOAuthStatus(nextStatus);
      return;
    }
    if (kind === 'cursor') {
      cursorOAuthStatusRef.current = nextStatus;
      setCursorOAuthStatus(nextStatus);
      return;
    }
    oauthStatusRef.current = nextStatus;
    setOAuthStatus(nextStatus);
  }, []);

  useEffect(() => {
    if (!desktopBridgeAvailable || !oauthStatus?.pending) return;
    let disposed = false;
    let failCount = 0;
    const pollOAuthStatus = async () => {
      try {
        const status = await desktopApi.getOAuthStatus();
        failCount = 0;
        if (disposed) return;
        if (status.pending) {
          setOAuthStatus(status);
          return;
        }
        setOAuthStatus(status);
        await loadDashboardState(false);
        reportOAuthFinished(status, 'codex');
      } catch {
        failCount += 1;
        if (!disposed && (failCount === 5 || failCount % 15 === 0)) {
          addToast('授权状态读取失败，可点取消后重试。', 'error', 'codex');
        }
      }
    };
    void pollOAuthStatus();
    const timer = window.setInterval(() => {
      void pollOAuthStatus();
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [addToast, loadDashboardState, oauthStatus?.pending, reportOAuthFinished]);

  useEffect(() => {
    if (!desktopBridgeAvailable || !cursorOAuthStatus?.pending) return;
    let disposed = false;
    let failCount = 0;
    const pollCursorOAuthStatus = async () => {
      try {
        const status = await desktopApi.getCursorOAuthStatus();
        failCount = 0;
        if (disposed) return;
        setCursorOAuthStatus(status);
        if (status.pending) return;
        await loadDashboardState(false);
        reportOAuthFinished(status, 'cursor');
      } catch {
        failCount += 1;
        if (!disposed && (failCount === 5 || failCount % 15 === 0)) {
          addToast('授权状态读取失败，可点取消后重试。', 'error', 'cursor');
        }
      }
    };
    void pollCursorOAuthStatus();
    const timer = window.setInterval(() => {
      void pollCursorOAuthStatus();
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [addToast, loadDashboardState, cursorOAuthStatus?.pending, reportOAuthFinished]);

  useEffect(() => {
    if (!desktopBridgeAvailable || !antigravityOAuthStatus?.pending) return;
    let disposed = false;
    let failCount = 0;
    const pollAntigravityOAuthStatus = async () => {
      try {
        const status = await desktopApi.getAntigravityOAuthStatus();
        failCount = 0;
        if (disposed) return;
        setAntigravityOAuthStatus(status);
        if (status.pending) return;
        await loadDashboardState(false);
        reportOAuthFinished(status, 'antigravity');
      } catch {
        failCount += 1;
        if (!disposed && (failCount === 5 || failCount % 15 === 0)) {
          addToast('授权状态读取失败，可点取消后重试。', 'error', 'antigravity');
        }
      }
    };
    void pollAntigravityOAuthStatus();
    const timer = window.setInterval(() => {
      void pollAntigravityOAuthStatus();
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [addToast, loadDashboardState, antigravityOAuthStatus?.pending, reportOAuthFinished]);

  // Global Refresh All trigger
  const handleRefreshAll = async () => {
    if (desktopBridgeAvailable) {
      const currentProduct = productById(productRef.current);
      const kind = currentProduct.id;
      refreshAllKindRef.current = kind;
      setIsRefreshingAll(true);
      addToast('正在刷新全部账号额度...', 'info', kind);
      addLogEntry('开始同步全部账号额度...', 'info', kind);
      try {
        const results = await actions.refreshAllQuotas(kind);
        const { refreshed, reauthSkipped, bannedSkipped, failed, networkFailed } = summarizeRefreshAllResults(results);
        const snapshot = await loadDashboardState(false);
        if (snapshot && currentProduct.features.autoSwitch) queueQuotaAutoSync(snapshot.accounts);
        if (productRef.current !== kind) return;
        if (failed || bannedSkipped || networkFailed) {
          const parts = [`已刷新 ${refreshed} 个`];
          if (reauthSkipped) parts.push(`${reauthSkipped} 个需重新授权`);
          if (bannedSkipped && currentProduct.features.autoSwitch) parts.push(`${bannedSkipped} 个已封号`);
          if (networkFailed) parts.push(`${networkFailed} 个额度暂时没刷到，登录还在`);
          if (failed) parts.push(isManagedProduct(kind) ? `${failed} 个这次没查清` : `${failed} 个同步失败`);
          addToast(parts.join('，'), 'warning', kind);
          const logParts = [];
          if (reauthSkipped) logParts.push(`需重新授权 ${reauthSkipped} 个`);
          if (bannedSkipped && currentProduct.features.autoSwitch) logParts.push(`封号 ${bannedSkipped} 个`);
          if (networkFailed) logParts.push(`暂时没刷到 ${networkFailed} 个`);
          if (failed) logParts.push(isManagedProduct(kind) ? `没查清 ${failed} 个` : `失败 ${failed} 个`);
          addLogEntry(`额度刷新完成：${logParts.join('，')}。`, 'warning', kind);
        } else if (reauthSkipped) {
          addToast(`已刷新 ${refreshed} 个；${reauthSkipped} 个需重新授权`, 'info', kind);
          addLogEntry(`额度刷新完成；${reauthSkipped} 个账号需要重新授权。`, 'info', kind);
        } else {
          addToast(`已刷新 ${refreshed} 个账号额度`, 'success', kind);
          addLogEntry('全部账号额度同步完成。', 'success', kind);
        }
      } catch (error) {
        if (productRef.current === kind) {
          const message = toUserMessage(error instanceof Error ? error.message : String(error));
          addToast(message, 'error', kind);
          addLogEntry(message, 'error', kind);
        }
      } finally {
        if (refreshAllKindRef.current === kind) refreshAllKindRef.current = null;
        if (productRef.current === kind) setIsRefreshingAll(false);
      }
      return;
    }
    const kind = productRef.current;
    refreshAllKindRef.current = kind;
    setIsRefreshingAll(true);
    addToast('正在刷新全部账号额度...', 'info', kind);
    addLogEntry('开始同步全部账号额度...', 'info', kind);

    setTimeout(() => {
      if (refreshAllKindRef.current === kind) refreshAllKindRef.current = null;
      if (productRef.current !== kind) return;
      setVisibleAccounts(prev => prev.map(acc => {
        // Randomly adjust quota slightly to simulate active refreshing
        if (acc.status === 'EXPIRED') return acc;
        const change = Math.floor(Math.random() * 200) + 50;
        const newRemaining = Math.max(0, (acc.fiveHourQuotaRemaining ?? 0) - change);
        return {
          ...acc,
          fiveHourQuotaRemaining: newRemaining,
          status: newRemaining <= 0 ? 'EXPIRED' : acc.status,
          tokenValidity: '剩余 23 小时 59 分钟',
        };
      }));
      setIsRefreshingAll(false);
      addToast('已刷新全部账号额度', 'success', kind);
      addLogEntry('全部账号额度同步完成。', 'success', kind);
    }, 1500);
  };

  // Refresh single account
  const handleRefreshAccount = async (id: string) => {
    if (desktopBridgeAvailable) {
      const kind = productById(productRef.current).id;
      const account = accountsRef.current.find(item => item.id === id);
      let refreshError: unknown = null;
      try {
        await runAccountOperation(id, () => actions.refreshQuota(kind, id));
      } catch (error) {
        refreshError = error;
      }
      const snapshot = await loadDashboardState(false);
      if (snapshot && !isManagedProduct(kind)) queueQuotaAutoSync(snapshot.accounts);
      if (productRef.current !== kind) return;
      const fresh = accountsFromSnapshot(kind, snapshot).find(item => item.id === id);
      const label = account?.email || id;
      if (!refreshError) {
        if (fresh?.status === 'SUSPENDED') {
          const detail = `${label} 额度已刷新，仍需重新授权后才能继续使用`;
          addToast(detail, 'warning', kind);
          addLogEntry(detail, 'warning', kind);
          return;
        }
        if (fresh?.status === 'SYNC_FAILED') {
          const detail = fresh.warning || (syncFailedCopy(kind));
          addToast(detail, 'warning', kind);
          addLogEntry(`${label}：${detail}`, 'warning', kind);
          return;
        }
        if (fresh?.status === 'BANNED' && !isManagedProduct(kind)) {
          const detail = fresh.warning || '账号已封号，无法继续使用。';
          addToast(detail, 'error', kind);
          addLogEntry(`${label}：${detail}`, 'error', kind);
          return;
        }
        if (fresh?.status === 'LIMITED' || fresh?.status === 'EXPIRED') {
          const detail = fresh.warning || (fresh.status === 'EXPIRED' ? '额度已用尽。' : '额度已达上限或触发限流。');
          addToast(detail, 'warning', kind);
          addLogEntry(`${label}：${detail}`, 'warning', kind);
          return;
        }
        if (!snapshot || !fresh) {
          addToast('额度已请求，列表还在更新，请稍候。', 'info', kind);
          return;
        }
        if (!accountHasVisibleQuota(fresh)) {
          const detail = fresh.warning || syncFailedCopy(kind);
          addToast(detail, 'warning', kind);
          addLogEntry(`${label}：${detail}`, 'warning', kind);
          return;
        }
        addToast(`${label} 额度已刷新`, 'success', kind);
        addLogEntry(`账号额度已刷新：${label}`, 'success', kind);
        return;
      }
      if (fresh?.status === 'BANNED' && !isManagedProduct(kind)) {
        const detail = fresh.warning || '账号已封号，无法继续使用。';
        addToast(detail, 'error', kind);
        addLogEntry(`${label}：${detail}`, 'error', kind);
        return;
      }
      if (fresh?.status === 'LIMITED' || fresh?.status === 'EXPIRED') {
        const detail = fresh.warning || (fresh.status === 'EXPIRED' ? '额度已用尽。' : '额度已达上限或触发限流。');
        addToast(detail, 'warning', kind);
        addLogEntry(`${label}：${detail}`, 'warning', kind);
        return;
      }
      if (fresh?.status === 'SUSPENDED') {
        const detail = fresh.warning || '该账号需要重新授权后才能刷新额度';
        addToast(detail, 'warning', kind);
        addLogEntry(`${label}：${detail}`, 'warning', kind);
        return;
      }
      if (fresh?.status === 'SYNC_FAILED') {
        const detail = fresh.warning || (syncFailedCopy(kind));
        addToast(detail, 'warning', kind);
        addLogEntry(`${label}：${detail}`, 'warning', kind);
        return;
      }
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
      addToast(message, 'error', kind);
      addLogEntry(message, 'error', kind);
      throw refreshError;
    }
    setVisibleAccounts(prev => prev.map(acc => {
      if (acc.id === id) {
        addToast(`账号 ${acc.email || acc.name} 的额度已重新同步`, 'success');
        return {
          ...acc,
          fiveHourQuotaRemaining: Math.min(acc.fiveHourQuotaTotal, (acc.fiveHourQuotaRemaining ?? 0) + 400),
          status: 'ACTIVE',
        };
      }
      return acc;
    }));
  };

  const handleRefreshToken = async (id: string) => {
    if (!desktopBridgeAvailable) return;
    const kind = productRef.current;
    const account = accountsRef.current.find(item => item.id === id);
    try {
      const result = await runAccountOperation(id, () => (
        actions.refreshToken(kind, id)
      ));
      const snapshot = await loadDashboardState(false);
      if (productRef.current !== kind) return;
      const fresh = accountsFromSnapshot(kind, snapshot).find(item => item.id === id);
      if (fresh?.status === 'SUSPENDED' || result.reauthRequired) {
        const detail = `${account?.email || id} 仍需重新授权后才能继续使用`;
        addToast(detail, 'warning', kind);
        addLogEntry(detail, 'warning', kind);
        return;
      }
      if (fresh?.status === 'BANNED' && !isManagedProduct(kind)) {
        const detail = fresh.warning || '账号已封号，无法继续使用。';
        addToast(detail, 'error', kind);
        addLogEntry(`${account?.email || id}：${detail}`, 'error', kind);
        return;
      }
      if (!result.ok) {
        const raw = String(result.error || '').trim();
        throw new Error(raw && /token refresh failed/i.test(raw) ? raw : `Token refresh failed${raw ? `: ${raw}` : ''}`);
      }
      addToast(result?.skipped ? `${account?.email || id} 的令牌仍然有效` : `${account?.email || id} 的令牌已刷新`, 'success', kind);
      addLogEntry(`令牌检查完成：${account?.email || id}`, 'success', kind);
    } catch (error) {
      const snapshot = await loadDashboardState(false);
      if (productRef.current !== kind) return;
      const fresh = accountsFromSnapshot(kind, snapshot).find(item => item.id === id);
      if (fresh?.status === 'SUSPENDED') {
        const detail = `${account?.email || id} 仍需重新授权后才能继续使用`;
        addToast(detail, 'warning', kind);
        addLogEntry(detail, 'warning', kind);
        return;
      }
      if (fresh?.status === 'BANNED' && !isManagedProduct(kind)) {
        const detail = fresh.warning || '账号已封号，无法继续使用。';
        addToast(detail, 'error', kind);
        addLogEntry(`${account?.email || id}：${detail}`, 'error', kind);
        return;
      }
      const message = toUserMessage(error instanceof Error ? error.message : String(error));
      addToast(message, 'error', kind);
      addLogEntry(message, 'error', kind);
    }
  };

  // Toggle Daemon
  const handleToggleDaemon = async () => {
    if (desktopBridgeAvailable) {
      const nextAction = daemonState.status === 'Running' ? 'stop' : 'start';
      try {
        if (nextAction === 'stop') await desktopApi.stopDaemon();
        else await desktopApi.startDaemon();
        await loadDashboardState(false);
        if (nextAction === 'stop' && autoSwitchConfigRef.current.enabled) {
          addToast('Daemon 已停止。自动切号已打开，但不会再自动换号。', 'warning', 'codex');
        } else {
          addToast(`Daemon 已${nextAction === 'stop' ? '停止' : '启动'}`, nextAction === 'stop' ? 'warning' : 'success', 'codex');
        }
        addLogEntry(`Daemon 已${nextAction === 'stop' ? '停止' : '启动'}。`, nextAction === 'stop' ? 'warning' : 'success', 'codex');
      } catch (error) {
        const message = toUserMessage(error instanceof Error ? error.message : String(error));
        addToast(message, 'error', 'codex');
        addLogEntry(message, 'error', 'codex');
      }
      return;
    }
    setDaemonState(prev => {
      const nextStatus = prev.status === 'Running' ? 'Stopped' : 'Running';
      addToast(`Daemon 已${nextStatus === 'Running' ? '启用' : '暂停'}`, nextStatus === 'Running' ? 'success' : 'warning');
      return {
        ...prev,
        status: nextStatus,
        lastChecked: '刚刚',
      };
    });
  };

  const handlePreviewSyncInterval = (val: number) => {
    const syncInterval = Math.min(60, Math.max(1, Math.round(Number(val) || 1)));
    setDaemonState(prev => ({
      ...prev,
      syncInterval,
    }));
  };

  // Update sync interval
  const handleUpdateSyncInterval = (val: number) => {
    const syncInterval = Math.min(60, Math.max(1, Math.round(Number(val) || 1)));
    handlePreviewSyncInterval(syncInterval);
    if (desktopBridgeAvailable) {
      if (Number(autoSwitchConfigRef.current.sync_interval_minutes) === syncInterval) return;
      const nextConfig = {
        ...autoSwitchConfigRef.current,
        sync_interval_minutes: syncInterval,
      };
      void saveAutoSwitchConfig(nextConfig);
      return;
    }
    addToast(`Daemon 检查间隔已调整为 ${val} 分钟`, 'info');
    addLogEntry(`Daemon 检查间隔已调整为 ${syncInterval} 分钟。`, 'info');
  };

  // Add new account
  const handleAddAccount = async (acc: Omit<AccountQuota, 'id'>) => {
    if (desktopBridgeAvailable) {
      const kind = productById(productRef.current).id;
      if (anyOAuthPending()) {
        addToast('已有授权正在进行，请先完成或取消。', 'warning', kind);
        throw new Error('已有授权正在进行，请先完成或取消。');
      }
      markOAuthPending(null);
      addToast('正在打开授权页面，请在浏览器里完成登录。', 'info', kind);
      addLogEntry('正在为新账号打开授权。', 'info', kind);
      try {
        const added = await actions.addAccount(kind) as { authState?: DesktopAuthState };
        if (kind === 'codex' && added?.authState) applyAuthState(added.authState);
        const snapshot = await loadDashboardState(false);
        if (snapshot && !isManagedProduct(kind)) queueQuotaAutoSync(snapshot.accounts);
        if (productRef.current !== kind) return;
        reportOAuthFinished(await actions.oauthStatus(kind), kind);
      } catch (error) {
        const snapshot = await loadDashboardState(false);
        if (snapshot && !isManagedProduct(kind)) queueQuotaAutoSync(snapshot.accounts);
        if (productRef.current !== kind) throw error;
        const finished = await actions.oauthStatus(kind).catch(() => snapshot?.oauthStatus || null);
        if (oauthStatusEndedThisFlow(finished)) {
          reportOAuthFinished(finished as DesktopOAuthStatus, kind);
        } else {
          const message = toUserMessage(error instanceof Error ? error.message : String(error));
          addToast(message, 'error', kind);
          addLogEntry(message, 'error', kind);
        }
        throw error;
      }
      return;
    }
    const newAcc: AccountQuota = {
      ...acc,
      id: `acc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    };
    setVisibleAccounts(prev => [...prev, newAcc]);
    addToast(`已成功添加账号 ${acc.email}`, 'success');
  };

  const handleReauthorizeAccount = async (id: string) => {
    const kind = productById(productRef.current).id;
    if (anyOAuthPending()) {
      addToast('已有授权正在进行，请先完成或取消。', 'warning', kind);
      throw new Error('已有授权正在进行，请先完成或取消。');
    }
    markOAuthPending(id);
    addToast('正在打开授权页面，请在浏览器里完成登录。', 'info', kind);
    addLogEntry('正在打开重新授权。', 'info', kind);
    try {
      const result = await actions.reauthorize(kind, id) as { account?: { id?: string; email?: string }; mismatch?: boolean; targetAccountId?: string | null; authState?: DesktopAuthState };
      if (kind === 'codex' && result?.authState) applyAuthState(result.authState);
      const snapshot = await loadDashboardState(false);
      if (snapshot && !isManagedProduct(kind)) queueQuotaAutoSync(snapshot.accounts);
      if (productRef.current !== kind) return;
      if (isManagedProduct(kind)) {
        reportOAuthFinished(await actions.oauthStatus(kind), kind);
        return;
      }
      if (snapshot?.oauthStatus) {
        reportOAuthFinished(snapshot.oauthStatus, 'codex');
        return;
      }
      reportOAuthFinished({
        status: 'completed',
        pending: false,
        result: {
          accountId: result.account?.id,
          email: result.account?.email,
          mismatch: result.mismatch,
          targetAccountId: result.targetAccountId || id,
          authState: result.authState || null,
        },
        targetAccountId: id,
      }, 'codex');
    } catch (error) {
      const snapshot = await loadDashboardState(false);
      if (snapshot && !isManagedProduct(kind)) queueQuotaAutoSync(snapshot.accounts);
      if (productRef.current !== kind) throw error;
      const finished = isManagedProduct(kind)
        ? await actions.oauthStatus(kind).catch(() => null)
        : snapshot?.oauthStatus;
      if (oauthStatusEndedThisFlow(finished)) {
        reportOAuthFinished(finished as DesktopOAuthStatus, kind);
      } else {
        const message = toUserMessage(error instanceof Error ? error.message : String(error));
        addToast(message, 'error', kind);
        addLogEntry(message, 'error', kind);
      }
      throw error;
    }
  };

  const handleCancelOAuth = async () => {
    const kind = productById(productRef.current).id;
    await actions.cancelOAuth(kind);
    const status = await actions.oauthStatus(kind);
    if (kind === 'antigravity') setAntigravityOAuthStatus(status);
    else if (kind === 'cursor') setCursorOAuthStatus(status);
    else setOAuthStatus(status);
    reportOAuthFinished(status, kind);
  };

  const handleCompleteOAuthManually = async (callbackUrl: string) => {
    try {
      const completed = await desktopApi.completeOAuthManually(callbackUrl);
      if (completed?.authState) applyAuthState(completed.authState);
    } finally {
      const status = await desktopApi.getOAuthStatus();
      setOAuthStatus(status);
      await loadDashboardState(false);
      reportOAuthFinished(status, 'codex');
    }
  };

  const handleResolveAuthConflict = async (action: 'adopt' | 'reapply') => {
    setIsResolvingAuth(true);
    try {
      if (action === 'adopt') {
        const account = await desktopApi.adoptOfficialAccount() as { email?: string; authState?: DesktopAuthState };
        if (account?.authState) applyAuthState(account.authState);
        addToast(`已采用官方 Codex 账号：${account.email}`, 'success', 'codex');
      } else {
        const result = await desktopApi.reapplyManagedAccount(authState.currentAccountId || null) as { authState?: DesktopAuthState };
        if (result?.authState) applyAuthState(result.authState);
        addToast('管理账号已重新应用到官方 Codex。', 'success', 'codex');
      }
      const snapshot = await loadDashboardState(false);
      if (snapshot) queueQuotaAutoSync(snapshot.accounts);
    } catch (error) {
      const message = toUserMessage(error instanceof Error ? error.message : String(error));
      addToast(message, 'error', 'codex');
      addLogEntry(message, 'error', 'codex');
    } finally {
      setIsResolvingAuth(false);
    }
  };

  // Delete account (desktop mode opens the in-app confirmation dialog).
  const handleDeleteAccount = async (id: string) => {
    const target = accounts.find(a => a.id === id);
    if (!target) return;
    if (desktopBridgeAvailable) {
      setDeleteTarget(target);
      return;
    }
    setVisibleAccounts(prev => prev.filter(acc => acc.id !== id));
    addToast(`已成功移除账号 ${target.email}`, 'warning');
  };

  const confirmDeleteAccount = async () => {
    if (!deleteTarget || isDeletingAccount) return;
    setIsDeletingAccount(true);
    const kind = productRef.current;
    try {
      await runAccountOperation(deleteTarget.id, () => actions.deleteAccount(kind, deleteTarget.id));
      const snapshot = await loadDashboardState(false);
      if (snapshot && !isManagedProduct(kind)) queueQuotaAutoSync(snapshot.accounts);
      if (productRef.current !== kind) {
        setDeleteTarget(null);
        return;
      }
      addToast(`已删除 ${deleteTarget.email}`, 'warning', kind);
      addLogEntry(`已从管理器中删除账号 ${deleteTarget.email}。`, 'warning', kind);
      setDeleteTarget(null);
    } catch (error) {
      if (productRef.current === kind) {
        const message = toUserMessage(error instanceof Error ? error.message : String(error));
        addToast(message, 'error', kind);
        addLogEntry(message, 'error', kind);
      }
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const performAccountSwitch = async (id: string) => {
    if (desktopBridgeAvailable) {
      const kind = productRef.current;
      if (anyOAuthPending()) {
        addToast('已有授权正在进行，请先完成或取消。', 'warning', kind);
        return;
      }
      const selected = accountsRef.current.find(a => a.id === id);
      const isCurrent = !!selected?.isCurrent;
      addToast(
        isCurrent
          ? `正在重新写入官方 ${officialClientLabel(kind)}，请稍候。`
          : `正在切换 ${productLabel(kind)} 账号，请稍候。`,
        'info',
        kind,
      );
      try {
        const result = await runAccountOperation(id, () => actions.switchAccount(kind, id, isCurrent)) as { launched?: boolean; launchError?: string | null; authState?: DesktopAuthState } | undefined;
        if (result?.authState) applyAuthState(result.authState);
        setSessionSwitchCount(count => count + 1);
        applyCurrentAccountBadge(kind, id);
        const snapshot = await loadDashboardState(false, { skipOfficialSync: true });
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        if (productRef.current !== kind) return;
        if (isManagedProduct(kind) && result?.launchError) {
          addToast(result.launchError, 'warning', kind);
          addLogEntry(`${selected?.email || id}：${result.launchError}`, 'warning', kind);
        } else if (isCurrent) {
          const clientName = officialClientLabel(kind);
          addToast(`已将 ${clientName} 重新登录为 ${selected?.email || id}`, 'success', kind);
          addLogEntry(`已将 ${clientName} 重新登录为 ${selected?.email || id}`, 'success', kind);
        } else {
          addToast(`当前账号已切换至 ${selected?.email || id}`, 'success', kind);
          addLogEntry(`已切换当前账号：${selected?.email || id}`, 'success', kind);
        }
      } catch (error) {
        if (productRef.current !== kind) return;
        const message = toUserMessage(error instanceof Error ? error.message : String(error));
        addToast(message, 'error', kind);
        addLogEntry(message, 'error', kind);
        try { await loadDashboardState(false); } catch {}
      }
      return;
    }
    setVisibleAccounts(prev => prev.map(acc => ({
      ...acc,
      isCurrent: acc.id === id,
    })));
    setSessionSwitchCount(count => count + 1);
    const selected = accounts.find(a => a.id === id);
    if (selected) {
      addToast(selected.isCurrent
        ? `已将 ${officialClientLabel(productRef.current)} 重新登录为 ${selected.email}`
        : `当前主账号已切换至 ${selected.email}`, 'success');
    }
  };

  const handleSwitchCurrentAccount = async (id: string) => {
    if (desktopBridgeAvailable && isManagedProduct(productRef.current)) {
      const pending = accountsRef.current.find(a => a.id === id);
      if (!pending) return;
      setSwitchTarget(pending);
      return;
    }
    await performAccountSwitch(id);
  };

  const confirmSwitchAccount = async () => {
    if (!switchTarget || isConfirmingSwitch) return;
    const id = switchTarget.id;
    setIsConfirmingSwitch(true);
    try {
      await performAccountSwitch(id);
    } finally {
      setIsConfirmingSwitch(false);
      setSwitchTarget(null);
    }
  };

  // Toggle Auto-switch scope selection
  const handleToggleAccountSelection = (id: string) => {
    const selected = accounts.find(a => a.id === id);
    if (selected && !canJoinAutoSwitch(selected)) {
      addToast(
        selected.status === 'BANNED'
          ? '账号已封号，无法加入自动切号'
          : selected.tokenAccessAvailable === false
            ? '该账号没有可用登录令牌，无法加入自动切号'
            : '该账号需要重新授权后才能加入自动切号',
        'info',
        'codex',
      );
      return;
    }
    if (desktopBridgeAvailable) {
      if (autoSwitchConfigRef.current.account_scope_mode !== 'selected') {
        addToast('当前是全部账号。要缩小范围，请先切到「指定账号」。', 'info');
        return;
      }
      const currentSelected = selectedAccountIdsRef.current;
      const nextSelected = currentSelected.includes(id)
        ? currentSelected.filter(item => item !== id)
        : pruneAutoSwitchAccountIds([...currentSelected, id], codexAccountsRef.current);
      const nextConfig: DesktopAutoSwitchConfig = {
        ...autoSwitchConfigRef.current,
        account_scope_mode: 'selected',
        selected_account_ids: nextSelected,
      };
      selectedAccountIdsRef.current = nextSelected;
      setSelectedAccountIds(nextSelected);
      void saveAutoSwitchConfig(nextConfig)
        .then((saved) => {
          if (saved) {
            addLogEntry(`${selected?.email || id} 已${nextSelected.includes(id) ? '加入' : '移出'}自动切号范围。`, 'info');
          }
        });
      return;
    }
    setSelectedAccountIds(prev => {
      const isSelected = prev.includes(id);
      if (isSelected) {
        addLogEntry(`已将 ${selected?.email || selected?.name} 移出自动切号轮换范围。`, 'warning');
        return prev.filter(item => item !== id);
      } else {
        addLogEntry(`已将 ${selected?.email || selected?.name} 加入自动切号轮换范围。`, 'info');
        return [...prev, id];
      }
    });
  };

  const saveAutoSwitchConfig = async (nextConfig: DesktopAutoSwitchConfig) => {
    const revision = ++configSaveRevision.current;
    const prunedConfig: DesktopAutoSwitchConfig = {
      ...nextConfig,
      selected_account_ids: pruneAutoSwitchAccountIds(nextConfig.selected_account_ids || [], codexAccountsRef.current),
    };
    autoSwitchConfigRef.current = prunedConfig;
    setAutoSwitchConfig(prunedConfig);
    setSettings((prev) => settingsFromDesktopState(
      prunedConfig,
      appInfo,
      codexStatus,
      updateStatus || null,
      cursorStatus || {
        installed: prev.cursorDetected,
        vscdbPresent: prev.cursorHasLocalLogin,
      },
      antigravityStatus || {
        installed: prev.antigravityDetected,
        vscdbPresent: prev.antigravityHasLocalLogin,
      },
    ));
    const saveOperation = configSaveQueue.current
      .catch(() => {})
      .then(() => desktopApi.saveAutoSwitchConfig(prunedConfig));
    configSaveQueue.current = saveOperation.catch(() => {});
    configSavesPending.current += 1;
    try {
      await saveOperation;
      configSavesPending.current -= 1;
      if (revision === configSaveRevision.current) {
        await loadDashboardState(false);
      }
      return true;
    } catch (error) {
      configSavesPending.current -= 1;
      const message = toUserMessage(error instanceof Error ? error.message : String(error));
      addToast(message, 'error', 'codex');
      addLogEntry(message, 'error', 'codex');
      if (revision === configSaveRevision.current) {
        await loadDashboardState(false);
      }
      return false;
    }
  };

  const handleToggleGlobalSwitch = async () => {
    if (!desktopBridgeAvailable) {
      setSettings(prev => {
        const updated = !prev.globalSwitch;
        addToast(`全局切号已${updated ? '启用' : '禁用'}`, updated ? 'success' : 'warning', 'codex');
        addLogEntry(`全局自动切号已${updated ? '启用' : '禁用'}。`, 'info', 'codex');
        return { ...prev, globalSwitch: updated };
      });
      return;
    }

    const nextConfig = {
      ...autoSwitchConfigRef.current,
      enabled: !autoSwitchConfigRef.current.enabled,
    };
    const enabled = nextConfig.enabled;
    const saved = await saveAutoSwitchConfig(nextConfig);
    if (saved) {
      addToast(`全局切号已${enabled ? '启用' : '禁用'}`, enabled ? 'success' : 'warning', 'codex');
      addLogEntry(`全局自动切号已${enabled ? '启用' : '禁用'}。`, 'info', 'codex');
    }
  };

  const handlePreviewThreshold = (type: '5h' | 'weekly', val: number) => {
    setSettings(prev => ({
      ...prev,
      [type === '5h' ? 'fiveHourThreshold' : 'weeklyThreshold']: val,
    }));
  };

  const handleUpdateThreshold = (type: '5h' | 'weekly', val: number) => {
    handlePreviewThreshold(type, val);
    if (!desktopBridgeAvailable) return;

    const configKey = type === '5h' ? 'primary_threshold' : 'secondary_threshold';
    if (Number(autoSwitchConfigRef.current[configKey]) === val) return;
    const nextConfig = {
      ...autoSwitchConfigRef.current,
      [configKey]: val,
    };
    void saveAutoSwitchConfig(nextConfig);
  };

  const handleBatchVerifyTokens = async () => {
    if (!desktopBridgeAvailable) return;
    let cursorError: string | null = null;
    let antigravityError: string | null = null;
    const [codex, cursor, antigravity] = await Promise.all([
      desktopApi.refreshAllTokens(false),
      desktopApi.refreshAllCursorTokens(false).catch((error) => {
        cursorError = toCursorUserMessage(error instanceof Error ? error.message : String(error));
        return { results: [] };
      }),
      desktopApi.refreshAllAntigravityTokens(false).catch((error) => {
        antigravityError = toAntigravityUserMessage(error instanceof Error ? error.message : String(error));
        return { results: [] };
      }),
    ]);
    await loadDashboardState(false);
    if (cursorError) {
      addToast(cursorError, 'error', 'cursor');
      addLogEntry(cursorError, 'error', 'cursor');
    }
    if (antigravityError) {
      addToast(antigravityError, 'error', 'antigravity');
      addLogEntry(antigravityError, 'error', 'antigravity');
    }
    const summaries = [
      { kind: 'codex' as const, label: 'Codex', results: codex?.results || [] },
      { kind: 'cursor' as const, label: 'Cursor', results: cursor?.results || [] },
      { kind: 'antigravity' as const, label: 'Antigravity', results: antigravity?.results || [] },
    ].filter((item) => item.results.length > 0);
    if (summaries.length === 0) {
      if (!cursorError) addToast('没有可检查的账号', 'info');
      return;
    }
    for (const item of summaries) {
      const { message, tone } = formatTokenCheckMessage(item.results, { product: item.kind });
      const text = summaries.length > 1 ? `${item.label} ${message}` : message;
      addToast(text, tone, item.kind);
      addLogEntry(text, tone === 'info' ? 'info' : tone, item.kind);
    }
  };

  const handleDetectClient = async () => {
    if (!desktopBridgeAvailable) return;
    const [status, cursor, antigravity] = await Promise.all([
      desktopApi.getCodexStatus(),
      desktopApi.getCursorStatus().catch(() => null),
      desktopApi.getAntigravityStatus().catch(() => null),
    ]);
    setCodexStatus(status);
    setCursorStatus(cursor);
    setAntigravityStatus(antigravity);
    setSettings(prev => ({
      ...prev,
      clientDetected: !!status?.installed,
      cursorDetected: !!cursor?.installed,
      cursorHasLocalLogin: !!cursor?.vscdbPresent,
      antigravityDetected: !!antigravity?.installed,
      antigravityHasLocalLogin: !!antigravity?.vscdbPresent,
    }));
    const cursorLabel = cursor?.installed ? '已安装' : cursor?.vscdbPresent ? '有本机登录' : '未安装';
    const antigravityLabel = antigravity?.installed ? '已安装' : antigravity?.vscdbPresent ? '有本机登录' : '未安装';
    addToast(
      `Codex ${status?.installed ? '已安装' : '未安装'}，Cursor ${cursorLabel}，Antigravity ${antigravityLabel}`,
      status?.installed || cursor?.installed || cursor?.vscdbPresent || antigravity?.installed || antigravity?.vscdbPresent ? 'success' : 'warning',
    );
  };

  const handleImportLocalAccount = async () => {
    if (!desktopBridgeAvailable) return;
    const kind = productRef.current;
    if (anyOAuthPending()) {
      addToast('已有授权正在进行，请先完成或取消。', 'warning', kind);
      throw new Error('已有授权正在进行，请先完成或取消。');
    }
    if (isManagedProduct(kind)) {
      const result = await actions.importLocal(kind) as { found?: boolean; account?: { id?: string; email?: string } | null; updated?: boolean; stalePossible?: boolean };
      const label = officialClientLabel(kind);
      if (!result?.found) {
        await loadDashboardState(false);
        if (productRef.current !== kind) throw new Error(`本机没有已登录的 ${label}`);
        addToast(`本机没有已登录的 ${label}`, 'warning', kind);
        throw new Error(`本机没有已登录的 ${label}`);
      }
      if (result.account?.id && productRef.current === kind) {
        try { await actions.refreshQuota(kind, result.account.id); } catch {}
      }
      await loadDashboardState(false);
      if (productRef.current !== kind) return;
      const imported = importAccountCopy({
        product: kind,
        email: result.account?.email,
        updated: !!result.updated,
        stalePossible: !!result.stalePossible,
      });
      addToast(imported.message, imported.tone, kind);
      addLogEntry(imported.message, imported.tone, kind);
      return;
    }
    const account = await desktopApi.adoptOfficialAccount();
    if (account?.id && productRef.current === kind) {
      try { await desktopApi.refreshQuota(account.id); } catch {}
    }
    await loadDashboardState(false);
    if (productRef.current !== kind) return;
    const imported = importAccountCopy({
      product: 'codex',
      email: account?.email,
      updated: !!account?.updated,
    });
    addToast(imported.message, imported.tone, 'codex');
    addLogEntry(imported.message, 'success', 'codex');
  };

  const handleCheckUpdates = async () => {
    if (!desktopBridgeAvailable) return;
    if (!appInfo?.updateEnabled) {
      await handleOpenExternal(`${appInfo?.repository || APP_GITHUB_URL}/releases`);
      addToast('已打开 GitHub 发布页', 'info');
      return;
    }
    await desktopApi.checkForUpdates();
    const snapshot = await loadDashboardState(false);
    if (snapshot?.updateStatus) {
      addToast(latestStatusForUi(snapshot.updateStatus), 'info');
    }
  };

  const handleInstallUpdate = async () => {
    if (!desktopBridgeAvailable) return;
    try {
      await desktopApi.installUpdate();
      addToast('正在安装更新并重启...', 'info');
      addLogEntry('已请求安装更新。', 'info');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addToast(message, 'error');
      addLogEntry(message, 'error');
    }
  };

  const handleOpenExternal = async (url: string) => {
    if (desktopBridgeAvailable) {
      try {
        await desktopApi.openExternal(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast(message, 'error');
      }
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handleRunAutoSwitchTick = async () => {
    if (!desktopBridgeAvailable) return;
    const result = await desktopApi.runAutoSwitchTick();
    if (result?.authState) applyAuthState(result.authState);
    const snapshot = await loadDashboardState(false);
    if (snapshot) queueQuotaAutoSync(snapshot.accounts);
    if (result?.switched) {
      setSessionSwitchCount(count => count + 1);
      if (result.to?.id) applyCurrentAccountBadge('codex', result.to.id);
      addToast(`已切换至 ${result.to?.email || '新账号'}`, 'success', 'codex');
    } else if (result?.reason === 'disabled') {
      addToast('额度已低于阈值，但全局开关已关闭，未切换账号。', 'warning', 'codex');
    }
    return result;
  };

  const handleScopeModeChange = async (mode: 'all' | 'selected') => {
    if (!desktopBridgeAvailable) return;
    const nextConfig: DesktopAutoSwitchConfig = {
      ...autoSwitchConfigRef.current,
      account_scope_mode: mode,
    };
    if (mode === 'selected') {
      const existing = autoSwitchConfigRef.current.selected_account_ids || [];
      const seeded = pruneAutoSwitchAccountIds(
        existing.length > 0 ? existing : selectedAccountIdsRef.current.filter((id) => String(id || '').trim() !== ''),
        codexAccountsRef.current,
      );
      nextConfig.selected_account_ids = seeded;
      selectedAccountIdsRef.current = seeded;
      setSelectedAccountIds(seeded);
    }
    await saveAutoSwitchConfig(nextConfig);
  };

  const authBannerKey = `${authState.status}:${authState.currentAccountId || ''}:${authState.officialIdentity?.email || ''}`;
  const showAuthBanner = desktopBridgeAvailable && productById(product).features.autoSwitch && authState.requiresResolution && authBannerDismissedKey !== authBannerKey;

  const handleProductChange = (next: ProductKind) => {
    persistProduct(next);
    if (!productById(next).features.autoSwitch && activeTab === 'autoswitch') setActiveTab('accounts');
    setAccountsFilterTab('all');
    setSwitchTarget(null);
    setIsConfirmingSwitch(false);
    setDeleteTarget(null);
    setIsRefreshingAll(refreshAllKindRef.current === next);
  };

  return (
    <div 
      className="h-screen w-screen flex overflow-hidden relative isolate select-none text-label font-sans"
      id="dashboard-main-container"
    >
      {/* Apple-flat backdrop: a near-black base with a faint top light. */}
      <div aria-hidden className="absolute inset-0 -z-10 pointer-events-none bg-base" id="dashboard-backdrop">
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(110% 60% at 50% -8%, rgba(255,255,255,0.05), transparent 62%)' }}
        />
      </div>
      {/* Absolute overlay elements */}
      {/* Toast notification Tray */}
      <div className="fixed top-[60px] right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none" id="toast-tray">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 50, scale: 0.9 }}
              className="pointer-events-auto bg-surface-2 border border-sep rounded-xl p-4 flex items-center gap-3 shadow-xl"
              key={t.id}
            >
              {t.type === 'success' && <CheckCircle className="w-5 h-5 text-ok shrink-0" />}
              {t.type === 'error' && <AlertCircle className="w-5 h-5 text-danger shrink-0" />}
              {t.type === 'warning' && <ShieldAlert className="w-5 h-5 text-warn shrink-0" />}
              {t.type === 'info' && <Info className="w-5 h-5 text-accent shrink-0" />}
              <span className="text-xs font-semibold text-label flex-1">{t.msg}</span>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                className="p-1 rounded-md text-label-3 hover:text-label hover:bg-fill cursor-pointer"
                aria-label="关闭提示"
                id={`toast-dismiss-${t.id}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Main Sidebar Component */}
      <Sidebar 
        activeTab={activeTab} 
        setActiveTab={setActiveTab}
        product={product}
        onProductChange={handleProductChange}
        onShowSupport={() => setShowSupport(true)}
        onShowUpdates={() => setShowUpdates(true)}
      />

      {/* Right Column Layout Wrapper */}
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden" id="dashboard-right-wrapper">
        {/* Navigation Utilities Header */}
        <Header 
          currentUserEmail={accounts.find((account) => account.isCurrent)?.email || ''}
          unreadNotificationsCount={showNotifications ? 0 : countUnreadAlertLogs(logs, lastReadLogId)}
          onToggleNotifications={() => setShowNotifications(!showNotifications)}
          onCopyCurrentEmail={() => {
            const email = accounts.find((account) => account.isCurrent)?.email;
            if (!email) return;
            void navigator.clipboard.writeText(email).then(
              () => addToast('已复制当前邮箱', 'success'),
              () => addToast('复制失败，请手动选择邮箱。', 'error'),
            );
          }}
        />

        {showAuthBanner && (
          <div className="shrink-0 px-8 pt-6" id="auth-status-banner-wrap">
            <AuthStatusBanner
              authState={authState}
              isResolving={isResolvingAuth}
              currentEmail={accounts.find((account) => account.isCurrent)?.email || null}
              needsReauthCount={accounts.filter((account) => account.status === 'SUSPENDED').length}
              onReload={() => void loadDashboardState(false)}
              onAdopt={() => void handleResolveAuthConflict('adopt')}
              onReapply={() => void handleResolveAuthConflict('reapply')}
              onDismiss={() => setAuthBannerDismissedKey(authBannerKey)}
            />
          </div>
        )}

        {/* Dashboard Content Scroller with Transition animations */}
        <main className="flex-1 overflow-hidden flex flex-col relative" id="main-content">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, scale: 0.988, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="flex-1 flex flex-col overflow-hidden"
            id="active-view-animator"
          >
              {dashboardLoadState === 'loading' && (
                <div
                  className="flex flex-1 items-center justify-center p-8"
                  id="dashboard-loading-state"
                  role="status"
                  aria-live="polite"
                >
                  <div className="glass-card flex w-full max-w-sm flex-col items-center rounded-2xl px-8 py-10 text-center">
                    <LoaderCircle className="mb-4 h-8 w-8 animate-spin text-accent" />
                    <h2 className="text-base font-bold text-white">正在加载账号数据</h2>
                    <p className="mt-2 text-xs leading-5 text-label-2">
                      正在读取本地账号、额度状态与 Daemon 设置。
                    </p>
                  </div>
                </div>
              )}

              {dashboardLoadState === 'error' && (
                <div
                  className="flex flex-1 items-center justify-center p-8"
                  id="dashboard-load-error-state"
                  role="alert"
                >
                  <div className="glass-card flex w-full max-w-md flex-col items-center rounded-2xl px-8 py-10 text-center">
                    <AlertCircle className="mb-4 h-9 w-9 text-danger" />
                    <h2 className="text-base font-bold text-white">账号数据加载失败</h2>
                    <p className="mt-2 max-w-sm text-xs leading-5 text-label-2">
                      {dashboardLoadError || '本地账号存储未响应。'}
                    </p>
                    <motion.button
                      type="button"
                      onClick={() => void loadDashboardState(true)}
                      whileHover={{ y: -1 }}
                      whileTap={{ scale: 0.96 }}
                      className="mt-6 flex items-center gap-2 rounded-xl border border-blue-500/30 bg-accent/15 px-5 py-2.5 text-xs font-bold text-blue-200 hover:bg-accent/20"
                      id="dashboard-retry-load"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      重试
                    </motion.button>
                  </div>
                </div>
              )}

              {dashboardLoadState === 'ready' && (
                <>
              {activeTab === 'quotas' && (
                <QuotasView
                  key={`quotas-${product}`}
                  product={product}
                  accounts={accounts}
                  onRefreshAccount={handleRefreshAccount}
                  onRefreshToken={desktopBridgeAvailable ? handleRefreshToken : undefined}
                  onRefreshAll={handleRefreshAll}
                  isRefreshingAll={isRefreshingAll}
                  onOpenAccounts={(filter) => {
                    setAccountsFilterTab(filter);
                    setActiveTab('accounts');
                  }}
                  onReauthorizeAccount={desktopBridgeAvailable ? handleReauthorizeAccount : undefined}
                />
              )}

              {activeTab === 'autoswitch' && productById(product).features.autoSwitch && (
                <AutoSwitchView 
                  accounts={accounts}
                  logs={logs}
                  settings={settings}
                  daemonState={daemonState}
                  sessionSwitchCount={sessionSwitchCount}
                  onToggleGlobalSwitch={handleToggleGlobalSwitch}
                  onPreviewThreshold={handlePreviewThreshold}
                  onUpdateThreshold={handleUpdateThreshold}
                  onAddLog={addLogEntry}
                  onToggleAccountSelection={handleToggleAccountSelection}
                  selectedAccountIds={selectedAccountIds}
                  scopeMode={autoSwitchConfig.account_scope_mode}
                  onScopeModeChange={desktopBridgeAvailable ? handleScopeModeChange : undefined}
                  onRunCheckNow={desktopBridgeAvailable ? handleRunAutoSwitchTick : undefined}
                />
              )}

              {activeTab === 'accounts' && (
                <AccountsView
                  key={`accounts-${product}`}
                  product={product}
                  accounts={accounts}
                  filterTab={accountsFilterTab}
                  onFilterTabChange={setAccountsFilterTab}
                  onAddAccount={handleAddAccount}
                  onDeleteAccount={handleDeleteAccount}
                  onSwitchCurrentAccount={handleSwitchCurrentAccount}
                  onRefreshAccount={handleRefreshAccount}
                  onReauthorizeAccount={desktopBridgeAvailable ? handleReauthorizeAccount : undefined}
                  onCancelOAuth={desktopBridgeAvailable ? handleCancelOAuth : undefined}
                  onCompleteOAuthManually={productById(product).features.oauthPasteCallback && desktopBridgeAvailable ? handleCompleteOAuthManually : undefined}
                  onImportLocal={desktopBridgeAvailable && productById(product).features.localImport ? handleImportLocalAccount : undefined}
                  onAddLog={addLogEntry}
                  oauthMode={desktopBridgeAvailable}
                  oauthStatus={product === 'antigravity' ? antigravityOAuthStatus : product === 'cursor' ? cursorOAuthStatus : oauthStatus}
                  actionsLocked={!!(product === 'antigravity' ? antigravityOAuthStatus?.pending : product === 'cursor' ? cursorOAuthStatus?.pending : oauthStatus?.pending)}
                  authState={desktopBridgeAvailable && productById(product).features.autoSwitch ? authState : null}
                  onOpenModal={() => setShowNotifications(false)}
                />
              )}

              {activeTab === 'settings' && (
                <SettingsView 
                  product={product}
                  settings={settings}
                  daemonState={daemonState}
                  onToggleDaemon={handleToggleDaemon}
                  onPreviewSyncInterval={handlePreviewSyncInterval}
                  onUpdateSyncInterval={handleUpdateSyncInterval}
                  onAddLog={addLogEntry}
                  onBatchVerifyTokens={desktopBridgeAvailable ? handleBatchVerifyTokens : undefined}
                  onDetectClient={desktopBridgeAvailable ? handleDetectClient : undefined}
                  onCheckUpdates={desktopBridgeAvailable ? handleCheckUpdates : undefined}
                  onInstallUpdate={desktopBridgeAvailable ? handleInstallUpdate : undefined}
                  canInstallUpdate={updateStatus?.status === 'downloaded'}
                  updateEnabled={!!appInfo?.updateEnabled}
                  tokenAccountsByProduct={{ codex: codexAccounts, cursor: cursorAccounts, antigravity: antigravityAccounts }}
                  repositoryUrl={appInfo?.repository || APP_GITHUB_URL}
                  onOpenLogs={desktopBridgeAvailable ? async () => { await desktopApi.openLogs(); } : undefined}
                  onShowFloatWindow={async () => {
                    if (!desktopBridgeAvailable) return;
                    const state = await desktopApi.showFloatWindow(product);
                    if (state?.visible) {
                      addToast('桌面额度已打开。看不见时点任务栏或右上角。', 'info');
                      return;
                    }
                    addToast('额度窗已创建，但当前看不见。请看任务栏，或把挡住的窗口挪开。', 'warning');
                  }}
                />
              )}
                </>
              )}
          </motion.div>
        </main>

        {/* Global Footer bar matching image */}
        <footer 
          className="h-9 border-t border-sep flex items-center justify-end px-8 text-[11px] text-label-2 font-medium select-none shrink-0"
          id="dashboard-footer"
        >
          <button 
            onClick={() => {
              void handleOpenExternal(`${appInfo?.repository || APP_GITHUB_URL}/blob/main/docs/privacy.md`);
            }}
            className="hover:text-label cursor-pointer"
            id="footer-privacy"
          >
            隐私政策
          </button>
        </footer>
      </div>

      <AnimatePresence>
      {deleteTarget && (
        <motion.div
          className="app-dialog-overlay bg-black/50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="glass-card glass-sheet w-full max-w-sm rounded-2xl border border-sep p-7 text-left shadow-2xl"
            id="delete-confirm-modal"
            role="alertdialog"
            aria-modal="true"
          >
            <Trash2 className="mb-4 h-9 w-9 text-danger" />
            <h3 className="text-lg font-bold text-white">删除账号</h3>
            <p className="mt-2 text-xs leading-relaxed text-label-2">
              确定要删除 <strong className="text-white">{deleteTarget.email}</strong> 吗？该操作无法撤销。
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                onClick={() => { if (!isDeletingAccount) setDeleteTarget(null); }}
                disabled={isDeletingAccount}
                className="rounded-xl bg-fill hover:bg-fill-2 px-4 py-3 text-xs font-bold text-label disabled:opacity-50 cursor-pointer"
                id="delete-confirm-cancel"
              >
                取消
              </button>
              <button
                onClick={() => void confirmDeleteAccount()}
                disabled={isDeletingAccount}
                className="rounded-xl border border-rose-500/30 bg-danger/15 px-4 py-3 text-xs font-bold text-rose-200 hover:bg-rose-500/25 disabled:opacity-50 cursor-pointer"
                id="delete-confirm-accept"
              >
                {isDeletingAccount ? '删除中...' : '确认删除'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>

      <AnimatePresence>
      {switchTarget && (
        <motion.div
          className="app-dialog-overlay bg-black/50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="glass-card glass-sheet w-full max-w-sm rounded-2xl border border-sep p-7 text-left shadow-2xl"
            id="cursor-switch-confirm-modal"
            role="alertdialog"
            aria-modal="true"
          >
            <ArrowLeftRight className="mb-4 h-9 w-9 text-accent" />
            <h3 className="text-lg font-bold text-white">写入官方 {officialClientLabel(product)}</h3>
            <p className="mt-2 text-xs leading-relaxed text-label-2">
              会先关掉正在运行的官方 {officialClientLabel(product)}，再把 <strong className="text-white">{switchTarget.email}</strong> 写进去并重新打开。未保存的编辑可能会丢。
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                onClick={() => { if (!isConfirmingSwitch) setSwitchTarget(null); }}
                disabled={isConfirmingSwitch}
                className="rounded-xl bg-fill hover:bg-fill-2 px-4 py-3 text-xs font-bold text-label disabled:opacity-50 cursor-pointer"
                id="cursor-switch-confirm-cancel"
              >
                取消
              </button>
              <button
                onClick={() => void confirmSwitchAccount()}
                disabled={isConfirmingSwitch}
                className="rounded-xl border border-accent/30 bg-accent/15 px-4 py-3 text-xs font-bold text-accent hover:bg-accent/25 disabled:opacity-50 cursor-pointer"
                id="cursor-switch-confirm-accept"
              >
                {isConfirmingSwitch ? '切换中...' : '确认切换'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* Overlay Notification Center Sidebar panel */}
      <AnimatePresence>
      {showNotifications && (
          <>
            <motion.div 
              key="notifications-backdrop"
              className="fixed inset-0 bg-black/40 z-40" 
              onClick={() => setShowNotifications(false)} 
              initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
            />
            <motion.div
              key="notifications-panel"
              className="fixed right-0 top-0 bottom-0 w-80 bg-surface-2 border-l border-sep p-6 z-40 shadow-2xl flex flex-col text-label text-left"
              id="notification-sidebar-center"
              initial={{ x: 340 }}
              animate={{ x: 0 }}
              exit={{ x: 340 }}
              transition={{ type: 'spring', stiffness: 380, damping: 36 }}
            >
              <div className="flex items-center justify-between pb-4 border-b border-sep mb-6">
                <div className="flex items-center gap-2">
                  <Bell className="w-4 h-4 text-accent" />
                  <h3 className="font-bold text-sm tracking-wide font-sans">运行日志</h3>
                </div>
                <button
                  onClick={() => setShowNotifications(false)}
                  className="p-1.5 hover:bg-fill-2 rounded-lg text-label-2 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Logs stream */}
              <div className="flex-1 overflow-y-auto space-y-4 pr-1 scrollbar-thin">
                {logs.length === 0 && (
                  <p className="px-1 pt-8 text-center text-xs text-label-3" id="notification-empty-state">
                    暂无日志
                  </p>
                )}
                {logs.map((log) => {
                  let color = "text-accent";
                  if (log.type === 'success') color = "text-ok";
                  if (log.type === 'warning') color = "text-warn";
                  if (log.type === 'error') color = "text-danger";

                  return (
                    <div className="p-3 bg-white/[0.06] rounded-xl text-xs space-y-1" key={log.id}>
                      <div className="flex items-center justify-between">
                        <span className={`font-bold text-[10px] ${color}`}>{logTypeLabel(log.type)}</span>
                        <span className="text-[9px] text-label-3 tabular-nums">{log.timestamp}</span>
                      </div>
                      <p className="text-label-2 leading-relaxed text-[11px] font-sans font-medium">{log.message}</p>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </>
      )}
      </AnimatePresence>

      {/* Support Dialog modal */}
      <AnimatePresence>
      {showSupport && (
          <motion.div
            className="app-dialog-overlay bg-black/55 z-50"
            initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className="bg-surface-2 border border-sep rounded-2xl p-8 w-full max-w-md shadow-2xl relative text-label text-left select-none"
              id="support-modal-popup"
            >
              <button
                onClick={() => setShowSupport(false)}
                className="absolute top-5 right-5 p-2 hover:bg-fill-2 rounded-xl text-label-2 hover:text-white transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <HelpCircle className="w-12 h-12 text-accent mb-4" />
              <h3 className="text-lg font-bold tracking-tight mb-2 font-sans">帮助</h3>
              <p className="text-xs text-label-2 leading-relaxed mb-6 font-sans">
                遇到额度、登录或客户端问题时，请到 GitHub 提交 Issue。
              </p>

              <div className="mb-6" id="support-channels-list">
                <div className="p-3 bg-white/[0.06] rounded-xl flex items-center justify-between text-xs font-semibold">
                  <span className="text-label-2">GitHub Issues</span>
                  <button
                    type="button"
                    className="text-accent cursor-pointer"
                    onClick={() => void handleOpenExternal(`${appInfo?.repository || APP_GITHUB_URL}/issues`)}
                  >
                    去提交
                  </button>
                </div>
                <p className="mt-2 px-1 text-[11px] text-label-3 leading-5">
                  社区协助，尽力而为
                </p>
              </div>

              <button
                onClick={() => setShowSupport(false)}
                className="w-full py-3 bg-accent/12 hover:bg-accent/20 border border-accent/20 text-accent hover:text-accent-hi rounded-xl text-xs font-bold transition-all cursor-pointer"
              >
                知道了
              </button>
            </motion.div>
          </motion.div>
      )}
      </AnimatePresence>

      {/* Release Notes / Updates dialog modal */}
      <AnimatePresence>
      {showUpdates && (
          <motion.div
            className="app-dialog-overlay bg-black/55 z-50"
            initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className="bg-surface-2 border border-sep rounded-2xl p-8 w-full max-w-md shadow-2xl relative text-label text-left select-none"
              id="updates-modal-popup"
            >
              <button
                onClick={() => setShowUpdates(false)}
                className="absolute top-5 right-5 p-2 hover:bg-fill-2 rounded-xl text-label-2 hover:text-white transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <Activity className="w-12 h-12 text-accent mb-4" />
              <h3 className="text-lg font-bold tracking-tight mb-2 font-sans">版本更新详情</h3>
              <p className="text-xs text-label-2 mb-6 font-sans">
                当前版本 <strong>{settings.version.startsWith('v') ? settings.version : `v${settings.version}`}</strong>。
              </p>

              <div className="space-y-4 max-h-48 overflow-y-auto pr-2 mb-6 text-xs text-label-2 leading-relaxed font-sans" id="changelog-list">
                <div>
                  <h4 className="font-bold text-white mb-1">本轮打磨</h4>
                  <ul className="list-disc pl-4 space-y-1 text-label-2 text-[11px]">
                    <li>侧栏和应用名改为 Quota Switcher。</li>
                    <li>额度稍后重试不再当成 Daemon 失败，设置里也不再挂着警告。</li>
                    <li>账号管理和配额总览里 Cursor 额度叫 Auto + Composer Usage / API Usage，小窗仍用 Auto / API。</li>
                    <li>帮助不再要求提交可复现信息，入口改成去提交。</li>
                    <li>需重新授权的账号不再重复写一整句说明。</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-bold text-white mb-1">已验证修复</h4>
                  <ul className="list-disc pl-4 space-y-1 text-label-2 text-[11px]">
                    <li>刷新额度失败时不再提示成功；授权中途卡住可以取消或重试。</li>
                    <li>添加账号弹窗不再显示误导性的套餐和优先级下拉框。</li>
                    <li>网络失败会显示短中文说明，而不是 Electron 报错原文。</li>
                  </ul>
                </div>
              </div>

              <button
                onClick={() => setShowUpdates(false)}
                className="w-full py-3 bg-accent/12 hover:bg-accent/20 border border-accent/20 text-accent hover:text-accent-hi rounded-xl text-xs font-bold transition-all cursor-pointer"
              >
                知道了
              </button>
            </motion.div>
          </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  return <DashboardApp />;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  INITIAL_ACCOUNTS, 
  INITIAL_DAEMON_STATE, 
  INITIAL_LOGS, 
  INITIAL_SETTINGS 
} from './data/mockData';
import {
  AccountQuota,
  DesktopAppInfo,
  DesktopAutoSwitchConfig,
  DesktopAuthState,
  DesktopCodexStatus,
  DesktopOAuthStatus,
  DesktopUpdateStatus,
  LogEntry,
  SystemSettings,
  DaemonState,
} from './types';
import {
  countUnreadAlertLogs,
  desktopApi,
  formatDateTime,
  hasDesktopBridge,
  canJoinAutoSwitch,
  needsQuotaAutoSync,
  pruneAutoSwitchAccountIds,
  quotaAutoSyncStaleMs,
  selectedAccountIdsEqual,
  summarizeRefreshAllResults,
  summarizeTokenCheckResults,
  QUOTA_AUTO_SYNC_MIN_GAP_MS,
} from './api/desktop';
import { logTypeLabel, toUserMessage } from './api/user-messages';
import Login from './components/Login';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import QuotasView from './components/QuotasView';
import AutoSwitchView from './components/AutoSwitchView';
import AccountsView from './components/AccountsView';
import SettingsView from './components/SettingsView';
import AuthStatusBanner from './components/AuthStatusBanner';
import FloatLens from './components/FloatLens';
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
  LoaderCircle
} from 'lucide-react';

const desktopBridgeAvailable = hasDesktopBridge();

const DEFAULT_CONFIG: DesktopAutoSwitchConfig = {
  enabled: false,
  primary_threshold: 20,
  secondary_threshold: 30,
  account_scope_mode: 'all',
  selected_account_ids: [],
  sync_interval_minutes: 1,
};

const EMPTY_AUTH_STATE: DesktopAuthState = {
  status: 'empty',
  requiresResolution: false,
  currentAccountId: null,
  matchedAccountId: null,
  officialIdentity: null,
  message: null,
};

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
): SystemSettings {
  return {
    globalSwitch: !!config.enabled,
    fiveHourThreshold: Number(config.primary_threshold ?? 20),
    weeklyThreshold: Number(config.secondary_threshold ?? 30),
    clientDetected: !!codexStatus?.installed,
    updateChannel: updateChannelForUi(updateStatus),
    version: appInfo?.version || INITIAL_SETTINGS.version,
    latestStatus: latestStatusForUi(updateStatus),
  };
}

function isFloatRenderer() {
  return window.location.hash.replace(/^#\/?/, '') === 'float';
}

function wantsDesktopLoginPreview() {
  return new URLSearchParams(window.location.search).has('desktopLogin');
}

function DashboardApp() {
  // Authentication state - persistence in localStorage for robustness
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    if (desktopBridgeAvailable && !wantsDesktopLoginPreview()) return true;
    const saved = localStorage.getItem('codex_auth_status');
    return saved === 'true';
  });
  
  const [userEmail, setUserEmail] = useState<string>(() => {
    return localStorage.getItem('codex_auth_email') || '';
  });

  // Main UI States
  const [activeTab, setActiveTab] = useState<'accounts' | 'quotas' | 'autoswitch' | 'settings'>('quotas');
  const [accounts, setAccounts] = useState<AccountQuota[]>(desktopBridgeAvailable ? [] : INITIAL_ACCOUNTS);
  const [daemonState, setDaemonState] = useState<DaemonState>(
    desktopBridgeAvailable ? { status: 'Stopped', syncInterval: 1, lastChecked: '' } : INITIAL_DAEMON_STATE,
  );
  const [settings, setSettings] = useState<SystemSettings>(INITIAL_SETTINGS);
  const [logs, setLogs] = useState<LogEntry[]>(desktopBridgeAvailable ? [] : INITIAL_LOGS);
  const [autoSwitchConfig, setAutoSwitchConfig] = useState<DesktopAutoSwitchConfig>(DEFAULT_CONFIG);
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
  const [codexStatus, setCodexStatus] = useState<DesktopCodexStatus | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const [authState, setAuthState] = useState<DesktopAuthState>(EMPTY_AUTH_STATE);
  const [oauthStatus, setOAuthStatus] = useState<DesktopOAuthStatus | null>(null);
  const [isResolvingAuth, setIsResolvingAuth] = useState(false);
  const [dashboardLoadState, setDashboardLoadState] = useState<'loading' | 'ready' | 'error'>(
    desktopBridgeAvailable ? 'loading' : 'ready',
  );
  const [dashboardLoadError, setDashboardLoadError] = useState<string | null>(null);
  const hasLoadedDashboard = useRef(!desktopBridgeAvailable);
  const quotaAutoSyncPromise = useRef<Promise<void> | null>(null);
  const lastQuotaAutoSyncAt = useRef(0);
  const accountsRef = useRef<AccountQuota[]>(accounts);
  const accountOperationIds = useRef<Set<string>>(new Set());
  const autoSwitchConfigRef = useRef<DesktopAutoSwitchConfig>(autoSwitchConfig);
  const authStateRef = useRef<DesktopAuthState>(authState);
  const configSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const configSaveRevision = useRef(0);
  
  // Auto-switch scope checkmarks list (Premium_Member_01, Team_Admin_Shared, Internal_Dev_Account checked initially)
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>(
    desktopBridgeAvailable ? [] : ['5', '6', '8'],
  );
  const selectedAccountIdsRef = useRef<string[]>(selectedAccountIds);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    autoSwitchConfigRef.current = autoSwitchConfig;
  }, [autoSwitchConfig]);

  useEffect(() => {
    selectedAccountIdsRef.current = selectedAccountIds;
  }, [selectedAccountIds]);

  // UI Interactive triggers
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
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
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // Custom Toast notifications array
  const [toasts, setToasts] = useState<{ id: string; msg: string; type: 'success' | 'info' | 'warning' | 'error' }[]>([]);

  const addToast = useCallback((msg: string, type: 'success' | 'info' | 'warning' | 'error' = 'info') => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    setToasts(prev => [...prev, { id, msg: toUserMessage(msg), type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const addLogEntry = useCallback((message: string, type: LogEntry['type']) => {
    const timestamp = new Date().toLocaleString('sv-SE');
    const newLog: LogEntry = {
      id: `l_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp,
      message: toUserMessage(message),
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
  const oauthStatusRef = useRef<DesktopOAuthStatus | null>(oauthStatus);
  const oauthReportKeyRef = useRef<string | null>(null);

  useEffect(() => {
    oauthStatusRef.current = oauthStatus;
  }, [oauthStatus]);

  const applyDashboardState = useCallback((snapshot: Awaited<ReturnType<typeof desktopApi.loadDashboardState>>) => {
    setAccounts(snapshot.accounts);
    accountsRef.current = snapshot.accounts;
    const prunedSelected = snapshot.config.account_scope_mode === 'selected'
      ? pruneAutoSwitchAccountIds(snapshot.config.selected_account_ids || [], snapshot.accounts)
      : snapshot.accounts.filter(canJoinAutoSwitch).map((account) => account.id);
    let nextConfig = snapshot.config;
    if (
      snapshot.config.account_scope_mode === 'selected'
      && !selectedAccountIdsEqual(snapshot.config.selected_account_ids || [], prunedSelected)
    ) {
      nextConfig = {
        ...snapshot.config,
        selected_account_ids: prunedSelected,
      };
      void desktopApi.saveAutoSwitchConfig(nextConfig).catch(() => {});
    }
    setAutoSwitchConfig(nextConfig);
    autoSwitchConfigRef.current = nextConfig;
    setAppInfo(snapshot.appInfo);
    setCodexStatus(snapshot.codexStatus);
    setUpdateStatus(snapshot.updateStatus);
    setAuthState(snapshot.authState);
    authStateRef.current = snapshot.authState;
    const incomingOAuth = snapshot.oauthStatus;
    const localOAuth = oauthStatusRef.current;
    const nextOAuth = localOAuth?.pending && !incomingOAuth.pending && incomingOAuth.status === 'idle'
      ? localOAuth
      : incomingOAuth;
    setOAuthStatus(nextOAuth);
    oauthStatusRef.current = nextOAuth;
    if (nextOAuth.pending && !wasOAuthPendingRef.current) setActiveTab('accounts');
    wasOAuthPendingRef.current = !!nextOAuth.pending;
    setSettings(settingsFromDesktopState(nextConfig, snapshot.appInfo, snapshot.codexStatus, snapshot.updateStatus));
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
    if (snapshot.currentAccount?.email) {
      setUserEmail(snapshot.currentAccount.email);
      localStorage.setItem('codex_auth_email', snapshot.currentAccount.email);
    }
  }, []);

  const loadDashboardState = useCallback(async (showLoading = false) => {
    if (!desktopBridgeAvailable) return null;
    const seq = ++dashboardLoadSeqRef.current;
    if (showLoading && !hasLoadedDashboard.current) {
      setDashboardLoadState('loading');
      setDashboardLoadError(null);
    }
    try {
      const snapshot = await desktopApi.loadDashboardState();
      if (seq !== dashboardLoadSeqRef.current) return null;
      applyDashboardState(snapshot);
      hasLoadedDashboard.current = true;
      setDashboardLoadState('ready');
      setDashboardLoadError(null);
      return snapshot;
    } catch (error) {
      if (seq !== dashboardLoadSeqRef.current) return null;
      const message = toUserMessage(error instanceof Error ? error.message : String(error));
      addToast(message, 'error');
      addLogEntry(message, 'error');
      if (!hasLoadedDashboard.current) {
        setDashboardLoadState('error');
        setDashboardLoadError(message);
      }
      return null;
    }
  }, [addLogEntry, addToast, applyDashboardState]);

  const queueQuotaAutoSync = useCallback((candidateAccounts: AccountQuota[]) => {
    if (!desktopBridgeAvailable || quotaAutoSyncPromise.current) return;
    if (authStateRef.current.requiresResolution) return;
    if (Date.now() - lastQuotaAutoSyncAt.current < QUOTA_AUTO_SYNC_MIN_GAP_MS) return;
    const staleAccounts = candidateAccounts.filter((account) => (
      !accountOperationIds.current.has(account.id)
      && needsQuotaAutoSync(
        account,
        quotaAutoSyncStaleMs(account, autoSwitchConfigRef.current.sync_interval_minutes),
      )
    ));
    if (!staleAccounts.length) return;

    lastQuotaAutoSyncAt.current = Date.now();
    quotaAutoSyncPromise.current = (async () => {
      for (const account of staleAccounts) {
        try {
          await desktopApi.refreshQuota(account.id, false);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addLogEntry(`${account.email}: ${toUserMessage(message)}`, 'info');
        }
      }
      await loadDashboardState(false);
    })().finally(() => {
      quotaAutoSyncPromise.current = null;
    });
  }, [addLogEntry, loadDashboardState]);

  // Login handler
  const handleLogin = (email: string) => {
    setIsAuthenticated(true);
    setUserEmail(email);
    localStorage.setItem('codex_auth_status', 'true');
    localStorage.setItem('codex_auth_email', email);
    
    // Add toast and log
    addToast('登录成功，欢迎回来！', 'success');
    addLogEntry(`用户 ${email} 已进入控制中心。`, 'success');
    if (desktopBridgeAvailable) {
      hasLoadedDashboard.current = false;
      setDashboardLoadState('loading');
      setDashboardLoadError(null);
    }
  };

  // Logout handler
  const handleLogout = () => {
    setIsAuthenticated(false);
    localStorage.removeItem('codex_auth_status');
    localStorage.removeItem('codex_auth_email');
    if (desktopBridgeAvailable) {
      hasLoadedDashboard.current = false;
      setDashboardLoadState('loading');
      setDashboardLoadError(null);
    }
    addToast('已安全退出登录', 'info');
  };

  // Escape closes the topmost dismissible overlay.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (deleteTarget) {
        if (!isDeletingAccount) setDeleteTarget(null);
        return;
      }
      if (showNotifications) { setShowNotifications(false); return; }
      if (showSupport) { setShowSupport(false); return; }
      if (showUpdates) { setShowUpdates(false); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteTarget, isDeletingAccount, showNotifications, showSupport, showUpdates]);

  useEffect(() => {
    if (deleteTarget || showSupport || showUpdates) {
      setShowNotifications(false);
    }
  }, [deleteTarget, showSupport, showUpdates]);

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
    if (!isAuthenticated || !desktopBridgeAvailable) return;
    let disposed = false;

    loadDashboardState(true).then((snapshot) => {
      if (!disposed && snapshot) queueQuotaAutoSync(snapshot.accounts);
    });
    const authRetryTimer = window.setTimeout(() => {
      if (!disposed) loadDashboardState(false);
    }, 5000);

    const syncTimer = window.setInterval(() => {
      if (!disposed) queueQuotaAutoSync(accountsRef.current);
    }, QUOTA_AUTO_SYNC_MIN_GAP_MS);

    const unsubscribe = desktopApi.subscribe({
      onDaemonTick: () => {
        loadDashboardState(false).then((snapshot) => {
          if (!disposed && snapshot) queueQuotaAutoSync(snapshot.accounts);
        });
      },
      onDaemonError: (message) => {
        addToast(message, 'error');
        addLogEntry(message, 'error');
      },
      onAutoSwitch: (result) => {
        if (result?.switched) {
          setSessionSwitchCount(count => count + 1);
          addToast(`已自动切换至 ${result.to?.email || '新账号'}`, 'warning');
        }
        loadDashboardState(false);
      },
      onUpdateStatus: (status) => {
        setUpdateStatus(status);
        setSettings(prev => ({ ...prev, latestStatus: latestStatusForUi(status), updateChannel: updateChannelForUi(status) }));
      },
      onAuthConflict: (state) => {
        setAuthState(state);
        authStateRef.current = state;
        addToast(state.message || '官方 Codex 登录状态已变更。', 'warning');
      },
    });

    return () => {
      disposed = true;
      window.clearTimeout(authRetryTimer);
      window.clearInterval(syncTimer);
      unsubscribe();
    };
  }, [addLogEntry, addToast, isAuthenticated, loadDashboardState, queueQuotaAutoSync]);

  const reportOAuthFinished = useCallback((status: DesktopOAuthStatus) => {
    if (status.pending) return;
    if (status.status === 'idle' || status.status === 'pending') return;
    const result = status.result;
    const key = [
      status.status,
      result?.accountId || '',
      result?.email || '',
      result?.mismatch ? '1' : '0',
      status.targetAccountId || '',
      status.message || '',
    ].join('|');
    if (oauthReportKeyRef.current === key) return;
    oauthReportKeyRef.current = key;

    if (status.status === 'cancelled') {
      addToast('授权已取消。', 'warning');
      addLogEntry('授权已取消。', 'warning');
      return;
    }
    if (status.status === 'error' || status.status === 'expired') {
      const message = status.message || '授权未完成。';
      addToast(message, 'warning');
      addLogEntry(message, 'warning');
      return;
    }
    if (status.status !== 'completed') return;
    if (result?.mismatch) {
      const message = result.email
        ? `浏览器登录的不是这个账号，已另存为 ${result.email}。原来的账号仍需重新授权。`
        : '浏览器登录的不是这个账号，已另存为新账号。原来的账号仍需重新授权。';
      addToast(message, 'warning');
      addLogEntry(message, 'warning');
      return;
    }
    const isReauth = !!(status.targetAccountId || result?.targetAccountId);
    const message = result?.email
      ? (isReauth ? `已重新授权 ${result.email}` : `已添加 ${result.email}`)
      : (isReauth ? '账号已重新授权' : '账号已添加');
    addToast(message, 'success');
    addLogEntry(message, 'success');
  }, [addLogEntry, addToast]);

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
    oauthStatusRef.current = nextStatus;
    setOAuthStatus(nextStatus);
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !desktopBridgeAvailable || !oauthStatus?.pending) return;
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
        reportOAuthFinished(status);
      } catch {
        failCount += 1;
        if (!disposed && (failCount === 5 || failCount % 15 === 0)) {
          addToast('授权状态读取失败，可点取消后重试。', 'error');
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
  }, [addToast, isAuthenticated, loadDashboardState, oauthStatus?.pending, reportOAuthFinished]);

  // Global Refresh All trigger
  const handleRefreshAll = async () => {
    if (desktopBridgeAvailable) {
      setIsRefreshingAll(true);
      addToast('正在刷新全部账号额度...', 'info');
      addLogEntry('开始同步全部账号额度...', 'info');
      try {
        const results = await desktopApi.refreshAllQuotas();
        const { refreshed, reauthSkipped, bannedSkipped, failed } = summarizeRefreshAllResults(results);
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        if (failed || bannedSkipped) {
          const parts = [`已刷新 ${refreshed} 个`];
          if (reauthSkipped) parts.push(`${reauthSkipped} 个需重新授权`);
          if (bannedSkipped) parts.push(`${bannedSkipped} 个已封号`);
          if (failed) parts.push(`${failed} 个同步失败`);
          addToast(parts.join('，'), 'warning');
          const logParts = [];
          if (reauthSkipped) logParts.push(`需重新授权 ${reauthSkipped} 个`);
          if (bannedSkipped) logParts.push(`封号 ${bannedSkipped} 个`);
          if (failed) logParts.push(`失败 ${failed} 个`);
          addLogEntry(`额度刷新完成：${logParts.join('，')}。`, 'warning');
        } else if (reauthSkipped) {
          addToast(`已刷新 ${refreshed} 个；${reauthSkipped} 个需重新授权`, 'info');
          addLogEntry(`额度刷新完成；${reauthSkipped} 个账号需要重新授权。`, 'info');
        } else {
          addToast(`已刷新 ${refreshed} 个账号额度`, 'success');
          addLogEntry('全部账号额度同步完成。', 'success');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast(message, 'error');
        addLogEntry(message, 'error');
      } finally {
        setIsRefreshingAll(false);
      }
      return;
    }
    setIsRefreshingAll(true);
    addToast('正在刷新同步所有账号配额...', 'info');
    addLogEntry('开始同步全部账号额度...', 'info');

    setTimeout(() => {
      setAccounts(prev => prev.map(acc => {
        // Randomly adjust quota slightly to simulate active refreshing
        if (acc.status === 'EXPIRED') return acc;
        const change = Math.floor(Math.random() * 200) + 50;
        const newRemaining = Math.max(0, (acc.fiveHourQuotaRemaining ?? 0) - change);
        return {
          ...acc,
          fiveHourQuotaRemaining: newRemaining,
          status: newRemaining <= 0 ? 'EXPIRED' : acc.status,
          tokenValidity: '23h 59m left',
        };
      }));
      setIsRefreshingAll(false);
      addToast('所有账号配额已刷新完成！', 'success');
      addLogEntry('全部账号额度同步完成。', 'success');
    }, 1500);
  };

  // Refresh single account
  const handleRefreshAccount = async (id: string) => {
    if (desktopBridgeAvailable) {
      const account = accountsRef.current.find(item => item.id === id);
      let refreshError: unknown = null;
      try {
        await runAccountOperation(id, () => desktopApi.refreshQuota(id));
      } catch (error) {
        refreshError = error;
      }
      const snapshot = await loadDashboardState(false);
      if (snapshot) queueQuotaAutoSync(snapshot.accounts);
      const fresh = snapshot?.accounts.find(item => item.id === id);
      const label = account?.email || id;
      if (!refreshError) {
        if (fresh?.status === 'SUSPENDED') {
          const detail = `${label} 额度已刷新，仍需重新授权后才能继续使用`;
          addToast(detail, 'success');
          addLogEntry(detail, 'success');
          return;
        }
        addToast(`${label} 额度已刷新`, 'success');
        addLogEntry(`账号额度已刷新：${label}`, 'success');
        return;
      }
      if (fresh?.status === 'BANNED') {
        const detail = fresh.warning || '账号已封号，无法继续使用。';
        addToast(detail, 'error');
        addLogEntry(`${label}：${detail}`, 'error');
        return;
      }
      if (fresh?.status === 'LIMITED') {
        const detail = fresh.warning || '额度已达上限或触发限流。';
        addToast(detail, 'warning');
        addLogEntry(`${label}：${detail}`, 'warning');
        return;
      }
      if (fresh?.status === 'SUSPENDED') {
        const detail = fresh.warning || '该账号需要重新授权后才能刷新额度';
        addToast(detail, 'warning');
        addLogEntry(`${label}：${detail}`, 'warning');
        return;
      }
      if (fresh?.status === 'SYNC_FAILED') {
        const detail = fresh.warning || '额度同步失败，请稍后重试。';
        addToast(detail, 'warning');
        addLogEntry(`${label}：${detail}`, 'warning');
        return;
      }
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
      addToast(message, 'error');
      addLogEntry(message, 'error');
      throw refreshError;
    }
    setAccounts(prev => prev.map(acc => {
      if (acc.id === id) {
        addToast(`账号 ${acc.name} 的配额已重新同步`, 'success');
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
    const account = accountsRef.current.find(item => item.id === id);
    try {
      const result = await runAccountOperation(id, () => desktopApi.refreshToken(id));
      if (!result.ok) throw new Error(result.error || 'Token refresh failed');
      await loadDashboardState(false);
      addToast(result?.skipped ? `${account?.email || id} 的 Token 仍然有效` : `${account?.email || id} 的 Token 已刷新`, 'success');
      addLogEntry(`Token 检查完成：${account?.email || id}`, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addToast(message, 'error');
      addLogEntry(message, 'error');
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
          addToast('守护进程已停止。自动切号已打开，但不会再自动换号。', 'warning');
        } else {
          addToast(`守护进程已${nextAction === 'stop' ? '停止' : '启动'}`, nextAction === 'stop' ? 'warning' : 'success');
        }
        addLogEntry(`守护进程已${nextAction === 'stop' ? '停止' : '启动'}。`, nextAction === 'stop' ? 'warning' : 'success');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast(message, 'error');
        addLogEntry(message, 'error');
      }
      return;
    }
    setDaemonState(prev => {
      const nextStatus = prev.status === 'Running' ? 'Stopped' : 'Running';
      addToast(`守护进程已${nextStatus === 'Running' ? '启用' : '暂停'}`, nextStatus === 'Running' ? 'success' : 'warning');
      return {
        ...prev,
        status: nextStatus,
        lastChecked: 'Just now',
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
      if (oauthStatusRef.current?.pending) {
        addToast('已有授权正在进行，请先完成或取消。', 'warning');
        throw new Error('已有授权正在进行，请先完成或取消。');
      }
      markOAuthPending(null);
      addToast('正在打开授权页面，请在浏览器里完成登录。', 'info');
      addLogEntry('正在为新账号打开授权。', 'info');
      try {
        await desktopApi.addAccount();
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        if (snapshot?.oauthStatus) reportOAuthFinished(snapshot.oauthStatus);
      } catch (error) {
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        if (snapshot?.oauthStatus && !snapshot.oauthStatus.pending) {
          reportOAuthFinished(snapshot.oauthStatus);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          addToast(message, 'error');
          addLogEntry(message, 'error');
        }
        throw error;
      }
      return;
    }
    const newAcc: AccountQuota = {
      ...acc,
      id: `acc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    };
    setAccounts(prev => [...prev, newAcc]);
    addToast(`已成功添加账号 ${acc.email}`, 'success');
  };

  const handleReauthorizeAccount = async (id: string) => {
    if (oauthStatusRef.current?.pending) {
      addToast('已有授权正在进行，请先完成或取消。', 'warning');
      throw new Error('已有授权正在进行，请先完成或取消。');
    }
    markOAuthPending(id);
    addToast('正在打开授权页面，请在浏览器里完成登录。', 'info');
    addLogEntry('正在打开重新授权。', 'info');
    try {
      const result = await desktopApi.reauthorizeAccount(id);
      const snapshot = await loadDashboardState(false);
      if (snapshot) queueQuotaAutoSync(snapshot.accounts);
      if (snapshot?.oauthStatus) {
        reportOAuthFinished(snapshot.oauthStatus);
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
        },
        targetAccountId: id,
      });
    } catch (error) {
      const snapshot = await loadDashboardState(false);
      if (snapshot) queueQuotaAutoSync(snapshot.accounts);
      if (snapshot?.oauthStatus && !snapshot.oauthStatus.pending) {
        reportOAuthFinished(snapshot.oauthStatus);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        addToast(message, 'error');
        addLogEntry(message, 'error');
      }
      throw error;
    }
  };

  const handleCancelOAuth = async () => {
    await desktopApi.cancelOAuth();
    const status = await desktopApi.getOAuthStatus();
    setOAuthStatus(status);
    reportOAuthFinished(status);
  };

  const handleCompleteOAuthManually = async (callbackUrl: string) => {
    try {
      await desktopApi.completeOAuthManually(callbackUrl);
    } finally {
      const status = await desktopApi.getOAuthStatus();
      setOAuthStatus(status);
      await loadDashboardState(false);
      reportOAuthFinished(status);
    }
  };

  const handleResolveAuthConflict = async (action: 'adopt' | 'reapply') => {
    setIsResolvingAuth(true);
    try {
      if (action === 'adopt') {
        const account = await desktopApi.adoptOfficialAccount();
        addToast(`已采用官方 Codex 账号：${account.email}`, 'success');
      } else {
        await desktopApi.reapplyManagedAccount(authState.currentAccountId || null);
        addToast('管理账号已重新应用到官方 Codex。', 'success');
      }
      await loadDashboardState(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addToast(message, 'error');
      addLogEntry(message, 'error');
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
    setAccounts(prev => prev.filter(acc => acc.id !== id));
    addToast(`已成功移除账号 ${target.email}`, 'warning');
  };

  const confirmDeleteAccount = async () => {
    if (!deleteTarget || isDeletingAccount) return;
    setIsDeletingAccount(true);
    try {
      await runAccountOperation(deleteTarget.id, () => desktopApi.deleteAccount(deleteTarget.id));
      const snapshot = await loadDashboardState(false);
      if (snapshot) queueQuotaAutoSync(snapshot.accounts);
      addToast(`已删除 ${deleteTarget.email}`, 'warning');
      addLogEntry(`已从管理器中删除账号 ${deleteTarget.email}。`, 'warning');
      setDeleteTarget(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addToast(message, 'error');
      addLogEntry(message, 'error');
    } finally {
      setIsDeletingAccount(false);
    }
  };

  // Switch Current Active Account
  const handleSwitchCurrentAccount = async (id: string) => {
    if (desktopBridgeAvailable) {
      if (oauthStatusRef.current?.pending) {
        addToast('已有授权正在进行，请先完成或取消。', 'warning');
        return;
      }
      const selected = accountsRef.current.find(a => a.id === id);
      const isCurrent = !!selected?.isCurrent;
      addToast(isCurrent ? '正在重新写入官方 Codex，请稍候。' : '正在切换账号，请稍候。', 'info');
      try {
        await runAccountOperation(id, () => (
          isCurrent ? desktopApi.reapplyManagedAccount(id) : desktopApi.switchAccount(id)
        ));
        setSessionSwitchCount(count => count + 1);
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        if (isCurrent) {
          addToast(`已将 Codex 重新登录为 ${selected?.email || id}`, 'success');
          addLogEntry(`已将 Codex 重新登录为 ${selected?.email || id}`, 'success');
        } else {
          addToast(`当前账号已切换至 ${selected?.email || id}`, 'success');
          addLogEntry(`已切换当前账号：${selected?.email || id}`, 'success');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast(message, 'error');
        addLogEntry(message, 'error');
      }
      return;
    }
    setAccounts(prev => prev.map(acc => ({
      ...acc,
      isCurrent: acc.id === id,
    })));
    setSessionSwitchCount(count => count + 1);
    const selected = accounts.find(a => a.id === id);
    if (selected) {
      addToast(selected.isCurrent
        ? `已将 Codex 重新登录为 ${selected.email}`
        : `当前主账号已切换至 ${selected.email}`, 'success');
    }
  };

  // Toggle Auto-switch scope selection
  const handleToggleAccountSelection = (id: string) => {
    const selected = accounts.find(a => a.id === id);
    if (selected && !canJoinAutoSwitch(selected)) {
      addToast(
        selected.status === 'BANNED' ? '账号已封号，无法加入自动切号' : '该账号需要重新授权后才能加入自动切号',
        'info',
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
        : pruneAutoSwitchAccountIds([...currentSelected, id], accountsRef.current);
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
        addLogEntry(`已将 ${selected?.name} 移出自动切号轮换范围。`, 'warning');
        return prev.filter(item => item !== id);
      } else {
        addLogEntry(`已将 ${selected?.name} 加入自动切号轮换范围。`, 'info');
        return [...prev, id];
      }
    });
  };

  const saveAutoSwitchConfig = async (nextConfig: DesktopAutoSwitchConfig) => {
    const revision = ++configSaveRevision.current;
    const prunedConfig: DesktopAutoSwitchConfig = {
      ...nextConfig,
      selected_account_ids: pruneAutoSwitchAccountIds(nextConfig.selected_account_ids || [], accountsRef.current),
    };
    autoSwitchConfigRef.current = prunedConfig;
    setAutoSwitchConfig(prunedConfig);
    setSettings(settingsFromDesktopState(prunedConfig, appInfo, codexStatus, updateStatus || null));
    const saveOperation = configSaveQueue.current
      .catch(() => {})
      .then(() => desktopApi.saveAutoSwitchConfig(prunedConfig));
    configSaveQueue.current = saveOperation.catch(() => {});
    try {
      await saveOperation;
      if (revision === configSaveRevision.current) {
        await loadDashboardState(false);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addToast(message, 'error');
      addLogEntry(message, 'error');
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
        addToast(`全局切号已${updated ? '启用' : '禁用'}`, updated ? 'success' : 'warning');
        addLogEntry(`全局自动切号已${updated ? '启用' : '禁用'}。`, 'info');
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
      addToast(`全局切号已${enabled ? '启用' : '禁用'}`, enabled ? 'success' : 'warning');
      addLogEntry(`全局自动切号已${enabled ? '启用' : '禁用'}。`, 'info');
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
    const summary = await desktopApi.refreshAllTokens(false);
    await loadDashboardState(false);
    const total = summary.results.length;
    const { passed, reauthSkipped, bannedSkipped, failed } = summarizeTokenCheckResults(summary.results);
    if (failed || bannedSkipped) {
      const parts = [`${passed}/${total} 通过`];
      if (reauthSkipped) parts.push(`${reauthSkipped} 个需重新授权`);
      if (bannedSkipped) parts.push(`${bannedSkipped} 个已封号`);
      if (failed) parts.push(`${failed} 个失败`);
      const message = `令牌检查完成：${parts.join('，')}。`;
      addToast(message, 'warning');
      addLogEntry(message, 'warning');
      return;
    }
    if (reauthSkipped) {
      const message = `令牌检查完成：${passed}/${total} 通过，${reauthSkipped} 个需重新授权。`;
      addToast(message, 'warning');
      addLogEntry(message, 'warning');
      return;
    }
    const message = total > 0 ? `已检查 ${total} 个账号的令牌` : '没有可检查的账号';
    addToast(message, total > 0 ? 'success' : 'info');
    addLogEntry(message, total > 0 ? 'success' : 'info');
  };

  const handleDetectClient = async () => {
    if (!desktopBridgeAvailable) return;
    const status = await desktopApi.getCodexStatus();
    setCodexStatus(status);
    setSettings(prev => ({ ...prev, clientDetected: !!status?.installed }));
    addToast(status?.installed ? '已检测到官方 Codex' : '未检测到官方 Codex', status?.installed ? 'success' : 'warning');
  };

  const handleCheckUpdates = async () => {
    if (!desktopBridgeAvailable) return;
    if (!appInfo?.updateEnabled) {
      await handleOpenExternal(`${appInfo?.repository || 'https://github.com/3xiaoshayu/codex-account-manager'}/releases`);
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
    const snapshot = await loadDashboardState(false);
    if (snapshot) queueQuotaAutoSync(snapshot.accounts);
    if (result?.switched) {
      setSessionSwitchCount(count => count + 1);
      addToast(`已切换至 ${result.to?.email || '新账号'}`, 'success');
    } else if (result?.reason === 'disabled') {
      addToast('额度已低于阈值，但全局开关已关闭，未切换账号。', 'warning');
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
        accountsRef.current,
      );
      nextConfig.selected_account_ids = seeded;
      selectedAccountIdsRef.current = seeded;
      setSelectedAccountIds(seeded);
    }
    await saveAutoSwitchConfig(nextConfig);
  };

  const authBannerKey = `${authState.status}:${authState.currentAccountId || ''}:${authState.officialIdentity?.email || ''}`;
  const showAuthBanner = desktopBridgeAvailable && authState.requiresResolution && authBannerDismissedKey !== authBannerKey;

  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} userEmail={userEmail} appVersion={settings.version} showDemoShortcuts={!desktopBridgeAvailable && !wantsDesktopLoginPreview()} />;
  }

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
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none" id="toast-tray">
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
              <span className="text-xs font-semibold text-label">{t.msg}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Main Sidebar Component */}
      <Sidebar 
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        daemonState={daemonState}
        onShowSupport={() => setShowSupport(true)}
        onShowUpdates={() => setShowUpdates(true)}
      />

      {/* Right Column Layout Wrapper */}
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden" id="dashboard-right-wrapper">
        {/* Navigation Utilities Header */}
        <Header 
          currentUserEmail={userEmail}
          onLogout={desktopBridgeAvailable && !wantsDesktopLoginPreview() ? undefined : handleLogout}
          unreadNotificationsCount={showNotifications ? 0 : countUnreadAlertLogs(logs, lastReadLogId)}
          onToggleNotifications={() => setShowNotifications(!showNotifications)}
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
                      正在读取本地账号、额度状态与守护进程设置。
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
                  accounts={accounts}
                  onRefreshAccount={handleRefreshAccount}
                  onRefreshToken={desktopBridgeAvailable ? handleRefreshToken : undefined}
                  onRefreshAll={handleRefreshAll}
                  isRefreshingAll={isRefreshingAll}
                />
              )}

              {activeTab === 'autoswitch' && (
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
                  accounts={accounts}
                  onAddAccount={handleAddAccount}
                  onDeleteAccount={handleDeleteAccount}
                  onSwitchCurrentAccount={handleSwitchCurrentAccount}
                  onRefreshAccount={handleRefreshAccount}
                  onReauthorizeAccount={desktopBridgeAvailable ? handleReauthorizeAccount : undefined}
                  onCancelOAuth={desktopBridgeAvailable ? handleCancelOAuth : undefined}
                  onCompleteOAuthManually={desktopBridgeAvailable ? handleCompleteOAuthManually : undefined}
                  onAddLog={addLogEntry}
                  oauthMode={desktopBridgeAvailable}
                  oauthStatus={oauthStatus}
                  authState={desktopBridgeAvailable ? authState : null}
                  onOpenModal={() => setShowNotifications(false)}
                />
              )}

              {activeTab === 'settings' && (
                <SettingsView 
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
                  accountCount={accounts.length}
                  repositoryUrl={appInfo?.repository || 'https://github.com/3xiaoshayu/codex-account-manager'}
                  onOpenLogs={desktopBridgeAvailable ? async () => { await desktopApi.openLogs(); } : undefined}
                  onShowFloatWindow={async () => {
                    if (!desktopBridgeAvailable) return;
                    const state = await desktopApi.showFloatWindow();
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
          className="h-10 border-t border-sep flex items-center justify-between px-8 text-[11px] text-label-2 font-medium select-none shrink-0"
          id="dashboard-footer"
        >
          <div className="flex items-center gap-1.5" id="footer-left">
            <span>Codex Account Manager {settings.version.startsWith('v') ? settings.version : `v${settings.version}`}</span>
          </div>
          <div className="flex items-center gap-4" id="footer-right">
            <button 
              onClick={() => {
                void handleOpenExternal(`${appInfo?.repository || 'https://github.com/3xiaoshayu/codex-account-manager'}/blob/main/docs/privacy.md`);
              }}
              className="hover:text-label cursor-pointer"
            >
              隐私政策
            </button>
          </div>
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

      {/* Overlay Notification Center Sidebar panel */}
      <AnimatePresence>
      {showNotifications && (
          <>
            <motion.div 
              key="notifications-backdrop"
              className="fixed inset-0 bg-black/40 z-35" 
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
                  <h3 className="font-bold text-sm tracking-wide font-sans">系统动态日志</h3>
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
                    暂无动态
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
              <h3 className="text-lg font-bold tracking-tight mb-2 font-sans">客户服务</h3>
              <p className="text-xs text-label-2 leading-relaxed mb-6 font-sans">
                如果您在使用 Codex 账号管理器时遇到配额验证、客户端连接或服务问题，请通过 GitHub Issues 提交可复现信息。
              </p>

              <div className="mb-6" id="support-channels-list">
                <div className="p-3 bg-white/[0.06] rounded-xl flex items-center justify-between text-xs font-semibold">
                  <span className="text-label-2">GitHub Issues</span>
                  <button
                    type="button"
                    className="text-accent cursor-pointer"
                    onClick={() => void handleOpenExternal(`${appInfo?.repository || 'https://github.com/3xiaoshayu/codex-account-manager'}/issues`)}
                  >
                    打开 Issues
                  </button>
                </div>
                <p className="mt-2 px-1 text-[11px] text-label-3 leading-5">
                  支持方式：社区协助，尽力而为
                </p>
              </div>

              <button
                onClick={() => setShowSupport(false)}
                className="w-full py-3 bg-accent/12 hover:bg-accent/20 border border-accent/20 text-accent hover:text-accent-hi rounded-xl text-xs font-bold transition-all cursor-pointer"
              >
                好的，我知道了
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
                    <li>额度检查能区分已封号、需重新授权、额度限流和同步失败。</li>
                    <li>刷新额度失败时不再提示成功；授权中途卡住可以取消或重试。</li>
                    <li>配额页和账号页的「需要处理」口径一致；时长和套餐副标题改为中文。</li>
                    <li>切号前检测官方 Codex 不再卡住界面；悬浮窗高度会记住。</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-bold text-white mb-1">已验证修复</h4>
                  <ul className="list-disc pl-4 space-y-1 text-label-2 text-[11px]">
                    <li>添加账号弹窗不再显示误导性的套餐和优先级下拉框。</li>
                    <li>套餐与轮转优先级继续由 OAuth 授权后的账号状态自动识别。</li>
                    <li>网络失败会显示短中文说明，而不是 Electron 报错原文。</li>
                  </ul>
                </div>
              </div>

              <button
                onClick={() => setShowUpdates(false)}
                className="w-full py-3 bg-accent/12 hover:bg-accent/20 border border-accent/20 text-accent hover:text-accent-hi rounded-xl text-xs font-bold transition-all cursor-pointer"
              >
                确认版本
              </button>
            </motion.div>
          </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  if (isFloatRenderer()) return <FloatLens />;
  return <DashboardApp />;
}

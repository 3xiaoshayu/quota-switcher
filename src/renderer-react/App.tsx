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
  desktopApi,
  formatDateTime,
  hasDesktopBridge,
  needsQuotaAutoSync,
  QUOTA_AUTO_SYNC_MIN_GAP_MS,
} from './api/desktop';
import Login from './components/Login';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import QuotasView from './components/QuotasView';
import AutoSwitchView from './components/AutoSwitchView';
import AccountsView from './components/AccountsView';
import SettingsView from './components/SettingsView';
import japanBackground from './assets/background-japan.jpg';
import settingsBackground from './assets/background-settings.jpg';
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

// Decode both dashboard backdrops up front so the first tab switch never
// stalls on JPEG decoding.
if (typeof Image !== 'undefined') {
  for (const src of [japanBackground, settingsBackground]) {
    const img = new Image();
    img.src = src;
  }
}

// Same gradients and images as before; rendered as two persistent layers so
// switching tabs only animates GPU-composited opacity instead of a full
// background-image cross-fade repaint.
const JAPAN_BACKDROP = `linear-gradient(to bottom, rgba(15, 23, 42, 0.45), rgba(15, 23, 42, 0.7)), url('${japanBackground}')`;
const FUJI_BACKDROP = `linear-gradient(to bottom, rgba(15, 23, 42, 0.45), rgba(15, 23, 42, 0.75)), url('${settingsBackground}')`;

const DEFAULT_CONFIG: DesktopAutoSwitchConfig = {
  enabled: false,
  primary_threshold: 20,
  secondary_threshold: 30,
  account_scope_mode: 'all',
  selected_account_ids: [],
  sync_interval_minutes: 10,
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

export default function App() {
  // Authentication state - persistence in localStorage for robustness
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
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
    desktopBridgeAvailable ? { status: 'Stopped', syncInterval: 10, lastChecked: '尚未检查' } : INITIAL_DAEMON_STATE,
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
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const addLogEntry = useCallback((message: string, type: LogEntry['type']) => {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const newLog: LogEntry = {
      id: `l_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp,
      message,
      type,
    };
    // Cap the in-memory feed so long sessions cannot grow it without bound.
    setLogs(prev => [newLog, ...prev].slice(0, 500));
  }, []);

  const runAccountOperation = useCallback(async <T,>(id: string, task: () => Promise<T>): Promise<T> => {
    if (accountOperationIds.current.has(id)) {
      throw new Error('This account already has an operation in progress.');
    }
    accountOperationIds.current.add(id);
    try {
      return await task();
    } finally {
      accountOperationIds.current.delete(id);
    }
  }, []);

  const applyDashboardState = useCallback((snapshot: Awaited<ReturnType<typeof desktopApi.loadDashboardState>>) => {
    setAccounts(snapshot.accounts);
    setAutoSwitchConfig(snapshot.config);
    autoSwitchConfigRef.current = snapshot.config;
    setAppInfo(snapshot.appInfo);
    setCodexStatus(snapshot.codexStatus);
    setUpdateStatus(snapshot.updateStatus);
    setAuthState(snapshot.authState);
    authStateRef.current = snapshot.authState;
    setOAuthStatus(snapshot.oauthStatus);
    if (snapshot.oauthStatus.pending) setActiveTab('accounts');
    setSettings(settingsFromDesktopState(snapshot.config, snapshot.appInfo, snapshot.codexStatus, snapshot.updateStatus));
    setDaemonState({
      status: snapshot.daemonRunning ? 'Running' : 'Stopped',
      syncInterval: snapshot.daemonSyncInterval,
      lastChecked: snapshot.daemonLastRunAt ? formatDateTime(snapshot.daemonLastRunAt) : '尚未检查',
      lastSuccessAt: snapshot.daemonLastSuccessAt,
      lastError: snapshot.daemonLastError,
      pausedReason: snapshot.daemonPausedReason,
    });
    setSelectedAccountIds(
      snapshot.config.account_scope_mode === 'selected'
        ? snapshot.config.selected_account_ids || []
        : snapshot.accounts.map((account) => account.id),
    );
    selectedAccountIdsRef.current = snapshot.config.account_scope_mode === 'selected'
      ? snapshot.config.selected_account_ids || []
      : snapshot.accounts.map((account) => account.id);
    if (snapshot.currentAccount?.email) {
      setUserEmail(snapshot.currentAccount.email);
      localStorage.setItem('codex_auth_email', snapshot.currentAccount.email);
    }
  }, []);

  const loadDashboardState = useCallback(async (showLoading = false) => {
    if (!desktopBridgeAvailable) return null;
    if (showLoading && !hasLoadedDashboard.current) {
      setDashboardLoadState('loading');
      setDashboardLoadError(null);
    }
    try {
      const snapshot = await desktopApi.loadDashboardState();
      applyDashboardState(snapshot);
      hasLoadedDashboard.current = true;
      setDashboardLoadState('ready');
      setDashboardLoadError(null);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      !accountOperationIds.current.has(account.id) && needsQuotaAutoSync(account)
    ));
    if (!staleAccounts.length) return;

    lastQuotaAutoSyncAt.current = Date.now();
    quotaAutoSyncPromise.current = (async () => {
      for (const account of staleAccounts) {
        try {
          await desktopApi.refreshQuota(account.id, false);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addLogEntry(`${account.email}: ${message}`, 'warning');
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
      loadDashboardState(true).then((snapshot) => {
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
      });
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

  // Escape closes the topmost dismissible overlay. The auth-conflict dialog
  // intentionally ignores Escape: it requires an explicit decision.
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
      window.clearInterval(syncTimer);
      unsubscribe();
    };
  }, [addLogEntry, addToast, isAuthenticated, loadDashboardState, queueQuotaAutoSync]);

  useEffect(() => {
    if (!isAuthenticated || !desktopBridgeAvailable || !oauthStatus?.pending) return;
    let disposed = false;
    const pollOAuthStatus = async () => {
      try {
        const status = await desktopApi.getOAuthStatus();
        if (disposed) return;
        setOAuthStatus(status);
        if (!status.pending) {
          await loadDashboardState(false);
          if (status.status === 'error' || status.status === 'expired') {
            addToast(status.message || 'OAuth 授权结束，未添加账号。', 'warning');
          }
        }
      } catch {}
    };
    const timer = window.setInterval(() => {
      void pollOAuthStatus();
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [addToast, isAuthenticated, loadDashboardState, oauthStatus?.pending]);

  // Global Refresh All trigger
  const handleRefreshAll = async () => {
    if (desktopBridgeAvailable) {
      setIsRefreshingAll(true);
      addToast('正在刷新全部账号额度...', 'info');
      addLogEntry('开始同步全部账号额度...', 'info');
      try {
        const results = await desktopApi.refreshAllQuotas();
        const failed = results.filter((item) => item.error).length;
        const skipped = results.filter((item) => item.skipped).length;
        const refreshed = results.length - failed - skipped;
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        if (failed) {
          addToast(`已刷新 ${refreshed} 个，${skipped} 个需重新授权，${failed} 个失败`, 'warning');
          addLogEntry(`额度刷新完成：跳过 ${skipped} 个，失败 ${failed} 个。`, 'warning');
        } else if (skipped) {
          addToast(`已刷新 ${refreshed} 个；${skipped} 个需重新授权`, 'info');
          addLogEntry(`额度刷新完成；${skipped} 个账号需要重新授权。`, 'info');
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
      try {
        await runAccountOperation(id, () => desktopApi.refreshQuota(id));
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        addToast(`${account?.email || id} 额度已刷新`, 'success');
        addLogEntry(`账号额度已刷新：${account?.email || id}`, 'success');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast(message, 'error');
        addLogEntry(message, 'error');
        throw error;
      }
      return;
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
        addToast(`守护进程已${nextAction === 'stop' ? '停止' : '启动'}`, nextAction === 'stop' ? 'warning' : 'success');
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
    const syncInterval = Math.min(60, Math.max(1, Math.round(Number(val) || 10)));
    setDaemonState(prev => ({
      ...prev,
      syncInterval,
    }));
  };

  // Update sync interval
  const handleUpdateSyncInterval = (val: number) => {
    const syncInterval = Math.min(60, Math.max(1, Math.round(Number(val) || 10)));
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
    addToast(`同步间隔已调整为 ${val} 分钟`, 'info');
    addLogEntry(`同步间隔已调整为 ${syncInterval} 分钟。`, 'info');
  };

  // Add new account
  const handleAddAccount = async (acc: Omit<AccountQuota, 'id'>) => {
    if (desktopBridgeAvailable) {
      addToast('正在打开 OAuth 授权...', 'info');
      addLogEntry('正在为新账号打开 OAuth 授权流程。', 'info');
      try {
        const result = await desktopApi.addAccount();
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        addToast(result.account?.email ? `已添加 ${result.account.email}` : '账号已添加', 'success');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast(message, 'error');
        addLogEntry(message, 'error');
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
    const target = accountsRef.current.find(account => account.id === id);
    const result = await desktopApi.reauthorizeAccount(id);
    const snapshot = await loadDashboardState(false);
    if (snapshot) queueQuotaAutoSync(snapshot.accounts);
    if (result.mismatch) {
      addToast(`浏览器授权了另一个账号，${result.account?.email || '它'}已单独保存。`, 'warning');
      addLogEntry(`重新授权身份与 ${target?.email || id} 不符，新账号已单独保存。`, 'warning');
      return;
    }
    addToast(`${target?.email || id} 已重新授权`, 'success');
    addLogEntry(`账号已重新授权：${target?.email || id}`, 'success');
  };

  const handleCancelOAuth = async () => {
    await desktopApi.cancelOAuth();
    setOAuthStatus(await desktopApi.getOAuthStatus());
    addLogEntry('OAuth 授权已取消。', 'warning');
  };

  const handleCompleteOAuthManually = async (callbackUrl: string) => {
    const result = await desktopApi.completeOAuthManually(callbackUrl);
    const snapshot = await loadDashboardState(false);
    if (snapshot) queueQuotaAutoSync(snapshot.accounts);
    if (result.mismatch) {
      addToast(`浏览器授权了另一个账号，${result.account?.email || '它'}已单独保存。`, 'warning');
      addLogEntry('手动 OAuth 回调完成，另一账号已单独保存。', 'warning');
      return;
    }
    addToast(result.account?.email ? `已添加 ${result.account.email}` : 'OAuth 账号已添加', 'success');
    addLogEntry('手动 OAuth 回调已完成。', 'success');
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
      const selected = accountsRef.current.find(a => a.id === id);
      try {
        await runAccountOperation(id, () => desktopApi.switchAccount(id));
        setSessionSwitchCount(count => count + 1);
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        addToast(`当前账号已切换至 ${selected?.email || id}`, 'success');
        addLogEntry(`已切换当前账号：${selected?.email || id}`, 'success');
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
      addToast(`当前主账号已切换至 ${selected.email}`, 'success');
    }
  };

  // Toggle Auto-switch scope selection
  const handleToggleAccountSelection = (id: string) => {
    const selected = accounts.find(a => a.id === id);
    if (desktopBridgeAvailable) {
      const currentSelected = selectedAccountIdsRef.current;
      const nextSelected = currentSelected.includes(id)
        ? currentSelected.filter(item => item !== id)
        : [...currentSelected, id];
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
        addLogEntry(`Removed ${selected?.name} from auto-switch active rotation pool.`, 'warning');
        return prev.filter(item => item !== id);
      } else {
        addLogEntry(`Added ${selected?.name} into auto-switch active rotation pool.`, 'info');
        return [...prev, id];
      }
    });
  };

  const saveAutoSwitchConfig = async (nextConfig: DesktopAutoSwitchConfig) => {
    const revision = ++configSaveRevision.current;
    autoSwitchConfigRef.current = nextConfig;
    setAutoSwitchConfig(nextConfig);
    setSettings(settingsFromDesktopState(nextConfig, appInfo, codexStatus, updateStatus || null));
    const saveOperation = configSaveQueue.current
      .catch(() => {})
      .then(() => desktopApi.saveAutoSwitchConfig(nextConfig));
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
        addLogEntry(`Global automated switching pool state modified to: ${updated ? 'ON' : 'OFF'}`, 'info');
        return { ...prev, globalSwitch: updated };
      });
      return;
    }

    const nextConfig = {
      ...autoSwitchConfigRef.current,
      enabled: !autoSwitchConfigRef.current.enabled,
    };
    await saveAutoSwitchConfig(nextConfig);
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
    const needsReauthorization = summary.results.filter(
      result => !result.ok && (result.reauthRequired || result.skipped),
    );
    const failed = summary.results.filter(
      result => !result.ok && !needsReauthorization.includes(result),
    );
    const passed = summary.results.filter(result => result.ok).length;
    if (failed.length > 0) {
      const reauthorizationText = needsReauthorization.length > 0
        ? `，${needsReauthorization.length} 个需重新授权`
        : '';
      const message = `Token 检查完成：${passed}/${total} 通过${reauthorizationText}，${failed.length} 个失败。`;
      addToast(message, 'warning');
      throw new Error(message);
    }
    if (needsReauthorization.length > 0) {
      const message = `Token 检查完成：${passed}/${total} 通过，${needsReauthorization.length} 个需重新授权。`;
      addToast(message, 'warning');
      addLogEntry(message, 'warning');
      return;
    }
    const message = total > 0 ? `已检查 ${total} 个账号 Token` : '没有可检查的账号 Token';
    addToast(message, total > 0 ? 'success' : 'info');
    addLogEntry(message, total > 0 ? 'success' : 'info');
  };

  const handleDetectClient = async () => {
    if (!desktopBridgeAvailable) return;
    const status = await desktopApi.getCodexStatus();
    setCodexStatus(status);
    setSettings(prev => ({ ...prev, clientDetected: !!status?.installed }));
    addToast(status?.installed ? '已检测到 Codex 客户端' : '未检测到 Codex 客户端', status?.installed ? 'success' : 'warning');
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
    } else {
      addToast(result?.reason || '无需切换', 'info');
    }
    return result;
  };

  const handleScopeModeChange = async (mode: 'all' | 'selected') => {
    if (!desktopBridgeAvailable) return;
    const nextConfig = {
      ...autoSwitchConfigRef.current,
      account_scope_mode: mode,
    };
    await saveAutoSwitchConfig(nextConfig);
  };

  // 'accounts'/'settings' show the sakura backdrop; 'quotas'/'autoswitch'
  // show the foggy dawn backdrop. Same imagery as before.
  const showsJapanBackdrop = activeTab === 'accounts' || activeTab === 'settings';

  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} userEmail={userEmail} appVersion={settings.version} showDemoShortcuts={!desktopBridgeAvailable} />;
  }

  return (
    <div 
      className="h-screen w-screen flex overflow-hidden relative isolate select-none text-slate-100 font-sans"
      id="dashboard-main-container"
    >
      {/* Persistent backdrop layers; only opacity animates on tab switches. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-cover bg-center transition-opacity duration-1000 pointer-events-none"
        style={{ backgroundImage: JAPAN_BACKDROP, opacity: showsJapanBackdrop ? 1 : 0 }}
        id="dashboard-backdrop-japan"
      />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-cover bg-center transition-opacity duration-1000 pointer-events-none"
        style={{ backgroundImage: FUJI_BACKDROP, opacity: showsJapanBackdrop ? 0 : 1 }}
        id="dashboard-backdrop-fuji"
      />
      {/* Absolute overlay elements */}
      {/* Toast notification Tray */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none" id="toast-tray">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 50, scale: 0.9 }}
              className="glass-card pointer-events-auto backdrop-blur-xl bg-slate-950/80 border border-white/10 rounded-2xl p-4 flex items-center gap-3 shadow-2xl"
              key={t.id}
            >
              {t.type === 'success' && <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />}
              {t.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />}
              {t.type === 'warning' && <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />}
              {t.type === 'info' && <Info className="w-5 h-5 text-blue-400 shrink-0" />}
              <span className="text-xs font-semibold text-slate-200">{t.msg}</span>
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
          onLogout={handleLogout}
          unreadNotificationsCount={logs.filter(l => l.type === 'warning' || l.type === 'error').length}
          onToggleNotifications={() => setShowNotifications(!showNotifications)}
        />

        {/* Dashboard Content Scroller with Transition animations */}
        <main className="flex-1 overflow-hidden flex flex-col position-relative" id="main-content">
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
                  <div className="glass-card flex w-full max-w-sm flex-col items-center rounded-3xl border border-white/10 bg-slate-950/45 px-8 py-10 text-center shadow-2xl backdrop-blur-xl">
                    <LoaderCircle className="mb-4 h-8 w-8 animate-spin text-blue-400" />
                    <h2 className="text-base font-bold text-white">正在加载账号数据</h2>
                    <p className="mt-2 text-xs leading-5 text-slate-400">
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
                  <div className="flex w-full max-w-md flex-col items-center rounded-3xl border border-rose-500/20 bg-slate-950/55 px-8 py-10 text-center shadow-2xl backdrop-blur-xl">
                    <AlertCircle className="mb-4 h-9 w-9 text-rose-400" />
                    <h2 className="text-base font-bold text-white">账号数据加载失败</h2>
                    <p className="mt-2 max-w-sm text-xs leading-5 text-slate-400">
                      {dashboardLoadError || '本地账号存储未响应。'}
                    </p>
                    <motion.button
                      type="button"
                      onClick={() => void loadDashboardState(true)}
                      whileHover={{ y: -1 }}
                      whileTap={{ scale: 0.96 }}
                      className="mt-6 flex items-center gap-2 rounded-2xl border border-blue-500/30 bg-blue-500/15 px-5 py-2.5 text-xs font-bold text-blue-200 hover:bg-blue-500/20"
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
                />
              )}
                </>
              )}
          </motion.div>
        </main>

        {/* Global Footer bar matching image */}
        <footer 
          className="h-10 border-t border-white/5 backdrop-blur-md bg-slate-950/15 flex items-center justify-between px-8 text-[11px] text-slate-400 font-medium select-none shrink-0"
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
              className="hover:text-slate-200 cursor-pointer"
            >
              隐私政策
            </button>
          </div>
        </footer>
      </div>

      <AnimatePresence>
      {deleteTarget && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-md"
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
            className="glass-card w-full max-w-sm rounded-3xl border border-rose-500/20 bg-slate-900/95 p-7 text-left shadow-2xl"
            id="delete-confirm-modal"
            role="alertdialog"
            aria-modal="true"
          >
            <Trash2 className="mb-4 h-9 w-9 text-rose-400" />
            <h3 className="text-lg font-bold text-white">删除账号</h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-300">
              确定要删除 <strong className="text-white">{deleteTarget.email}</strong> 吗？该操作无法撤销。
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                onClick={() => { if (!isDeletingAccount) setDeleteTarget(null); }}
                disabled={isDeletingAccount}
                className="rounded-2xl bg-white/5 hover:bg-white/10 px-4 py-3 text-xs font-bold text-slate-200 disabled:opacity-50 cursor-pointer"
                id="delete-confirm-cancel"
              >
                取消
              </button>
              <button
                onClick={() => void confirmDeleteAccount()}
                disabled={isDeletingAccount}
                className="rounded-2xl border border-rose-500/30 bg-rose-500/15 px-4 py-3 text-xs font-bold text-rose-200 hover:bg-rose-500/25 disabled:opacity-50 cursor-pointer"
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
      {authState.requiresResolution && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-md"
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
            className="w-full max-w-md rounded-3xl border border-amber-500/20 bg-slate-900/95 p-7 text-left shadow-2xl"
            id="auth-conflict-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="auth-conflict-title"
          >
            <ShieldAlert className="mb-4 h-10 w-10 text-amber-400" />
            <h3 id="auth-conflict-title" className="text-lg font-bold text-white">
              {authState.status === 'unknown' ? '认证状态不可用' : '官方 Codex 登录已变更'}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-300">
              {authState.message || '官方 Codex 登录与本管理器记录的当前账号不一致。'}
            </p>
            {authState.officialIdentity?.email && (
              <div className="mt-4 rounded-2xl border border-white/5 bg-slate-950/35 px-4 py-3 text-xs text-slate-300">
                官方账号：<strong className="text-white">{authState.officialIdentity.email}</strong>
              </div>
            )}
            <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
              在处理此冲突之前，自动切号与认证写入将保持暂停。
            </p>
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {authState.status === 'unknown' && (
                <button
                  onClick={() => void loadDashboardState(false)}
                  disabled={isResolvingAuth}
                  className="rounded-2xl border border-blue-500/25 bg-blue-500/10 px-4 py-3 text-xs font-bold text-blue-300 hover:bg-blue-500/15 disabled:opacity-50"
                  id="auth-conflict-reload"
                >
                  重新加载状态
                </button>
              )}
              {(authState.status === 'conflict' || authState.status === 'unmanaged_official_auth') && (
                <button
                  onClick={() => void handleResolveAuthConflict('adopt')}
                  disabled={isResolvingAuth}
                  className="rounded-2xl border border-blue-500/25 bg-blue-500/10 px-4 py-3 text-xs font-bold text-blue-300 hover:bg-blue-500/15 disabled:opacity-50"
                  id="auth-conflict-adopt"
                >
                  采用官方账号
                </button>
              )}
              {authState.currentAccountId && (
                <button
                  onClick={() => void handleResolveAuthConflict('reapply')}
                  disabled={isResolvingAuth}
                  className="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs font-bold text-amber-300 hover:bg-amber-500/15 disabled:opacity-50"
                  id="auth-conflict-reapply"
                >
                  重写为管理账号
                </button>
              )}
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
              className="fixed right-0 top-0 bottom-0 w-80 backdrop-blur-2xl bg-slate-900/95 border-l border-white/10 p-6 z-40 shadow-2xl flex flex-col text-slate-200 text-left"
              id="notification-sidebar-center"
              initial={{ x: 340 }}
              animate={{ x: 0 }}
              exit={{ x: 340 }}
              transition={{ type: 'spring', stiffness: 380, damping: 36 }}
            >
              <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-6">
                <div className="flex items-center gap-2">
                  <Bell className="w-4 h-4 text-blue-400" />
                  <h3 className="font-bold text-sm tracking-wide font-sans">系统动态日志</h3>
                </div>
                <button
                  onClick={() => setShowNotifications(false)}
                  className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Logs stream */}
              <div className="flex-1 overflow-y-auto space-y-4 pr-1 scrollbar-thin">
                {logs.map((log) => {
                  let color = "text-blue-400";
                  if (log.type === 'success') color = "text-emerald-400";
                  if (log.type === 'warning') color = "text-amber-400";
                  if (log.type === 'error') color = "text-rose-400";

                  return (
                    <div className="p-3 bg-white/[0.06] rounded-xl text-xs space-y-1" key={log.id}>
                      <div className="flex items-center justify-between">
                        <span className={`font-bold capitalize text-[10px] ${color}`}>{log.type}</span>
                        <span className="text-[9px] text-slate-500 tabular-nums">{log.timestamp}</span>
                      </div>
                      <p className="text-slate-300 leading-relaxed text-[11px] font-sans font-medium">{log.message}</p>
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
            className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-4"
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
              className="glass-card backdrop-blur-2xl bg-slate-900/90 border border-white/10 rounded-3xl p-8 w-full max-w-md shadow-2xl relative text-white text-left select-none"
              id="support-modal-popup"
            >
              <button
                onClick={() => setShowSupport(false)}
                className="absolute top-5 right-5 p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <HelpCircle className="w-12 h-12 text-blue-400 mb-4" />
              <h3 className="text-lg font-bold tracking-tight mb-2 font-sans">客户服务 / Technical Support</h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-6 font-sans">
                如果您在使用 Codex 账号管理器时遇到配额验证、客户端连接或服务问题，请通过 GitHub Issues 提交可复现信息。
              </p>

              <div className="space-y-3 mb-6" id="support-channels-list">
                <div className="p-3 bg-white/[0.06] rounded-2xl flex items-center justify-between text-xs font-semibold">
                  <span className="text-slate-400">GitHub Issues</span>
                  <a className="text-blue-400" href={`${appInfo?.repository || 'https://github.com/3xiaoshayu/codex-account-manager'}/issues`} target="_blank" rel="noopener noreferrer">Open issue tracker</a>
                </div>
                <div className="p-3 bg-white/[0.06] rounded-2xl flex items-center justify-between text-xs font-semibold">
                  <span className="text-slate-400">支持方式</span>
                  <span className="text-emerald-400">Community / Best effort</span>
                </div>
              </div>

              <button
                onClick={() => setShowSupport(false)}
                className="w-full py-3 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 text-blue-300 hover:text-blue-200 rounded-2xl text-xs font-bold transition-all cursor-pointer"
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
            className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-4"
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
              className="glass-card backdrop-blur-2xl bg-slate-900/90 border border-white/10 rounded-3xl p-8 w-full max-w-md shadow-2xl relative text-white text-left select-none"
              id="updates-modal-popup"
            >
              <button
                onClick={() => setShowUpdates(false)}
                className="absolute top-5 right-5 p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <Activity className="w-12 h-12 text-cyan-400 mb-4" />
              <h3 className="text-lg font-bold tracking-tight mb-2 font-sans">版本更新详情 / Release Notes</h3>
              <p className="text-xs text-slate-400 mb-6 font-sans">
                当前版本 <strong>{settings.version.startsWith('v') ? settings.version : `v${settings.version}`}</strong>。
              </p>

              <div className="space-y-4 max-h-48 overflow-y-auto pr-2 mb-6 text-xs text-slate-300 leading-relaxed font-sans" id="changelog-list">
                <div>
                  <h4 className="font-bold text-white mb-1">发布说明校准 (Release Notes)</h4>
                  <ul className="list-disc pl-4 space-y-1 text-slate-400 text-[11px]">
                    <li>修正应用内 Release Notes 的过时说明，与当前版本保持一致。</li>
                    <li>保留批量 Token 检查的真实反馈：区分重新授权与真正失败。</li>
                    <li>通知日志继续记录每次检查结果，便于回看操作是否执行。</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-bold text-white mb-1">已验证修复 (Verified Fixes)</h4>
                  <ul className="list-disc pl-4 space-y-1 text-slate-400 text-[11px]">
                    <li>添加账号弹窗不再显示误导性的套餐和优先级下拉框。</li>
                    <li>套餐与轮转优先级继续由 OAuth 授权后的账号状态自动识别。</li>
                    <li>本版本已重新视觉验证并发布 Windows 安装包与 zip 包。</li>
                  </ul>
                </div>
              </div>

              <button
                onClick={() => setShowUpdates(false)}
                className="w-full py-3 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 text-blue-300 hover:text-blue-200 rounded-2xl text-xs font-bold transition-all cursor-pointer"
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

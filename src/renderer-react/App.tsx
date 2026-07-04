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
  if (!status) return 'Unknown';
  if (status.status === 'error') return status.error || 'Update check failed';
  if (status.status === 'downloaded') return 'Ready to install';
  if (status.status === 'checking') return 'Checking';
  if (status.status === 'disabled') return status.message || 'Updates disabled';
  return status.message || 'Up to date';
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
    desktopBridgeAvailable ? { status: 'Stopped', syncInterval: 10, lastChecked: 'Not checked yet' } : INITIAL_DAEMON_STATE,
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
    setLogs(prev => [newLog, ...prev]);
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
      lastChecked: snapshot.daemonLastRunAt ? formatDateTime(snapshot.daemonLastRunAt) : 'Not checked yet',
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
    addLogEntry(`User ${email} signed into the console panel successfully.`, 'success');
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
          addToast(`Auto-switched to ${result.to?.email || 'new account'}`, 'warning');
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
        addToast(state.message || 'Official Codex authentication changed.', 'warning');
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
            addToast(status.message || 'OAuth authorization ended without an account.', 'warning');
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
      addToast('Refreshing all account quotas...', 'info');
      addLogEntry('Initiating global quota synchronization across all endpoints...', 'info');
      try {
        const results = await desktopApi.refreshAllQuotas();
        const failed = results.filter((item) => item.error).length;
        const skipped = results.filter((item) => item.skipped).length;
        const refreshed = results.length - failed - skipped;
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        if (failed) {
          addToast(`${refreshed} refreshed, ${skipped} need reauthorization, ${failed} failed`, 'warning');
          addLogEntry(`Quota refresh completed with ${skipped} account(s) skipped and ${failed} failed.`, 'warning');
        } else if (skipped) {
          addToast(`${refreshed} refreshed; ${skipped} need reauthorization`, 'info');
          addLogEntry(`Quota refresh completed; ${skipped} account(s) require reauthorization.`, 'info');
        } else {
          addToast(`${refreshed} account quotas refreshed`, 'success');
          addLogEntry('Global accounts quota synchronization complete. Status OK.', 'success');
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
    addLogEntry('Initiating global quota synchronization across all endpoints...', 'info');

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
      addLogEntry('Global accounts quota synchronization complete. Status OK.', 'success');
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
        addToast(`${account?.email || id} quota refreshed`, 'success');
        addLogEntry(`Account quota refreshed: ${account?.email || id}`, 'success');
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

  // Reset expired account back to active
  const handleResetAccount = async (id: string) => {
    if (desktopBridgeAvailable) {
      const account = accountsRef.current.find(item => item.id === id);
      if (!account) return;
      if (!account.resetCreditsAvailable) {
        addToast(`${account.email} has no reset credits available`, 'warning');
        addLogEntry(`${account.email} reset credit unavailable.`, 'warning');
        return;
      }
      const confirmed = window.confirm(`Consume one reset credit for ${account.email}?`);
      if (!confirmed) return;
      try {
        const result = await runAccountOperation(id, async () => {
          const consumption = await desktopApi.consumeResetCredit(id);
          let quotaRefreshError: string | null = null;
          try {
            await desktopApi.refreshQuota(id);
          } catch (error) {
            quotaRefreshError = error instanceof Error ? error.message : String(error);
          }
          return { consumption, quotaRefreshError };
        });
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        if (!result.consumption.balance_refreshed || result.quotaRefreshError) {
          const detail = result.consumption.refresh_error || result.quotaRefreshError || 'Latest status is unavailable.';
          addToast(`${account.email} reset credit was consumed, but status refresh failed. Do not consume another credit; refresh later.`, 'warning');
          addLogEntry(`Consumed one reset credit for ${account.email}; status refresh pending: ${detail}`, 'warning');
        } else {
          addToast(`${account.email} reset credit consumed`, 'success');
          addLogEntry(`Consumed one reset credit for ${account.email}.`, 'success');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast(message, 'error');
        addLogEntry(message, 'error');
      }
      return;
    }
    setAccounts(prev => prev.map(acc => {
      if (acc.id === id) {
        addToast(`账号 ${acc.name} 配额统计已重置`, 'success');
        addLogEntry(`Manually reset statistics & status for endpoint: ${acc.email}`, 'info');
        return {
          ...acc,
          fiveHourQuotaRemaining: acc.fiveHourQuotaTotal,
          weeklyQuotaRemaining: acc.weeklyQuotaTotal,
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
      addToast(result?.skipped ? `${account?.email || id} Token is still valid` : `${account?.email || id} Token refreshed`, 'success');
      addLogEntry(`Token check completed: ${account?.email || id}`, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addToast(message, 'error');
      addLogEntry(message, 'error');
    }
  };

  const handleRefreshSubscription = async (id: string) => {
    if (!desktopBridgeAvailable) return;
    const account = accountsRef.current.find(item => item.id === id);
    try {
      const result = await runAccountOperation(id, () => desktopApi.refreshSubscription(id, true));
      const snapshot = await loadDashboardState(false);
      if (snapshot) queueQuotaAutoSync(snapshot.accounts);
      addToast(
        result?.changed
          ? `${account?.email || id} subscription updated`
          : `${account?.email || id} subscription already current`,
        'success',
      );
      addLogEntry(`Subscription refreshed: ${account?.email || id}`, 'success');
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
        addToast(`Daemon ${nextAction === 'stop' ? 'stopped' : 'started'}`, nextAction === 'stop' ? 'warning' : 'success');
        addLogEntry(`Daemon ${nextAction === 'stop' ? 'stopped' : 'started'}.`, nextAction === 'stop' ? 'warning' : 'success');
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
    addLogEntry(`Daemon sync interval adjusted to ${syncInterval} minutes.`, 'info');
  };

  // Add new account
  const handleAddAccount = async (acc: Omit<AccountQuota, 'id'>) => {
    if (desktopBridgeAvailable) {
      addToast('Opening OAuth login...', 'info');
      addLogEntry('Opening OAuth login flow for a new account.', 'info');
      try {
        const result = await desktopApi.addAccount();
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        addToast(result.account?.email ? `Added ${result.account.email}` : 'Account added', 'success');
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
      addToast(`The browser used a different account. ${result.account?.email || 'It'} was saved separately.`, 'warning');
      addLogEntry(`Reauthorization identity did not match ${target?.email || id}; the new account was saved separately.`, 'warning');
      return;
    }
    addToast(`${target?.email || id} reauthorized`, 'success');
    addLogEntry(`Account reauthorized: ${target?.email || id}`, 'success');
  };

  const handleCancelOAuth = async () => {
    await desktopApi.cancelOAuth();
    setOAuthStatus(await desktopApi.getOAuthStatus());
    addLogEntry('OAuth authorization cancelled.', 'warning');
  };

  const handleCompleteOAuthManually = async (callbackUrl: string) => {
    const result = await desktopApi.completeOAuthManually(callbackUrl);
    const snapshot = await loadDashboardState(false);
    if (snapshot) queueQuotaAutoSync(snapshot.accounts);
    if (result.mismatch) {
      addToast(`The browser used a different account. ${result.account?.email || 'It'} was saved separately.`, 'warning');
      addLogEntry('Manual OAuth callback completed with a different account saved separately.', 'warning');
      return;
    }
    addToast(result.account?.email ? `Added ${result.account.email}` : 'OAuth account added', 'success');
    addLogEntry('Manual OAuth callback completed.', 'success');
  };

  const handleResolveAuthConflict = async (action: 'adopt' | 'reapply') => {
    setIsResolvingAuth(true);
    try {
      if (action === 'adopt') {
        const account = await desktopApi.adoptOfficialAccount();
        addToast(`Official Codex account adopted: ${account.email}`, 'success');
      } else {
        await desktopApi.reapplyManagedAccount(authState.currentAccountId || null);
        addToast('Managed account reapplied to official Codex.', 'success');
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

  // Delete account
  const handleDeleteAccount = async (id: string) => {
    const target = accounts.find(a => a.id === id);
    if (desktopBridgeAvailable) {
      if (!target) return;
      const confirmed = window.confirm(`Delete ${target.email}? This cannot be undone.`);
      if (!confirmed) return;
      try {
        await runAccountOperation(id, () => desktopApi.deleteAccount(id));
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        addToast(`Deleted ${target.email}`, 'warning');
        addLogEntry(`Deleted account ${target.email} from manager configuration.`, 'warning');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast(message, 'error');
        addLogEntry(message, 'error');
      }
      return;
    }
    if (target) {
      setAccounts(prev => prev.filter(acc => acc.id !== id));
      addToast(`已成功移除账号 ${target.email}`, 'warning');
    }
  };

  // Switch Current Active Account
  const handleSwitchCurrentAccount = async (id: string) => {
    if (desktopBridgeAvailable) {
      const selected = accountsRef.current.find(a => a.id === id);
      try {
        await runAccountOperation(id, () => desktopApi.switchAccount(id));
        const snapshot = await loadDashboardState(false);
        if (snapshot) queueQuotaAutoSync(snapshot.accounts);
        addToast(`Current account switched to ${selected?.email || id}`, 'success');
        addLogEntry(`Switched active context to account: ${selected?.email || id}`, 'success');
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
            addLogEntry(`${selected?.email || id} ${nextSelected.includes(id) ? 'added to' : 'removed from'} auto-switch scope.`, 'info');
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
        ? `, ${needsReauthorization.length} require reauthorization`
        : '';
      const message = `Token check completed: ${passed}/${total} passed${reauthorizationText}, ${failed.length} failed.`;
      addToast(message, 'warning');
      throw new Error(message);
    }
    if (needsReauthorization.length > 0) {
      const message = `Token check completed: ${passed}/${total} passed, ${needsReauthorization.length} require reauthorization.`;
      addToast(message, 'warning');
      addLogEntry(message, 'warning');
      return;
    }
    const message = total > 0 ? `${total} account tokens checked` : 'No account tokens to check';
    addToast(message, total > 0 ? 'success' : 'info');
    addLogEntry(message, total > 0 ? 'success' : 'info');
  };

  const handleDetectClient = async () => {
    if (!desktopBridgeAvailable) return;
    const status = await desktopApi.getCodexStatus();
    setCodexStatus(status);
    setSettings(prev => ({ ...prev, clientDetected: !!status?.installed }));
    addToast(status?.installed ? 'Codex client detected' : 'Codex client not detected', status?.installed ? 'success' : 'warning');
  };

  const handleCheckUpdates = async () => {
    if (!desktopBridgeAvailable) return;
    if (!appInfo?.updateEnabled) {
      await handleOpenExternal(`${appInfo?.repository || 'https://github.com/3xiaoshayu/codex-account-manager'}/releases`);
      addToast('Opened GitHub Releases', 'info');
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
      addToast('Installing update and restarting...', 'info');
      addLogEntry('Update installation requested.', 'info');
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
      addToast(`Switched to ${result.to?.email || 'new account'}`, 'success');
    } else {
      addToast(result?.reason || 'No switch required', 'info');
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

  // Shift Background Image to match the screenshots exactly
  const getBackgroundImage = () => {
    if (activeTab === 'accounts') {
      // Pink cherry blossoms (sakura) framing Mt Fuji
      return `linear-gradient(to bottom, rgba(15, 23, 42, 0.45), rgba(15, 23, 42, 0.7)), url('${japanBackground}')`;
    }
    if (activeTab === 'settings') {
      return `linear-gradient(to bottom, rgba(15, 23, 42, 0.45), rgba(15, 23, 42, 0.7)), url('${japanBackground}')`;
    }
    // 'quotas' or 'autoswitch' view: Foggy dawn Mount Fuji
    return `linear-gradient(to bottom, rgba(15, 23, 42, 0.45), rgba(15, 23, 42, 0.75)), url('${settingsBackground}')`;
  };

  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} userEmail={userEmail} appVersion={settings.version} showDemoShortcuts={!desktopBridgeAvailable} />;
  }

  return (
    <div 
      className="h-screen w-screen flex overflow-hidden relative bg-cover bg-center transition-all duration-1000 select-none text-slate-100 font-sans"
      style={{ backgroundImage: getBackgroundImage() }}
      id="dashboard-main-container"
    >
      {/* Absolute overlay elements */}
      {/* Toast notification Tray */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none" id="toast-tray">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 50, scale: 0.9 }}
              className="pointer-events-auto backdrop-blur-xl bg-slate-950/80 border border-white/10 rounded-2xl p-4 flex items-center gap-3 shadow-2xl"
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
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          currentUserEmail={userEmail}
          onLogout={handleLogout}
          onRefreshAll={handleRefreshAll}
          isRefreshing={isRefreshingAll}
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
                  <div className="flex w-full max-w-sm flex-col items-center rounded-3xl border border-white/10 bg-slate-950/45 px-8 py-10 text-center shadow-2xl backdrop-blur-xl">
                    <LoaderCircle className="mb-4 h-8 w-8 animate-spin text-blue-400" />
                    <h2 className="text-base font-bold text-white">Loading account data</h2>
                    <p className="mt-2 text-xs leading-5 text-slate-400">
                      Reading local accounts, quota status, and daemon settings.
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
                    <h2 className="text-base font-bold text-white">Account data could not be loaded</h2>
                    <p className="mt-2 max-w-sm text-xs leading-5 text-slate-400">
                      {dashboardLoadError || 'The local account store did not respond.'}
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
                      Retry
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
                  onResetAccount={handleResetAccount}
                  onRefreshToken={desktopBridgeAvailable ? handleRefreshToken : undefined}
                  onRefreshSubscription={desktopBridgeAvailable ? handleRefreshSubscription : undefined}
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
                  onReloadAccounts={desktopBridgeAvailable ? async () => {
                    const snapshot = await loadDashboardState(true);
                    if (snapshot) queueQuotaAutoSync(snapshot.accounts);
                  } : undefined}
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
            <span>•</span>
            <span className={`${daemonState.status === 'Running' ? 'text-emerald-400' : 'text-rose-400'} font-semibold uppercase tracking-wider flex items-center gap-1`}>
              <span className={`w-1.5 h-1.5 rounded-full ${daemonState.status === 'Running' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
              System Status: Daemon {daemonState.status}
            </span>
          </div>
          <div className="flex items-center gap-4" id="footer-right">
            <button 
              onClick={() => {
                void handleOpenExternal(`${appInfo?.repository || 'https://github.com/3xiaoshayu/codex-account-manager'}/blob/main/docs/privacy.md`);
              }}
              className="hover:text-slate-200 cursor-pointer"
            >
              Privacy Policy
            </button>
            <button 
              onClick={() => setShowUpdates(true)} 
              className="hover:text-slate-200 cursor-pointer"
            >
              Release Notes
            </button>
          </div>
        </footer>
      </div>

      {authState.requiresResolution && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-md">
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-md rounded-3xl border border-amber-500/20 bg-slate-900/95 p-7 text-left shadow-2xl"
            id="auth-conflict-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="auth-conflict-title"
          >
            <ShieldAlert className="mb-4 h-10 w-10 text-amber-400" />
            <h3 id="auth-conflict-title" className="text-lg font-bold text-white">
              {authState.status === 'unknown' ? 'Authentication status unavailable' : 'Official Codex login changed'}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-300">
              {authState.message || 'The official Codex login no longer matches the account managed by this app.'}
            </p>
            {authState.officialIdentity?.email && (
              <div className="mt-4 rounded-2xl border border-white/5 bg-slate-950/35 px-4 py-3 text-xs text-slate-300">
                Official account: <strong className="text-white">{authState.officialIdentity.email}</strong>
              </div>
            )}
            <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
              Automatic switching and authentication writes are paused until this is resolved.
            </p>
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {authState.status === 'unknown' && (
                <button
                  onClick={() => void loadDashboardState(false)}
                  disabled={isResolvingAuth}
                  className="rounded-2xl border border-blue-500/25 bg-blue-500/10 px-4 py-3 text-xs font-bold text-blue-300 hover:bg-blue-500/15 disabled:opacity-50"
                  id="auth-conflict-reload"
                >
                  Reload status
                </button>
              )}
              {(authState.status === 'conflict' || authState.status === 'unmanaged_official_auth') && (
                <button
                  onClick={() => void handleResolveAuthConflict('adopt')}
                  disabled={isResolvingAuth}
                  className="rounded-2xl border border-blue-500/25 bg-blue-500/10 px-4 py-3 text-xs font-bold text-blue-300 hover:bg-blue-500/15 disabled:opacity-50"
                  id="auth-conflict-adopt"
                >
                  Adopt official account
                </button>
              )}
              {authState.currentAccountId && (
                <button
                  onClick={() => void handleResolveAuthConflict('reapply')}
                  disabled={isResolvingAuth}
                  className="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs font-bold text-amber-300 hover:bg-amber-500/15 disabled:opacity-50"
                  id="auth-conflict-reapply"
                >
                  Reapply managed account
                </button>
              )}
            </div>
          </motion.div>
        </div>
      )}

      {/* Overlay Notification Center Sidebar panel */}
      {showNotifications && (
          <>
            <div 
              className="fixed inset-0 bg-black/40 z-35" 
              onClick={() => setShowNotifications(false)} 
            />
            <motion.div
              className="fixed right-0 top-0 bottom-0 w-80 backdrop-blur-2xl bg-slate-900/95 border-l border-white/10 p-6 z-40 shadow-2xl flex flex-col text-slate-200 text-left"
              id="notification-sidebar-center"
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
                    <div className="p-3 bg-white/5 border border-white/5 rounded-xl text-xs space-y-1" key={log.id}>
                      <div className="flex items-center justify-between">
                        <span className={`font-bold capitalize text-[10px] ${color}`}>{log.type}</span>
                        <span className="text-[9px] text-slate-500 font-mono">{log.timestamp}</span>
                      </div>
                      <p className="text-slate-300 leading-relaxed text-[11px] font-sans font-medium">{log.message}</p>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </>
      )}

      {/* Support Dialog modal */}
      {showSupport && (
          <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="backdrop-blur-2xl bg-slate-900/90 border border-white/10 rounded-3xl p-8 w-full max-w-md shadow-2xl relative text-white text-left select-none"
              id="support-modal-popup"
            >
              <button
                onClick={() => setShowSupport(false)}
                className="absolute top-5 right-5 p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <HelpCircle className="w-12 h-12 text-blue-400 mb-4 animate-pulse" />
              <h3 className="text-lg font-bold tracking-tight mb-2 font-sans">客户服务 / Technical Support</h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-6 font-sans">
                如果您在使用 Codex 账号管理器时遇到配额验证、客户端连接或服务问题，请通过 GitHub Issues 提交可复现信息。
              </p>

              <div className="space-y-3 mb-6" id="support-channels-list">
                <div className="p-3 bg-white/5 border border-white/5 rounded-2xl flex items-center justify-between text-xs font-semibold">
                  <span className="text-slate-400">GitHub Issues</span>
                  <a className="text-blue-400" href={`${appInfo?.repository || 'https://github.com/3xiaoshayu/codex-account-manager'}/issues`} target="_blank" rel="noopener noreferrer">Open issue tracker</a>
                </div>
                <div className="p-3 bg-white/5 border border-white/5 rounded-2xl flex items-center justify-between text-xs font-semibold">
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
          </div>
      )}

      {/* Release Notes / Updates dialog modal */}
      {showUpdates && (
          <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="backdrop-blur-2xl bg-slate-900/90 border border-white/10 rounded-3xl p-8 w-full max-w-md shadow-2xl relative text-white text-left select-none"
              id="updates-modal-popup"
            >
              <button
                onClick={() => setShowUpdates(false)}
                className="absolute top-5 right-5 p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <Activity className="w-12 h-12 text-cyan-400 mb-4 animate-bounce-slow" />
              <h3 className="text-lg font-bold tracking-tight mb-2 font-sans">版本更新详情 / Release Notes</h3>
              <p className="text-xs text-slate-400 mb-6 font-sans">
                当前版本 <strong>{settings.version.startsWith('v') ? settings.version : `v${settings.version}`}</strong>。
              </p>

              <div className="space-y-4 max-h-48 overflow-y-auto pr-2 mb-6 text-xs text-slate-300 leading-relaxed font-sans" id="changelog-list">
                <div>
                  <h4 className="font-bold text-white mb-1">可靠性修复 (Reliability)</h4>
                  <ul className="list-disc pl-4 space-y-1 text-slate-400 text-[11px]">
                    <li>检测官方 Codex 登录变化，并在写入凭证前要求明确处理冲突。</li>
                    <li>切号事务支持原子写入、启动验证和失败回滚。</li>
                    <li>损坏的账号索引与数据文件可从备份恢复。</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-bold text-white mb-1">状态与恢复 (Recovery)</h4>
                  <ul className="list-disc pl-4 space-y-1 text-slate-400 text-[11px]">
                    <li>缺失配额窗口保持未知，不再显示虚构的零值。</li>
                    <li>OAuth 会话可在重启后恢复，并支持取消和手动回调。</li>
                    <li>新增脱敏日志与结构化守护进程状态。</li>
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
          </div>
      )}
    </div>
  );
}

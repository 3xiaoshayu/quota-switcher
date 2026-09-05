import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  INITIAL_ACCOUNTS,
  INITIAL_LOGS, 
  INITIAL_SETTINGS 
} from './data/mockData';
import {
  AccountQuota,
  DesktopAuthState,
  ProductKind,
  SystemSettings,
} from './types';
import {
  countUnreadAlertLogs,
  desktopApi,
  hasDesktopBridge,
  needsHandling,
  resolveAuthStateAfterSnapshot,
} from './api/desktop';
import { logTypeLabel } from './api/user-messages';
import { formatDriftFrom } from './app/dashboard-settings';
import { useNotifications } from './app/useNotifications';
import { useSharedRefs } from './app/useSharedRefs';
import { useDashboardLoader } from './app/useDashboardLoader';
import { useOAuthFlow } from './app/useOAuthFlow';
import { useDesktopEvents } from './app/useDesktopEvents';
import { useAccountActions } from './app/useAccountActions';
import { setAccountsForProduct } from './app/store-helpers';
import { APP_GITHUB_URL } from './brand';
import {
  accountsFromSnapshot,
  officialClientLabel,
} from './api/product-adapter';
import { productById, readStoredProduct } from './data/products';
import {
  setAuthState,
  useDesktopStore,
} from './state/desktop-store';
import Sidebar, { type SidebarTab } from './components/Sidebar';
import Header from './components/Header';
import QuotasView from './components/QuotasView';
import AccountsView from './components/AccountsView';
import SettingsView from './components/SettingsView';
import AuthStatusBanner from './components/AuthStatusBanner';
import FormatDriftBanner from './components/FormatDriftBanner';
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

function DashboardApp() {
  // Main UI States
  const [activeTab, setActiveTab] = useState<SidebarTab>(() => {
    if (desktopBridgeAvailable) return 'quotas';
    return INITIAL_ACCOUNTS.some(needsHandling) ? 'accounts' : 'quotas';
  });
  const [accountsFilterTab, setAccountsFilterTab] = useState<'all' | 'current' | 'warning'>('all');
  const [product, setProduct] = useState<ProductKind>(() => readStoredProduct());
  const {
    codexAccounts,
    cursorAccounts,
    antigravityAccounts,
    daemonState,
    daemonConfig,
    appInfo,
    codexStatus,
    cursorStatus,
    antigravityStatus,
    updateStatus,
    authState,
    oauthStatus,
    cursorOAuthStatus,
    antigravityOAuthStatus,
  } = useDesktopStore();
  const accounts = accountsFromSnapshot(product, { accounts: codexAccounts, cursorAccounts, antigravityAccounts });
  const [settings, setSettings] = useState<SystemSettings>(INITIAL_SETTINGS);
  const refs = useSharedRefs({
    product,
    accounts,
    codexAccounts,
    cursorAccounts,
    antigravityAccounts,
    oauthStatus,
    cursorOAuthStatus,
    antigravityOAuthStatus,
    daemonConfig,
    authState,
  });
  const productRef = refs.product;
  const authStateRef = refs.authState;

  // Every auth-state write goes through the same busy-placeholder filter as a
  // snapshot, so a lock-busy "unknown" from a daemon tick or an OAuth result
  // cannot wipe a real conflict banner or lift the auto-sync gate.
  const applyAuthState = useCallback((incoming: DesktopAuthState | null | undefined) => {
    const next = resolveAuthStateAfterSnapshot(incoming, authStateRef.current);
    setAuthState(next);
    authStateRef.current = next;
  }, [authStateRef]);

  const [authBannerDismissedKey, setAuthBannerDismissedKey] = useState<string | null>(null);
  const [formatDriftDismissedKey, setFormatDriftDismissedKey] = useState<string | null>(null);
  const [showSupport, setShowSupport] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);

  const {
    toasts,
    addToast,
    dismissToast,
    logs,
    addLogEntry,
    showNotifications,
    setShowNotifications,
    lastReadLogId,
  } = useNotifications({
    productRef,
    initialLogs: desktopBridgeAvailable ? [] : INITIAL_LOGS,
  });

  const persistProduct = useCallback((next: ProductKind) => {
    setProduct(next);
    localStorage.setItem('cam_product', next);
    if (hasDesktopBridge()) {
      void desktopApi.setFloatProduct(next).catch(() => {});
    }
  }, []);

  const setVisibleAccounts = useCallback((updater: SetStateAction<AccountQuota[]>) => {
    setAccountsForProduct(productRef.current, updater);
  }, [productRef]);

  const {
    dashboardLoadState,
    dashboardLoadError,
    loadDashboardState,
    invalidatePendingLoads,
    queueQuotaAutoSync,
  } = useDashboardLoader({
    refs,
    applyAuthState,
    persistProduct,
    setActiveTab,
    setSettings,
    addToast,
    addLogEntry,
  });

  useDesktopEvents({
    refs,
    loadDashboardState,
    queueQuotaAutoSync,
    applyAuthState,
    addToast,
    addLogEntry,
    setSettings,
  });

  const oauth = useOAuthFlow({
    refs,
    pending: {
      codex: !!oauthStatus?.pending,
      cursor: !!cursorOAuthStatus?.pending,
      antigravity: !!antigravityOAuthStatus?.pending,
    },
    addToast,
    addLogEntry,
    applyAuthState,
    loadDashboardState,
    invalidatePendingLoads,
    queueQuotaAutoSync,
  });
  const { anyOAuthPending } = oauth;

  const {
    isRefreshingAll,
    isResolvingAuth,
    sessionSwitchCount,
    deleteTarget,
    setDeleteTarget,
    isDeletingAccount,
    switchTarget,
    setSwitchTarget,
    isConfirmingSwitch,
    handleRefreshAll,
    handleRefreshAccount,
    handleRefreshToken,
    handleToggleDaemon,
    handlePreviewSyncInterval,
    handleUpdateSyncInterval,
    handleResolveAuthConflict,
    handleDeleteAccount,
    confirmDeleteAccount,
    handleSwitchCurrentAccount,
    confirmSwitchAccount,
    handleBatchVerifyTokens,
    handleDetectClient,
    handleImportLocalAccount,
    handleCheckUpdates,
    handleInstallUpdate,
    handleOpenExternal,
    resetForProduct,
  } = useAccountActions({
    refs,
    accounts,
    daemonState,
    authState,
    appInfo,
    setVisibleAccounts,
    setSettings,
    addToast,
    addLogEntry,
    applyAuthState,
    loadDashboardState,
    queueQuotaAutoSync,
    anyOAuthPending,
  });

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

  const handleAddAccount = async (acc: Omit<AccountQuota, 'id'>) => {
    if (desktopBridgeAvailable) {
      await oauth.addAccount(productById(productRef.current).id);
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
    await oauth.reauthorize(productById(productRef.current).id, id);
  };

  const handleCancelOAuth = async () => {
    await oauth.cancelOAuth(productById(productRef.current).id);
  };

  const handleCompleteOAuthManually = async (callbackUrl: string) => {
    await oauth.completeCodexManually(callbackUrl);
  };

  const authBannerKey = `${authState.status}:${authState.currentAccountId || ''}:${authState.officialIdentity?.email || ''}`;
  const showAuthBanner = desktopBridgeAvailable && productById(product).features.officialAuthSync && authState.requiresResolution && authBannerDismissedKey !== authBannerKey;
  // An official client whose login format no longer matches; the same reason
  // text feeds the Settings detection card.
  const formatDrift = formatDriftFrom({ codex: codexStatus, cursor: cursorStatus, antigravity: antigravityStatus });
  const formatDriftKey = Object.entries(formatDrift).map(([kind, reason]) => `${kind}:${reason}`).join('|');
  const showFormatDriftBanner = formatDriftKey !== '' && formatDriftDismissedKey !== formatDriftKey;

  const handleProductChange = (next: ProductKind) => {
    persistProduct(next);
    setAccountsFilterTab('all');
    resetForProduct(next);
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

        {showFormatDriftBanner && (
          <div className="shrink-0 px-8 pt-6" id="format-drift-banner-wrap">
            <FormatDriftBanner
              drift={formatDrift}
              onOpenReleases={() => void handleOpenExternal(`${appInfo?.repository || APP_GITHUB_URL}/releases`)}
              onDismiss={() => setFormatDriftDismissedKey(formatDriftKey)}
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
                  authState={desktopBridgeAvailable && productById(product).features.officialAuthSync ? authState : null}
                  onOpenModal={() => setShowNotifications(false)}
                />
              )}

              {activeTab === 'settings' && (
                <SettingsView 
                  product={product}
                  settings={{ ...settings, formatDrift }}
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

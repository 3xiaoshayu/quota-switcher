import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  accountHasVisibleQuota,
  desktopApi,
  formatTokenCheckMessage,
  hasDesktopBridge,
  summarizeRefreshAllResults,
} from '../api/desktop';
import {
  accountsFromSnapshot,
  importAccountCopy,
  isManagedProduct,
  officialClientLabel,
  productActions,
  productLabel,
  syncFailedCopy,
} from '../api/product-adapter';
import { toAntigravityUserMessage, toCursorUserMessage, toUserMessage } from '../api/user-messages';
import { APP_GITHUB_URL } from '../brand';
import { productById } from '../data/products';
import {
  setAntigravityStatus,
  setCodexStatus,
  setCursorStatus,
  setDaemonConfig,
  setDaemonState,
} from '../state/desktop-store';
import type {
  AccountQuota,
  DaemonState,
  DesktopAppInfo,
  DesktopAuthState,
  DesktopDaemonConfig,
  ProductKind,
  SystemSettings,
} from '../types';
import { latestStatusForUi } from './dashboard-settings';
import { applyCurrentAccountBadge } from './store-helpers';
import type { LoadDashboardState } from './useDashboardLoader';
import type { SharedRefs } from './useSharedRefs';

type Notify = (message: string, type: 'success' | 'info' | 'warning' | 'error', source?: ProductKind | 'auto') => void;

interface UseAccountActionsOptions {
  refs: SharedRefs;
  accounts: AccountQuota[];
  daemonState: DaemonState;
  authState: DesktopAuthState;
  appInfo: DesktopAppInfo | null;
  setVisibleAccounts: (updater: SetStateAction<AccountQuota[]>) => void;
  setSettings: Dispatch<SetStateAction<SystemSettings>>;
  addToast: Notify;
  addLogEntry: Notify;
  applyAuthState: (incoming: DesktopAuthState | null | undefined) => void;
  loadDashboardState: LoadDashboardState;
  queueQuotaAutoSync: (accounts: AccountQuota[]) => void;
  anyOAuthPending: () => boolean;
}

const actions = productActions();
const OAUTH_BUSY_MESSAGE = '已有授权正在进行，请先完成或取消。';

// Everything the account cards and the settings page can ask the engine to
// do, plus the confirmation-dialog state those actions go through. Each
// action reloads the snapshot afterwards and only speaks for the product that
// was showing when it started.
export function useAccountActions({
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
}: UseAccountActionsOptions) {
  const desktopBridgeAvailable = hasDesktopBridge();
  const productRef = refs.product;
  const accountsRef = refs.accounts;
  const daemonConfigRef = refs.daemonConfig;

  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const refreshAllKindRef = useRef<ProductKind | null>(null);
  const [isResolvingAuth, setIsResolvingAuth] = useState(false);
  // Real switch counter for this session (manual switches increment it).
  const [sessionSwitchCount, setSessionSwitchCount] = useState(0);
  // In-app delete confirmation (replaces the native window.confirm).
  const [deleteTarget, setDeleteTarget] = useState<AccountQuota | null>(null);
  const [switchTarget, setSwitchTarget] = useState<AccountQuota | null>(null);
  const [isConfirmingSwitch, setIsConfirmingSwitch] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // One operation per account at a time; the background sync also stays away
  // from accounts listed here.
  const runAccountOperation = useCallback(async <T,>(id: string, task: () => Promise<T>): Promise<T> => {
    if (refs.operationIds.current.has(id)) {
      throw new Error('该账号已有操作正在进行，请稍候重试。');
    }
    refs.operationIds.current.add(id);
    try {
      return await task();
    } finally {
      refs.operationIds.current.delete(id);
    }
  }, [refs]);

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
        if (snapshot && currentProduct.features.officialAuthSync) queueQuotaAutoSync(snapshot.accounts);
        if (productRef.current !== kind) return;
        if (failed || bannedSkipped || networkFailed) {
          const parts = [`已刷新 ${refreshed} 个`];
          if (reauthSkipped) parts.push(`${reauthSkipped} 个需重新授权`);
          if (bannedSkipped && currentProduct.features.officialAuthSync) parts.push(`${bannedSkipped} 个已封号`);
          if (networkFailed) parts.push(`${networkFailed} 个额度暂时没刷到，登录还在`);
          if (failed) parts.push(isManagedProduct(kind) ? `${failed} 个这次没查清` : `${failed} 个同步失败`);
          addToast(parts.join('，'), 'warning', kind);
          const logParts = [];
          if (reauthSkipped) logParts.push(`需重新授权 ${reauthSkipped} 个`);
          if (bannedSkipped && currentProduct.features.officialAuthSync) logParts.push(`封号 ${bannedSkipped} 个`);
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
          const message = toUserMessage(error);
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
      const message = toUserMessage(error);
      addToast(message, 'error', kind);
      addLogEntry(message, 'error', kind);
    }
  };

  const handleToggleDaemon = async () => {
    if (desktopBridgeAvailable) {
      const nextAction = daemonState.status === 'Running' ? 'stop' : 'start';
      try {
        if (nextAction === 'stop') await desktopApi.stopDaemon();
        else await desktopApi.startDaemon();
        await loadDashboardState(false);
        addToast(`Daemon 已${nextAction === 'stop' ? '停止' : '启动'}`, nextAction === 'stop' ? 'warning' : 'success', 'codex');
        addLogEntry(`Daemon 已${nextAction === 'stop' ? '停止' : '启动'}。`, nextAction === 'stop' ? 'warning' : 'success', 'codex');
      } catch (error) {
        const message = toUserMessage(error);
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

  const saveDaemonConfig = async (nextConfig: DesktopDaemonConfig) => {
    daemonConfigRef.current = nextConfig;
    setDaemonConfig(nextConfig);
    const result = await refs.configSaves.current.enqueue(() => desktopApi.saveDaemonConfig(nextConfig));
    if (!result.ok) {
      const message = toUserMessage(result.error);
      addToast(message, 'error', 'codex');
      addLogEntry(message, 'error', 'codex');
    }
    // Only the newest save reloads; an older one finishing late must not put
    // its config back over a later click.
    if (result.latest) {
      await loadDashboardState(false);
    }
    return result.ok;
  };

  const handlePreviewSyncInterval = (val: number) => {
    const syncInterval = Math.min(60, Math.max(1, Math.round(Number(val) || 1)));
    setDaemonState(prev => ({
      ...prev,
      syncInterval,
    }));
  };

  const handleUpdateSyncInterval = (val: number) => {
    const syncInterval = Math.min(60, Math.max(1, Math.round(Number(val) || 1)));
    handlePreviewSyncInterval(syncInterval);
    if (desktopBridgeAvailable) {
      if (Number(daemonConfigRef.current.sync_interval_minutes) === syncInterval) return;
      const nextConfig = {
        ...daemonConfigRef.current,
        sync_interval_minutes: syncInterval,
      };
      void saveDaemonConfig(nextConfig);
      return;
    }
    addToast(`Daemon 检查间隔已调整为 ${val} 分钟`, 'info');
    addLogEntry(`Daemon 检查间隔已调整为 ${syncInterval} 分钟。`, 'info');
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
      const message = toUserMessage(error);
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
        const message = toUserMessage(error);
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
        addToast(OAUTH_BUSY_MESSAGE, 'warning', kind);
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
        const message = toUserMessage(error);
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

  // Cursor and Antigravity switches close the official app first, so they go
  // through a confirmation; Codex switches run directly.
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

  const handleBatchVerifyTokens = async () => {
    if (!desktopBridgeAvailable) return;
    let cursorError: string | null = null;
    let antigravityError: string | null = null;
    const [codex, cursor, antigravity] = await Promise.all([
      desktopApi.refreshAllTokens(false),
      desktopApi.refreshAllCursorTokens(false).catch((error) => {
        cursorError = toCursorUserMessage(error);
        return { results: [] };
      }),
      desktopApi.refreshAllAntigravityTokens(false).catch((error) => {
        antigravityError = toAntigravityUserMessage(error);
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
      addToast(OAUTH_BUSY_MESSAGE, 'warning', kind);
      throw new Error(OAUTH_BUSY_MESSAGE);
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

  // Switching the product in the sidebar drops any confirmation that belonged
  // to the previous one; "refreshing all" only shows if it was for this product.
  const resetForProduct = (next: ProductKind) => {
    setSwitchTarget(null);
    setIsConfirmingSwitch(false);
    setDeleteTarget(null);
    setIsRefreshingAll(refreshAllKindRef.current === next);
  };

  return {
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
  };
}

import { useCallback, useEffect, useRef } from 'react';
import { desktopApi, hasDesktopBridge } from '../api/desktop';
import { isManagedProduct, productActions } from '../api/product-adapter';
import { toUserMessage } from '../api/user-messages';
import { productById } from '../data/products';
import {
  setAntigravityOAuthStatus,
  setCursorOAuthStatus,
  setOAuthStatus,
} from '../state/desktop-store';
import type { AccountQuota, DesktopAuthState, DesktopOAuthStatus, ProductKind } from '../types';
import {
  anyOAuthPending as anyPending,
  oauthReportKey,
  oauthStatusEndedThisFlow,
  pendingOAuthStatus,
  planOAuthFinish,
} from './oauth-flow';
import { applyCurrentAccountBadge } from './store-helpers';
import type { LoadDashboardState } from './useDashboardLoader';
import type { SharedRefs } from './useSharedRefs';

type Notify = (message: string, type: 'success' | 'info' | 'warning' | 'error', source: ProductKind | 'auto') => void;

interface UseOAuthFlowOptions {
  refs: SharedRefs;
  pending: { codex: boolean; cursor: boolean; antigravity: boolean };
  addToast: Notify;
  addLogEntry: Notify;
  applyAuthState: (incoming: DesktopAuthState | null | undefined) => void;
  loadDashboardState: LoadDashboardState;
  invalidatePendingLoads: () => void;
  queueQuotaAutoSync: (accounts: AccountQuota[]) => void;
}

const actions = productActions();
const OAUTH_POLL_MS = 1000;
const OAUTH_BUSY_MESSAGE = '已有授权正在进行，请先完成或取消。';

function setOAuthStatusFor(kind: ProductKind, status: DesktopOAuthStatus) {
  if (kind === 'antigravity') setAntigravityOAuthStatus(status);
  else if (kind === 'cursor') setCursorOAuthStatus(status);
  else setOAuthStatus(status);
}

// Browser authorizations: starting one, following it while the browser is
// open, and announcing the outcome exactly once.
export function useOAuthFlow({
  refs,
  pending,
  addToast,
  addLogEntry,
  applyAuthState,
  loadDashboardState,
  invalidatePendingLoads,
  queueQuotaAutoSync,
}: UseOAuthFlowOptions) {
  const bridgeAvailable = hasDesktopBridge();
  const reportKey = useRef<string | null>(null);

  const oauthStatusFor = useCallback((kind: ProductKind) => {
    if (kind === 'antigravity') return refs.antigravityOAuthStatus.current;
    if (kind === 'cursor') return refs.cursorOAuthStatus.current;
    return refs.oauthStatus.current;
  }, [refs]);

  const anyOAuthPending = useCallback(
    () => anyPending([oauthStatusFor('codex'), oauthStatusFor('cursor'), oauthStatusFor('antigravity')]),
    [oauthStatusFor],
  );

  const reportOAuthFinished = useCallback((status: DesktopOAuthStatus, source: ProductKind | 'auto' = 'auto') => {
    const kind = source === 'auto' ? refs.product.current : source;
    const plan = planOAuthFinish(kind, status);
    if (!plan) return;
    const key = oauthReportKey(kind, status);
    if (reportKey.current === key) return;
    reportKey.current = key;

    if (plan.authState) applyAuthState(plan.authState);
    if (plan.badgeAccountId) applyCurrentAccountBadge('codex', plan.badgeAccountId);
    for (const notice of plan.notices) {
      addToast(notice.message, notice.level, kind);
      addLogEntry(notice.message, notice.level, kind);
    }
    if (plan.refreshAntigravityAccountId) {
      void actions.refreshQuota('antigravity', plan.refreshAntigravityAccountId)
        .catch(() => {})
        .then(() => loadDashboardState(false));
    }
  }, [addLogEntry, addToast, applyAuthState, loadDashboardState, refs]);

  // Shows "pending" immediately and drops loads already in flight so a
  // pre-click snapshot cannot put "idle" back over it.
  const markOAuthPending = useCallback((targetAccountId: string | null) => {
    invalidatePendingLoads();
    reportKey.current = null;
    const nextStatus = pendingOAuthStatus(targetAccountId);
    const kind = productById(refs.product.current).id;
    if (kind === 'antigravity') refs.antigravityOAuthStatus.current = nextStatus;
    else if (kind === 'cursor') refs.cursorOAuthStatus.current = nextStatus;
    else refs.oauthStatus.current = nextStatus;
    setOAuthStatusFor(kind, nextStatus);
  }, [invalidatePendingLoads, refs]);

  // While the browser is open, poll the engine once a second; the first
  // non-pending status ends the flow.
  const usePolling = (kind: ProductKind, isPending: boolean) => {
    useEffect(() => {
      if (!bridgeAvailable || !isPending) return;
      let disposed = false;
      let failCount = 0;
      const poll = async () => {
        try {
          const status = await actions.oauthStatus(kind);
          failCount = 0;
          if (disposed) return;
          setOAuthStatusFor(kind, status);
          if (status.pending) return;
          await loadDashboardState(false);
          reportOAuthFinished(status, kind);
        } catch {
          failCount += 1;
          if (!disposed && (failCount === 5 || failCount % 15 === 0)) {
            addToast('授权状态读取失败，可点取消后重试。', 'error', kind);
          }
        }
      };
      void poll();
      const timer = window.setInterval(() => { void poll(); }, OAUTH_POLL_MS);
      return () => {
        disposed = true;
        window.clearInterval(timer);
      };
    }, [addToast, bridgeAvailable, isPending, kind, loadDashboardState, reportOAuthFinished]);
  };
  usePolling('codex', pending.codex);
  usePolling('cursor', pending.cursor);
  usePolling('antigravity', pending.antigravity);

  const guardNoOtherFlow = (kind: ProductKind) => {
    if (!anyOAuthPending()) return;
    addToast(OAUTH_BUSY_MESSAGE, 'warning', kind);
    throw new Error(OAUTH_BUSY_MESSAGE);
  };

  // A rejected add/reauth still ends with a status read: the browser may have
  // completed or cancelled meanwhile, and that outcome beats the raw error.
  const settleAfterFailure = async (
    kind: ProductKind,
    error: unknown,
    finalStatus: (snapshot: Awaited<ReturnType<LoadDashboardState>>) => Promise<DesktopOAuthStatus | null | undefined>,
  ) => {
    const snapshot = await loadDashboardState(false);
    if (snapshot && !isManagedProduct(kind)) queueQuotaAutoSync(snapshot.accounts);
    if (refs.product.current !== kind) throw error;
    const finished = await finalStatus(snapshot);
    if (oauthStatusEndedThisFlow(finished)) {
      reportOAuthFinished(finished as DesktopOAuthStatus, kind);
    } else {
      const message = toUserMessage(error);
      addToast(message, 'error', kind);
      addLogEntry(message, 'error', kind);
    }
    throw error;
  };

  const addAccount = async (kind: ProductKind) => {
    guardNoOtherFlow(kind);
    markOAuthPending(null);
    addToast('正在打开授权页面，请在浏览器里完成登录。', 'info', kind);
    addLogEntry('正在为新账号打开授权。', 'info', kind);
    try {
      const added = await actions.addAccount(kind) as { authState?: DesktopAuthState };
      if (kind === 'codex' && added?.authState) applyAuthState(added.authState);
      const snapshot = await loadDashboardState(false);
      if (snapshot && !isManagedProduct(kind)) queueQuotaAutoSync(snapshot.accounts);
      if (refs.product.current !== kind) return;
      reportOAuthFinished(await actions.oauthStatus(kind), kind);
    } catch (error) {
      await settleAfterFailure(kind, error, (snapshot) =>
        actions.oauthStatus(kind).catch(() => snapshot?.oauthStatus || null));
    }
  };

  const reauthorize = async (kind: ProductKind, id: string) => {
    guardNoOtherFlow(kind);
    markOAuthPending(id);
    addToast('正在打开授权页面，请在浏览器里完成登录。', 'info', kind);
    addLogEntry('正在打开重新授权。', 'info', kind);
    try {
      const result = await actions.reauthorize(kind, id) as {
        account?: { id?: string; email?: string };
        mismatch?: boolean;
        targetAccountId?: string | null;
        authState?: DesktopAuthState;
      };
      if (kind === 'codex' && result?.authState) applyAuthState(result.authState);
      const snapshot = await loadDashboardState(false);
      if (snapshot && !isManagedProduct(kind)) queueQuotaAutoSync(snapshot.accounts);
      if (refs.product.current !== kind) return;
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
      await settleAfterFailure(kind, error, async (snapshot) => (
        isManagedProduct(kind)
          ? actions.oauthStatus(kind).catch(() => null)
          : snapshot?.oauthStatus
      ));
    }
  };

  const cancelOAuth = async (kind: ProductKind) => {
    await actions.cancelOAuth(kind);
    const status = await actions.oauthStatus(kind);
    setOAuthStatusFor(kind, status);
    reportOAuthFinished(status, kind);
  };

  const completeCodexManually = async (callbackUrl: string) => {
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

  return {
    reportOAuthFinished,
    anyOAuthPending,
    markOAuthPending,
    addAccount,
    reauthorize,
    cancelOAuth,
    completeCodexManually,
  };
}

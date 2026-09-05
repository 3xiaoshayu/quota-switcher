import { oauthFinishedCopy } from '../api/product-adapter';
import { toUserMessage } from '../api/user-messages';
import type { DesktopAuthState, DesktopOAuthStatus, ProductKind } from '../types';

// One browser authorization at a time across all three products: the engine
// enforces it, so the window has to look at all three before starting one.
export function anyOAuthPending(statuses: Array<DesktopOAuthStatus | null | undefined>): boolean {
  return statuses.some((status) => !!status?.pending);
}

// After an add/reauth call rejected, a settled "completed" status can only
// belong to an earlier flow; re-reporting it would toast a stale account.
export function oauthStatusEndedThisFlow(status: DesktopOAuthStatus | null | undefined): boolean {
  return !!status
    && !status.pending
    && status.status !== 'completed'
    && status.status !== 'idle'
    && status.status !== 'pending';
}

// Identifies one finished authorization so polling and the add/reauth caller
// cannot both announce it.
export function oauthReportKey(kind: ProductKind, status: DesktopOAuthStatus): string {
  const result = status.result;
  return [
    kind,
    status.status,
    result?.accountId || '',
    result?.email || '',
    result?.mismatch ? '1' : '0',
    result?.updated ? '1' : '0',
    status.targetAccountId || '',
    status.message || '',
  ].join('|');
}

export interface OAuthFinishNotice {
  level: 'success' | 'warning';
  message: string;
}

export interface OAuthFinishPlan {
  notices: OAuthFinishNotice[];
  authState: DesktopAuthState | null;
  // Codex account to mark current right away (the switch already happened).
  badgeAccountId: string | null;
  // Antigravity account whose quota should be fetched now that it signed in.
  refreshAntigravityAccountId: string | null;
}

// Decides what a finished authorization means for the user. Pure, so the
// cancelled / failed / mismatch / reauth / switch-error branches are testable.
export function planOAuthFinish(kind: ProductKind, status: DesktopOAuthStatus): OAuthFinishPlan | null {
  if (status.pending) return null;
  if (status.status === 'idle' || status.status === 'pending') return null;
  const plan: OAuthFinishPlan = {
    notices: [],
    authState: null,
    badgeAccountId: null,
    refreshAntigravityAccountId: null,
  };
  if (status.status === 'cancelled') {
    plan.notices.push({ level: 'warning', message: '授权已取消。' });
    return plan;
  }
  if (status.status === 'error' || status.status === 'expired') {
    const raw = status.code
      ? { code: status.code, message: status.message || '' }
      : (status.message || '授权未完成。');
    plan.notices.push({ level: 'warning', message: toUserMessage(raw) });
    return plan;
  }
  if (status.status !== 'completed') return null;

  const result = status.result;
  plan.authState = result?.authState ?? null;
  if (result?.mismatch) {
    if (kind === 'codex' && result.accountId && result.switched !== false) {
      plan.badgeAccountId = result.accountId;
    }
    plan.notices.push({
      level: 'warning',
      message: oauthFinishedCopy({ product: kind, email: result.email, mismatch: true }),
    });
    return plan;
  }
  const isReauth = !!(status.targetAccountId || result?.targetAccountId);
  if (kind === 'codex' && result?.accountId && !isReauth) {
    plan.badgeAccountId = result.accountId;
  }
  plan.notices.push({
    level: 'success',
    message: oauthFinishedCopy({
      product: kind,
      email: result?.email,
      isReauth,
      updated: !!result?.updated,
      switched: !!result?.switched,
    }),
  });
  if (result?.switchError) {
    const raw = result.switchErrorCode
      ? { code: result.switchErrorCode, message: result.switchError }
      : result.switchError;
    plan.notices.push({ level: 'warning', message: toUserMessage(raw) });
  }
  if (kind === 'antigravity' && result?.accountId) {
    plan.refreshAntigravityAccountId = result.accountId;
  }
  return plan;
}

export function pendingOAuthStatus(targetAccountId: string | null): DesktopOAuthStatus {
  return {
    status: 'pending',
    pending: true,
    targetAccountId,
    message: '请在浏览器完成授权，完成后会自动回来。',
    result: null,
    expiresAt: null,
    callbackPort: 1455,
  };
}

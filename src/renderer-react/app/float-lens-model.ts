import {
  antigravityQuotaFamilies,
  formatResetLine,
  hideStaleQuota,
  isManagedProductAccount,
  lensQuotaWindows,
  planCaption,
  quotaHero,
  statusTextForAccount,
  STATUS_TEXT,
} from '../api/desktop';
import { isManagedProduct, toProductUserMessage } from '../api/product-adapter';
import type { AccountQuota, ProductKind } from '../types';

// Everything the float lens decides about what to draw, kept out of the
// component so the decisions can be tested without a DOM.

export function pickViewedId(accounts: AccountQuota[], current: string | null | undefined): string | null {
  if (current && accounts.some((account) => account.id === current)) return current;
  const live = accounts.find((account) => account.isCurrent);
  return live?.id || accounts[0]?.id || null;
}

// The smaller of two remaining windows drives the hero number; a missing
// window never counts as zero.
export function tighterRemaining(weekly: number | null | undefined, fiveHour: number | null | undefined): number | null {
  const week = weekly ?? null;
  const hourly = fiveHour ?? null;
  if (week == null && hourly == null) return null;
  if (week == null) return hourly;
  if (hourly == null) return week;
  return Math.min(week, hourly);
}

export function ringLength(radius: number): number {
  return 2 * Math.PI * radius;
}

// Stroke offset for an SVG ring: an unknown percentage draws an empty ring.
export function arcOffset(radius: number, percent: number | null): number {
  const length = ringLength(radius);
  if (percent == null || !Number.isFinite(percent)) return length;
  return length * (1 - Math.max(0, Math.min(100, percent)) / 100);
}

export function blockedRefreshText(account: AccountQuota): string {
  return account.status === 'BANNED' && !isManagedProductAccount(account)
    ? '账号已封号，无法刷新额度'
    : '该账号需要重新授权后才能刷新额度';
}

export function blockedSwitchText(account: AccountQuota): string {
  if (account.status === 'BANNED' && !isManagedProductAccount(account)) return '账号已封号，无法切换';
  if (account.tokenAccessAvailable === false) return '该账号没有可用登录令牌，无法切换';
  return '该账号需要重新授权后才能切换';
}

export function statusBadgeText(account: AccountQuota): string | null {
  if (account.status === 'BANNED' && !isManagedProductAccount(account)) return STATUS_TEXT.BANNED;
  if (account.status === 'SUSPENDED' || account.status === 'LIMITED' || account.status === 'SYNC_FAILED' || account.status === 'EXPIRED') {
    return statusTextForAccount(account);
  }
  return null;
}

export function accountErrorText(product: ProductKind, error: unknown): string {
  return toProductUserMessage(product, error);
}

export function tokenRemainLine(text: string | null | undefined): string {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.startsWith('剩余')) return `登录还剩 ${value.slice(2).trim()}`;
  if (value === '已过期') return '登录已过期';
  if (value === '已失效') return '登录已失效';
  if (value === '有效期未知') return '登录有效期未知';
  return value;
}

export function splitEmail(email: string | null | undefined): { local: string; domain: string } {
  const value = String(email || '').trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return { local: value, domain: '' };
  return { local: value.slice(0, at), domain: value.slice(at) };
}

export interface LensDial {
  weekly: number | null;
  fiveHour: number | null;
  heroPercent: number | null;
  heroLabel: string;
}

export interface LensView {
  hero: ReturnType<typeof quotaHero>;
  isCurrent: boolean;
  // Quota is hidden when the login itself is unusable (reauth / banned).
  hideQuota: boolean;
  hideFailedQuota: boolean;
  outerValue: number | null;
  innerValue: number | null;
  showInner: boolean;
  showOuter: boolean;
  caption: string;
  showPair: boolean;
  pairDials: LensDial[];
  planBadge: string;
  statusBadge: string | null;
  emailParts: { local: string; domain: string };
  emptyKind: 'banned' | 'reauth' | null;
}

export function deriveLensView(product: ProductKind, viewed: AccountQuota | null | undefined): LensView {
  const hero = quotaHero(viewed);
  const windows = lensQuotaWindows(viewed);
  const isCurrent = !!viewed?.isCurrent;
  const hideQuota = hideStaleQuota(viewed);
  const hideFailedQuota = viewed?.status === 'SYNC_FAILED';
  const outerValue = hideQuota || hideFailedQuota ? null : windows.outer;
  const innerValue = hideQuota || hideFailedQuota ? null : windows.inner;
  const innerReset = formatResetLine(windows.innerReset);
  const outerReset = formatResetLine(windows.outerReset);
  const resetLine = hero.key === 'fiveHour' ? innerReset : (outerReset || innerReset);
  const tokenLine = isManagedProduct(product) && !hideQuota && !hideFailedQuota ? tokenRemainLine(viewed?.tokenValidity) : '';
  const caption = tokenLine || (!hideQuota && !hideFailedQuota ? resetLine : '');
  // Antigravity always shows its two model families side by side; Cursor
  // shows plan and Auto as a pair while the login is usable; Codex is one dial.
  const showPair = product === 'antigravity'
    ? !!viewed
    : isManagedProduct(product) && !hideQuota;
  const pairDials: LensDial[] = showPair && viewed && product === 'antigravity'
    ? antigravityQuotaFamilies(viewed).map((family) => {
      const weekly = hideQuota || hideFailedQuota ? null : family.weekly.remaining;
      const fiveHour = hideQuota || hideFailedQuota ? null : family.fiveHour.remaining;
      return {
        weekly,
        fiveHour,
        heroPercent: tighterRemaining(weekly, fiveHour),
        heroLabel: family.title,
      };
    })
    : [
      { weekly: outerValue, fiveHour: null, heroPercent: outerValue, heroLabel: windows.outerLabel },
      { weekly: innerValue, fiveHour: null, heroPercent: innerValue, heroLabel: windows.innerLabel },
    ];
  return {
    hero,
    isCurrent,
    hideQuota,
    hideFailedQuota,
    outerValue,
    innerValue,
    showInner: innerValue != null,
    showOuter: outerValue != null,
    caption,
    showPair,
    pairDials,
    planBadge: viewed ? planCaption(viewed) : '',
    statusBadge: viewed ? statusBadgeText(viewed) : null,
    emailParts: splitEmail(viewed?.email),
    emptyKind: hideQuota
      ? (viewed?.status === 'BANNED' && !isManagedProductAccount(viewed) ? 'banned' : 'reauth')
      : null,
  };
}

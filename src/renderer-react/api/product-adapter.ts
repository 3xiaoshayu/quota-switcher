import {
  AccountQuota,
  DesktopAutoSwitchConfig,
  DesktopOAuthStatus,
  ProductKind,
} from '../types';
import { isManagedProduct, productById } from '../data/products';
import { toAntigravityUserMessage, toCursorUserMessage, toUserMessage } from './user-messages';
import {
  desktopApi,
  isAntigravityAccount,
  isCursorAccount,
  isManagedProductAccount,
  mapAccountForUi,
  mapAntigravityAccountForUi,
  mapCursorAccountForUi,
  productOfAccount,
} from './desktop';

export {
  isAntigravityAccount,
  isCursorAccount,
  isManagedProduct,
  isManagedProductAccount,
  productOfAccount,
};

export function productLabel(product: ProductKind): string {
  return productById(product).label;
}

export function officialClientLabel(product: ProductKind): string {
  if (product === 'antigravity') return 'Antigravity IDE';
  return productLabel(product);
}

export function toProductUserMessage(product: ProductKind, raw: unknown): string {
  if (product === 'antigravity') return toAntigravityUserMessage(raw);
  if (product === 'cursor') return toCursorUserMessage(raw);
  return toUserMessage(raw);
}

export function syncFailedCopy(product: ProductKind): string {
  return isManagedProduct(product) ? '这次没查清额度，请稍后重试。' : '额度同步失败，请稍后重试。';
}

function displayAuthEmail(product: ProductKind, email?: string | null): string {
  const value = String(email || '').trim();
  if (product === 'antigravity' && (!value || value.toLowerCase() === 'unknown' || !value.includes('@'))) {
    return '';
  }
  return value;
}

export function oauthFinishedCopy(options: {
  product: ProductKind;
  email?: string | null;
  mismatch?: boolean;
  isReauth?: boolean;
  updated?: boolean;
  switched?: boolean;
}): string {
  if (options.mismatch) {
    return options.email
      ? `浏览器登录的不是这个账号，已另存为 ${options.email}。原来的账号仍需重新授权。`
      : '浏览器登录的不是这个账号，已另存为新账号。原来的账号仍需重新授权。';
  }
  const email = displayAuthEmail(options.product, options.email);
  if (options.isReauth) return email ? `已重新授权 ${email}` : '账号已重新授权';
  if (options.updated) return email ? `已更新已有账号 ${email}` : '已更新已有账号';
  if (options.product === 'codex' && options.switched) {
    return email ? `已添加 ${email}，并已切换为当前账号` : '账号已添加，并已切换为当前账号';
  }
  return email ? `已添加 ${email}` : '账号已添加';
}

export function importAccountCopy(options: {
  product: ProductKind;
  email?: string | null;
  updated?: boolean;
  stalePossible?: boolean;
}): { message: string; tone: 'success' | 'warning' } {
  const label = officialClientLabel(options.product);
  const rawEmail = String(options.email || '').trim();
  const email = options.product === 'antigravity' && (!rawEmail || rawEmail.toLowerCase() === 'unknown' || !rawEmail.includes('@'))
    ? '未读取邮箱'
    : (rawEmail || `${label} 账号`);
  if (options.stalePossible) {
    return { message: `已导入。${label} 开着时导入的可能不是最新登录。`, tone: 'warning' };
  }
  if (options.updated) {
    return { message: `已更新已有账号 ${email}`, tone: 'success' };
  }
  return { message: `已导入 ${email}`, tone: 'success' };
}

export function mapProductAccount(
  product: ProductKind,
  account: Parameters<typeof mapAccountForUi>[0],
  currentAccount: Parameters<typeof mapAccountForUi>[1],
  config: DesktopAutoSwitchConfig,
): AccountQuota {
  if (product === 'antigravity') return mapAntigravityAccountForUi(account, currentAccount);
  if (product === 'cursor') return mapCursorAccountForUi(account, currentAccount);
  return mapAccountForUi(account, currentAccount, config);
}

export function accountsFromSnapshot(
  product: ProductKind,
  snapshot: {
    accounts?: AccountQuota[];
    cursorAccounts?: AccountQuota[];
    antigravityAccounts?: AccountQuota[];
  } | null | undefined,
): AccountQuota[] {
  if (product === 'antigravity') return snapshot?.antigravityAccounts || [];
  if (product === 'cursor') return snapshot?.cursorAccounts || [];
  return snapshot?.accounts || [];
}

export function productActions() {
  return {
    refreshAllQuotas(product: ProductKind) {
      if (product === 'antigravity') return desktopApi.refreshAllAntigravityQuotas();
      if (product === 'cursor') return desktopApi.refreshAllCursorQuotas();
      return desktopApi.refreshAllQuotas();
    },
    refreshQuota(product: ProductKind, id: string, force = true) {
      if (product === 'antigravity') return desktopApi.refreshAntigravityQuota(id, force);
      if (product === 'cursor') return desktopApi.refreshCursorQuota(id, force);
      return desktopApi.refreshQuota(id, force);
    },
    refreshToken(product: ProductKind, id: string) {
      if (product === 'antigravity') return desktopApi.refreshAntigravityToken(id);
      if (product === 'cursor') return desktopApi.refreshCursorToken(id);
      return desktopApi.refreshToken(id);
    },
    addAccount(product: ProductKind) {
      if (product === 'antigravity') return desktopApi.addAntigravityAccount();
      if (product === 'cursor') return desktopApi.addCursorAccount();
      return desktopApi.addAccount();
    },
    reauthorize(product: ProductKind, id: string) {
      if (product === 'antigravity') return desktopApi.reauthorizeAntigravityAccount(id);
      if (product === 'cursor') return desktopApi.reauthorizeCursorAccount(id);
      return desktopApi.reauthorizeAccount(id);
    },
    oauthStatus(product: ProductKind): Promise<DesktopOAuthStatus> {
      if (product === 'antigravity') return desktopApi.getAntigravityOAuthStatus();
      if (product === 'cursor') return desktopApi.getCursorOAuthStatus();
      return desktopApi.getOAuthStatus();
    },
    cancelOAuth(product: ProductKind) {
      if (product === 'antigravity') return desktopApi.cancelAntigravityOAuth();
      if (product === 'cursor') return desktopApi.cancelCursorOAuth();
      return desktopApi.cancelOAuth();
    },
    deleteAccount(product: ProductKind, id: string) {
      if (product === 'antigravity') return desktopApi.deleteAntigravityAccount(id);
      if (product === 'cursor') return desktopApi.deleteCursorAccount(id);
      return desktopApi.deleteAccount(id);
    },
    switchAccount(product: ProductKind, id: string, isCurrent = false) {
      if (product === 'antigravity') return desktopApi.switchAntigravityAccount(id);
      if (product === 'cursor') return desktopApi.switchCursorAccount(id);
      return isCurrent ? desktopApi.reapplyManagedAccount(id) : desktopApi.switchAccount(id);
    },
    importLocal(product: ProductKind) {
      if (product === 'antigravity') return desktopApi.importLocalAntigravityAccount();
      if (product === 'cursor') return desktopApi.importLocalCursorAccount();
      return desktopApi.adoptOfficialAccount();
    },
  };
}

export function floatChromeMark(product: ProductKind): string {
  return productById(product).label.toUpperCase();
}

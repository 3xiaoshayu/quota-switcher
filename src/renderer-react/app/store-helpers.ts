import type { SetStateAction } from 'react';
import { withCurrentFlag } from '../api/desktop';
import { productById } from '../data/products';
import { setAntigravityAccounts, setCodexAccounts, setCursorAccounts } from '../state/desktop-store';
import type { AccountQuota, ProductKind } from '../types';

export function setAccountsForProduct(product: ProductKind, updater: SetStateAction<AccountQuota[]>): void {
  const apply = (prev: AccountQuota[]) => (typeof updater === 'function' ? updater(prev) : updater);
  const current = productById(product).id;
  if (current === 'antigravity') setAntigravityAccounts(apply);
  else if (current === 'cursor') setCursorAccounts(apply);
  else setCodexAccounts(apply);
}

// Marks one account as current in its product list without waiting for the
// next snapshot, so the card flips as soon as the engine reports the switch.
export function applyCurrentAccountBadge(kind: ProductKind | undefined, currentId: string | null | undefined): void {
  if (!kind || !currentId) return;
  const apply = (prev: AccountQuota[]) => withCurrentFlag(prev, currentId);
  if (kind === 'antigravity') setAntigravityAccounts(apply);
  else if (kind === 'cursor') setCursorAccounts(apply);
  else if (kind === 'codex') setCodexAccounts(apply);
}

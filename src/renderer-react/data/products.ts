import { ManagedProductKind, ProductKind } from '../types';

export interface ProductDefinition {
  id: ProductKind;
  label: string;
  accountPrefix: string;
  features: {
    autoSwitch: boolean;
    floatLens: boolean;
    tokenBatch: boolean;
    oauthPasteCallback: boolean;
    localImport: boolean;
  };
}

export const PRODUCTS: ProductDefinition[] = [
  {
    id: 'codex',
    label: 'Codex',
    accountPrefix: 'codex_',
    features: {
      autoSwitch: true,
      floatLens: true,
      tokenBatch: true,
      oauthPasteCallback: true,
      localImport: true,
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    accountPrefix: 'cursor_',
    features: {
      autoSwitch: false,
      floatLens: true,
      tokenBatch: true,
      oauthPasteCallback: false,
      localImport: true,
    },
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    accountPrefix: 'antigravity_',
    features: {
      autoSwitch: false,
      floatLens: true,
      tokenBatch: true,
      oauthPasteCallback: false,
      localImport: true,
    },
  },
];

export function isActiveProduct(value: string | null | undefined): value is ProductKind {
  return PRODUCTS.some((item) => item.id === value);
}

export function productById(id: ProductKind | string | null | undefined): ProductDefinition {
  return PRODUCTS.find((item) => item.id === id) || PRODUCTS[0];
}

export function readStoredProduct(): ProductKind {
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem('cam_product');
  return isActiveProduct(stored) ? stored : 'codex';
}

export function isManagedProduct(value: string | null | undefined): value is ManagedProductKind {
  return value === 'cursor' || value === 'antigravity';
}

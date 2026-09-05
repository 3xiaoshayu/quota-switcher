import { useEffect, useRef, type MutableRefObject } from 'react';
import type {
  AccountQuota,
  DesktopAuthState,
  DesktopDaemonConfig,
  DesktopOAuthStatus,
  ProductKind,
} from '../types';
import { ConfigSaveQueue } from './config-save-queue';

// Latest-value refs the async flows read without re-subscribing to state.
// Effects here keep them in step with the store; the flows only read them.
export interface SharedRefs {
  product: MutableRefObject<ProductKind>;
  accounts: MutableRefObject<AccountQuota[]>;
  codexAccounts: MutableRefObject<AccountQuota[]>;
  cursorAccounts: MutableRefObject<AccountQuota[]>;
  antigravityAccounts: MutableRefObject<AccountQuota[]>;
  oauthStatus: MutableRefObject<DesktopOAuthStatus | null>;
  cursorOAuthStatus: MutableRefObject<DesktopOAuthStatus | null>;
  antigravityOAuthStatus: MutableRefObject<DesktopOAuthStatus | null>;
  daemonConfig: MutableRefObject<DesktopDaemonConfig>;
  authState: MutableRefObject<DesktopAuthState>;
  // Account ids with an operation in flight; a second click on the same card
  // and the background quota sync both stay away from them.
  operationIds: MutableRefObject<Set<string>>;
  configSaves: MutableRefObject<ConfigSaveQueue<unknown>>;
}

interface SharedRefsSource {
  product: ProductKind;
  accounts: AccountQuota[];
  codexAccounts: AccountQuota[];
  cursorAccounts: AccountQuota[];
  antigravityAccounts: AccountQuota[];
  oauthStatus: DesktopOAuthStatus | null;
  cursorOAuthStatus: DesktopOAuthStatus | null;
  antigravityOAuthStatus: DesktopOAuthStatus | null;
  daemonConfig: DesktopDaemonConfig;
  authState: DesktopAuthState;
}

export function useSharedRefs(source: SharedRefsSource): SharedRefs {
  const product = useRef(source.product);
  const accounts = useRef(source.accounts);
  const codexAccounts = useRef(source.codexAccounts);
  const cursorAccounts = useRef(source.cursorAccounts);
  const antigravityAccounts = useRef(source.antigravityAccounts);
  const oauthStatus = useRef(source.oauthStatus);
  const cursorOAuthStatus = useRef(source.cursorOAuthStatus);
  const antigravityOAuthStatus = useRef(source.antigravityOAuthStatus);
  const daemonConfig = useRef(source.daemonConfig);
  const authState = useRef(source.authState);
  const operationIds = useRef<Set<string>>(new Set());
  const configSaves = useRef(new ConfigSaveQueue<unknown>());

  useEffect(() => { product.current = source.product; }, [source.product]);
  useEffect(() => { accounts.current = source.accounts; }, [source.accounts]);
  useEffect(() => { codexAccounts.current = source.codexAccounts; }, [source.codexAccounts]);
  useEffect(() => { cursorAccounts.current = source.cursorAccounts; }, [source.cursorAccounts]);
  useEffect(() => { antigravityAccounts.current = source.antigravityAccounts; }, [source.antigravityAccounts]);
  useEffect(() => { oauthStatus.current = source.oauthStatus; }, [source.oauthStatus]);
  useEffect(() => { cursorOAuthStatus.current = source.cursorOAuthStatus; }, [source.cursorOAuthStatus]);
  useEffect(() => { antigravityOAuthStatus.current = source.antigravityOAuthStatus; }, [source.antigravityOAuthStatus]);
  useEffect(() => { daemonConfig.current = source.daemonConfig; }, [source.daemonConfig]);
  // authState is written through applyAuthState only; the ref is seeded here
  // and never synced from the store, so a stale store value cannot undo a
  // fresher write.

  const refs = useRef<SharedRefs>({
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
    operationIds,
    configSaves,
  });
  return refs.current;
}

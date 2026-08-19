import { useSyncExternalStore, type SetStateAction } from 'react';
import {
  INITIAL_ACCOUNTS,
  INITIAL_ANTIGRAVITY_ACCOUNTS,
  INITIAL_CURSOR_ACCOUNTS,
  INITIAL_DAEMON_STATE,
} from '../data/mockData';
import { hasDesktopBridge } from '../api/desktop';
import type {
  AccountQuota,
  DesktopAntigravityStatus,
  DesktopAppInfo,
  DesktopAuthState,
  DesktopAutoSwitchConfig,
  DesktopCodexStatus,
  DesktopCursorStatus,
  DesktopOAuthStatus,
  DesktopUpdateStatus,
  DaemonState,
} from '../types';

const desktopBridgeAvailable = hasDesktopBridge();

export const DEFAULT_AUTO_SWITCH_CONFIG: DesktopAutoSwitchConfig = {
  enabled: false,
  primary_threshold: 20,
  secondary_threshold: 30,
  account_scope_mode: 'all',
  selected_account_ids: [],
  sync_interval_minutes: 1,
};

export const EMPTY_AUTH_STATE: DesktopAuthState = {
  status: 'empty',
  requiresResolution: false,
  currentAccountId: null,
  matchedAccountId: null,
  officialIdentity: null,
  message: null,
};

export type DesktopStoreState = {
  codexAccounts: AccountQuota[];
  cursorAccounts: AccountQuota[];
  antigravityAccounts: AccountQuota[];
  daemonState: DaemonState;
  autoSwitchConfig: DesktopAutoSwitchConfig;
  appInfo: DesktopAppInfo | null;
  codexStatus: DesktopCodexStatus | null;
  cursorStatus: DesktopCursorStatus | null;
  antigravityStatus: DesktopAntigravityStatus | null;
  updateStatus: DesktopUpdateStatus | null;
  authState: DesktopAuthState;
  oauthStatus: DesktopOAuthStatus | null;
  cursorOAuthStatus: DesktopOAuthStatus | null;
  antigravityOAuthStatus: DesktopOAuthStatus | null;
  selectedAccountIds: string[];
};

function createInitialState(): DesktopStoreState {
  return {
    codexAccounts: desktopBridgeAvailable ? [] : INITIAL_ACCOUNTS,
    cursorAccounts: desktopBridgeAvailable ? [] : INITIAL_CURSOR_ACCOUNTS,
    antigravityAccounts: desktopBridgeAvailable ? [] : INITIAL_ANTIGRAVITY_ACCOUNTS,
    daemonState: desktopBridgeAvailable
      ? { status: 'Stopped', syncInterval: 1, lastChecked: '' }
      : INITIAL_DAEMON_STATE,
    autoSwitchConfig: DEFAULT_AUTO_SWITCH_CONFIG,
    appInfo: null,
    codexStatus: null,
    cursorStatus: null,
    antigravityStatus: null,
    updateStatus: null,
    authState: EMPTY_AUTH_STATE,
    oauthStatus: null,
    cursorOAuthStatus: null,
    antigravityOAuthStatus: null,
    selectedAccountIds: desktopBridgeAvailable ? [] : ['5', '6', '8'],
  };
}

let state: DesktopStoreState = createInitialState();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeDesktopStore(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDesktopStoreSnapshot() {
  return state;
}

export function patchDesktopStore(partial: Partial<DesktopStoreState>) {
  state = { ...state, ...partial };
  emit();
}

function setStoreField<K extends keyof DesktopStoreState>(key: K, value: SetStateAction<DesktopStoreState[K]>) {
  const previous = state[key];
  const next = typeof value === 'function'
    ? (value as (current: DesktopStoreState[K]) => DesktopStoreState[K])(previous)
    : value;
  if (Object.is(next, previous)) return;
  state = { ...state, [key]: next };
  emit();
}

export const setCodexAccounts = (value: SetStateAction<AccountQuota[]>) => setStoreField('codexAccounts', value);
export const setCursorAccounts = (value: SetStateAction<AccountQuota[]>) => setStoreField('cursorAccounts', value);
export const setAntigravityAccounts = (value: SetStateAction<AccountQuota[]>) => setStoreField('antigravityAccounts', value);
export const setDaemonState = (value: SetStateAction<DaemonState>) => setStoreField('daemonState', value);
export const setAutoSwitchConfig = (value: SetStateAction<DesktopAutoSwitchConfig>) => setStoreField('autoSwitchConfig', value);
export const setAppInfo = (value: SetStateAction<DesktopAppInfo | null>) => setStoreField('appInfo', value);
export const setCodexStatus = (value: SetStateAction<DesktopCodexStatus | null>) => setStoreField('codexStatus', value);
export const setCursorStatus = (value: SetStateAction<DesktopCursorStatus | null>) => setStoreField('cursorStatus', value);
export const setAntigravityStatus = (value: SetStateAction<DesktopAntigravityStatus | null>) => setStoreField('antigravityStatus', value);
export const setUpdateStatus = (value: SetStateAction<DesktopUpdateStatus | null>) => setStoreField('updateStatus', value);
export const setAuthState = (value: SetStateAction<DesktopAuthState>) => setStoreField('authState', value);
export const setOAuthStatus = (value: SetStateAction<DesktopOAuthStatus | null>) => setStoreField('oauthStatus', value);
export const setCursorOAuthStatus = (value: SetStateAction<DesktopOAuthStatus | null>) => setStoreField('cursorOAuthStatus', value);
export const setAntigravityOAuthStatus = (value: SetStateAction<DesktopOAuthStatus | null>) => setStoreField('antigravityOAuthStatus', value);
export const setSelectedAccountIds = (value: SetStateAction<string[]>) => setStoreField('selectedAccountIds', value);

export function useDesktopStore() {
  return useSyncExternalStore(subscribeDesktopStore, getDesktopStoreSnapshot, getDesktopStoreSnapshot);
}

export function resetDesktopStoreForTests() {
  state = createInitialState();
  emit();
}

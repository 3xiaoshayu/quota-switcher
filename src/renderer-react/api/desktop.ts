import {
  AccountQuota,
  AutoSwitchRunResult,
  DesktopAppInfo,
  DesktopAutoSwitchConfig,
  DesktopAuthState,
  DesktopCodexStatus,
  DesktopOAuthStatus,
  DesktopUpdateStatus,
  StorageDiagnostic,
} from '../types';

type ApiResponse<T> = { success: true; data: T } | { success: false; error?: string };

interface DesktopQuota {
  hourly_percentage?: number | null;
  hourly_remaining_percentage?: number | null;
  hourly_reset_time?: string | number | null;
  hourly_window_minutes?: number | null;
  hourly_window_present?: boolean;
  weekly_percentage?: number | null;
  weekly_remaining_percentage?: number | null;
  weekly_reset_time?: string | number | null;
  weekly_window_minutes?: number | null;
  weekly_window_present?: boolean;
  weekly_blocks_hourly?: boolean;
  plan_type?: string | null;
}

interface DesktopAccount {
  id: string;
  email: string;
  plan_type?: string | null;
  subscription_active_until?: string | number | null;
  token_generation?: number | null;
  token_updated_at?: string | number | null;
  created_at?: string | number | null;
  last_used?: string | number | null;
  usage_updated_at?: string | number | null;
  requires_reauth?: boolean;
  reauth_reason?: string | null;
  quota?: DesktopQuota | null;
  quota_error?: { code?: string | null; message?: string | null; timestamp?: string | number | null } | null;
  quota_next_retry_at?: string | number | null;
  token_status?: {
    accessAvailable?: boolean;
    refreshAvailable?: boolean;
    expired?: boolean;
    expiryDate?: string | number | null;
    issuedAt?: number | null;
    timeLeft?: number | null;
  };
}

type DesktopDaemonStatus = {
  running: boolean;
  syncIntervalMinutes?: number | null;
  lastRunAt?: string | number | null;
  lastSuccessAt?: string | number | null;
  lastError?: string | null;
  pausedReason?: string | null;
};

type DesktopOAuthResult = {
  account: DesktopAccount | null;
  mismatch?: boolean;
  targetAccountId?: string | null;
};

type DesktopTokenRefreshResult = {
  ok: boolean;
  skipped?: boolean;
  revoked?: boolean;
  gen?: number;
  error?: string;
};

type DesktopTokenRefreshAllResult = {
  okCount: number;
  revivedCount: number;
  deadCount: number;
  results: Array<{
    email: string;
    ok: boolean;
    skipped?: boolean;
    reauthRequired?: boolean;
    gen?: number;
    error?: string;
  }>;
};

interface DesktopBridge {
  getAppInfo: () => Promise<ApiResponse<DesktopAppInfo>>;
  getCodexStatus: () => Promise<ApiResponse<DesktopCodexStatus>>;
  getUpdateStatus: () => Promise<ApiResponse<DesktopUpdateStatus>>;
  checkForUpdates: () => Promise<ApiResponse<unknown>>;
  installUpdate: () => Promise<ApiResponse<unknown>>;
  openExternal: (url: string) => Promise<ApiResponse<boolean>>;
  openLogs: () => Promise<ApiResponse<boolean>>;
  getStorageDiagnostics: () => Promise<ApiResponse<StorageDiagnostic[]>>;
  minimizeWindow: () => Promise<ApiResponse<boolean>>;
  toggleMaximizeWindow: () => Promise<ApiResponse<boolean>>;
  closeWindow: () => Promise<ApiResponse<boolean>>;
  listAccounts: () => Promise<ApiResponse<DesktopAccount[]>>;
  getCurrentAccount: () => Promise<ApiResponse<DesktopAccount | null>>;
  addAccount: () => Promise<ApiResponse<DesktopOAuthResult>>;
  reauthorizeAccount: (id: string) => Promise<ApiResponse<DesktopOAuthResult>>;
  getOAuthStatus: () => Promise<ApiResponse<DesktopOAuthStatus>>;
  cancelOAuth: () => Promise<ApiResponse<boolean>>;
  completeOAuthManually: (callbackUrl: string) => Promise<ApiResponse<DesktopOAuthResult>>;
  getAuthState: () => Promise<ApiResponse<DesktopAuthState>>;
  adoptOfficialAccount: () => Promise<ApiResponse<DesktopAccount>>;
  reapplyManagedAccount: (id?: string | null) => Promise<ApiResponse<unknown>>;
  deleteAccount: (id: string) => Promise<ApiResponse<boolean>>;
  switchAccount: (id: string) => Promise<ApiResponse<unknown>>;
  refreshQuota: (id: string, force?: boolean) => Promise<ApiResponse<DesktopQuota>>;
  refreshAllQuotas: () => Promise<ApiResponse<Array<{
    id: string;
    email: string;
    quota?: DesktopQuota;
    error?: string;
    skipped?: boolean;
    reason?: 'reauthorization_required' | string;
  }>>>;
  refreshToken: (id: string) => Promise<ApiResponse<DesktopTokenRefreshResult>>;
  refreshAllTokens: (force?: boolean) => Promise<ApiResponse<DesktopTokenRefreshAllResult>>;
  getAutoSwitchConfig: () => Promise<ApiResponse<DesktopAutoSwitchConfig>>;
  saveAutoSwitchConfig: (cfg: DesktopAutoSwitchConfig) => Promise<ApiResponse<boolean>>;
  runAutoSwitchTick: () => Promise<ApiResponse<AutoSwitchRunResult>>;
  startDaemon: () => Promise<ApiResponse<string>>;
  stopDaemon: () => Promise<ApiResponse<string>>;
  getDaemonStatus: () => Promise<ApiResponse<DesktopDaemonStatus>>;
  onDaemonTick?: (cb: (payload: unknown) => void) => () => void;
  onDaemonError?: (cb: (payload: { message?: string }) => void) => () => void;
  onAutoSwitch?: (cb: (payload: AutoSwitchRunResult) => void) => () => void;
  onUpdateStatus?: (cb: (payload: DesktopUpdateStatus) => void) => () => void;
  onAuthConflict?: (cb: (payload: DesktopAuthState) => void) => () => void;
}

declare global {
  interface Window {
    codexAccountManager?: DesktopBridge;
    codexDeskep?: DesktopBridge;
  }
}

export interface DashboardState {
  accounts: AccountQuota[];
  rawAccounts: DesktopAccount[];
  currentAccount: DesktopAccount | null;
  daemonRunning: boolean;
  daemonSyncInterval: number;
  config: DesktopAutoSwitchConfig;
  appInfo: DesktopAppInfo | null;
  codexStatus: DesktopCodexStatus | null;
  updateStatus: DesktopUpdateStatus | null;
  authState: DesktopAuthState;
  oauthStatus: DesktopOAuthStatus;
  storageDiagnostics: StorageDiagnostic[];
  daemonLastSuccessAt?: string | number | null;
  daemonLastRunAt?: string | number | null;
  daemonLastError?: string | null;
  daemonPausedReason?: string | null;
}

export const QUOTA_AUTO_SYNC_STALE_MS = 10 * 60 * 1000;
export const QUOTA_AUTO_SYNC_MIN_GAP_MS = 60 * 1000;

export function getBridge(): DesktopBridge | null {
  return window.codexAccountManager || window.codexDeskep || null;
}

export function hasDesktopBridge(): boolean {
  return !!getBridge();
}

function bridge(): DesktopBridge {
  const api = getBridge();
  if (!api) {
    throw new Error('Desktop bridge is not available. Start the app through Electron.');
  }
  return api;
}

export function expectData<T>(response: ApiResponse<T>, label: string): T {
  if (!response || response.success !== true) {
    throw new Error(response?.error || `${label} failed`);
  }
  return response.data;
}

async function captureResponse<T>(
  task: () => Promise<ApiResponse<T>>,
  label: string,
): Promise<ApiResponse<T>> {
  try {
    return await task();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : `${label} failed`,
    };
  }
}

function optionalData<T>(response: ApiResponse<T>, fallback: T): T {
  return response?.success === true ? response.data : fallback;
}

function defaultConfig(): DesktopAutoSwitchConfig {
  return {
    enabled: false,
    primary_threshold: 20,
    secondary_threshold: 30,
    account_scope_mode: 'all',
    selected_account_ids: [],
    sync_interval_minutes: 10,
  };
}

function defaultDaemonStatus(): DesktopDaemonStatus {
  return { running: false, syncIntervalMinutes: 10 };
}

function defaultAuthState(): DesktopAuthState {
  return {
    status: 'empty',
    requiresResolution: false,
    currentAccountId: null,
    matchedAccountId: null,
    officialIdentity: null,
    message: null,
  };
}

function unverifiedAuthState(message?: string): DesktopAuthState {
  return {
    status: 'unknown',
    requiresResolution: true,
    currentAccountId: null,
    matchedAccountId: null,
    officialIdentity: null,
    message: message || 'Authentication state could not be verified. Background sync is paused until this check succeeds.',
  };
}

function defaultOAuthStatus(): DesktopOAuthStatus {
  return { status: 'idle', pending: false, message: null };
}

function clampSyncIntervalMinutes(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 10;
  return Math.min(60, Math.max(1, Math.round(number)));
}

function clampPercent(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function toDate(value: string | number | null | undefined): Date | null {
  if (!value) return null;
  const date = typeof value === 'number'
    ? new Date(value < 1e12 ? value * 1000 : value)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatDuration(seconds: unknown): string {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '未知';
  if (value <= 0) return '已过期';
  if (value < 3600) return `${Math.max(1, Math.ceil(value / 60))}m`;
  if (value < 86400) return `${Math.floor(value / 3600)}h ${Math.ceil((value % 3600) / 60)}m`;
  return `${Math.floor(value / 86400)}d ${Math.floor((value % 86400) / 3600)}h`;
}

function formatReset(value: string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return '等待中';
  const seconds = Math.floor((date.getTime() - Date.now()) / 1000);
  return formatDuration(seconds);
}

// Deterministic gradient per account for the letter avatars.
const AVATAR_GRADIENTS = [
  'from-blue-500 to-cyan-400',
  'from-violet-500 to-purple-400',
  'from-emerald-500 to-teal-400',
  'from-amber-500 to-orange-400',
  'from-rose-500 to-pink-400',
  'from-indigo-500 to-blue-400',
  'from-fuchsia-500 to-pink-400',
  'from-sky-500 to-cyan-400',
];

export function avatarGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

function planForUi(planType: string | null | undefined): AccountQuota['plan'] {
  const value = String(planType || '').toLowerCase();
  if (value.includes('enterprise') || value.includes('team') || value.includes('business')) return 'Enterprise';
  if (value.includes('plus') || value.includes('pro')) return 'Pro Plan';
  return 'Standard';
}

function priorityForUi(account: DesktopAccount): AccountQuota['priority'] {
  const plan = String(account.plan_type || '').toLowerCase();
  if (plan.includes('enterprise') || plan.includes('team')) return 'Ultra';
  if (plan.includes('plus') || plan.includes('pro')) return 'High';
  return 'Normal';
}

function statusForUi(
  account: DesktopAccount,
  config: DesktopAutoSwitchConfig,
): AccountQuota['status'] {
  if (account.requires_reauth) return 'SUSPENDED';
  if (account.token_status?.expired || account.token_status?.accessAvailable === false) return 'SUSPENDED';
  if (account.quota_error) return 'WARNING';
  const hasPresence = account.quota?.hourly_window_present !== undefined || account.quota?.weekly_window_present !== undefined;
  const hourlyPresent = !hasPresence || account.quota?.hourly_window_present === true;
  const weeklyPresent = !hasPresence || account.quota?.weekly_window_present === true;
  const hourly = hourlyPresent
    ? clampPercent(account.quota?.hourly_remaining_percentage ?? account.quota?.hourly_percentage)
    : null;
  const weekly = weeklyPresent
    ? clampPercent(account.quota?.weekly_remaining_percentage ?? account.quota?.weekly_percentage)
    : null;
  if (hourly === 0 || weekly === 0) return 'EXPIRED';
  if (hourly !== null && hourly <= Number(config.primary_threshold ?? 20)) return 'LOW_QUOTA';
  if (weekly !== null && weekly <= Number(config.secondary_threshold ?? 30)) return 'WARNING';
  if (!account.quota) return 'READY';
  return 'ACTIVE';
}

function displayName(email: string): string {
  return email.includes('@') ? email.split('@')[0] : email;
}

export function mapAccountForUi(
  account: DesktopAccount,
  currentAccount: DesktopAccount | null,
  config: DesktopAutoSwitchConfig,
): AccountQuota {
  const hourlyRemaining = clampPercent(account.quota?.hourly_remaining_percentage ?? account.quota?.hourly_percentage);
  const weeklyRemaining = clampPercent(account.quota?.weekly_remaining_percentage ?? account.quota?.weekly_percentage);
  const hasPresence = account.quota?.hourly_window_present !== undefined || account.quota?.weekly_window_present !== undefined;
  const hourlyPresent = !hasPresence || account.quota?.hourly_window_present === true;
  const weeklyPresent = !hasPresence || account.quota?.weekly_window_present === true;
  const quotaError = account.quota_error?.message || account.quota_error?.code || null;
  const tokenStatus = account.token_status || {};
  const expirySeconds = typeof tokenStatus.expiryDate === 'number' ? tokenStatus.expiryDate : null;
  const issuedSeconds = typeof tokenStatus.issuedAt === 'number' ? tokenStatus.issuedAt : null;
  let tokenValidityPct: number | null = null;
  if (tokenStatus.expired) {
    tokenValidityPct = 0;
  } else if (
    typeof tokenStatus.timeLeft === 'number'
    && expirySeconds !== null
    && issuedSeconds !== null
    && expirySeconds > issuedSeconds
  ) {
    tokenValidityPct = Math.max(0, Math.min(100, (tokenStatus.timeLeft / (expirySeconds - issuedSeconds)) * 100));
  }

  return {
    id: account.id,
    name: displayName(account.email),
    email: account.email,
    status: statusForUi(account, config),
    fiveHourQuotaRemaining: hourlyPresent ? hourlyRemaining : null,
    fiveHourQuotaTotal: 100,
    weeklyQuotaRemaining: weeklyPresent ? weeklyRemaining : null,
    weeklyQuotaTotal: 100,
    fiveHourQuotaPresent: hourlyPresent,
    weeklyQuotaPresent: weeklyPresent,
    weeklyBlocksFiveHour: !!account.quota?.weekly_blocks_hourly,
    priority: priorityForUi(account),
    plan: planForUi(account.plan_type || account.quota?.plan_type),
    tokenValidity: tokenStatus.expired ? '已过期' : `剩余 ${formatDuration(tokenStatus.timeLeft)}`,
    tokenValidityPct,
    resetInFiveHour: formatReset(account.quota?.hourly_reset_time),
    resetInWeekly: formatReset(account.quota?.weekly_reset_time),
    warning: account.requires_reauth
      ? '该账号需要重新授权后才能刷新 Token。'
      : account.reauth_reason || quotaError,
    isCurrent: !!currentAccount && currentAccount.id === account.id,
    quotaUpdatedAt: account.usage_updated_at,
    quotaNextRetryAt: account.quota_next_retry_at,
    quotaError,
    tokenExpired: !!tokenStatus.expired,
    tokenAccessAvailable: !!tokenStatus.accessAvailable,
    tokenRefreshAvailable: !!tokenStatus.refreshAvailable,
  };
}

export function needsQuotaAutoSync(account: AccountQuota): boolean {
  if (account.tokenExpired || account.tokenAccessAvailable === false) return false;
  if (account.status === 'SUSPENDED') return false;
  const retryAt = toDate(account.quotaNextRetryAt);
  if (retryAt && retryAt.getTime() > Date.now()) return false;
  if (!account.quotaUpdatedAt || account.quotaError) return true;
  const date = toDate(account.quotaUpdatedAt);
  if (!date) return true;
  return Date.now() - date.getTime() > QUOTA_AUTO_SYNC_STALE_MS;
}

export const desktopApi = {
  async getAppInfo() {
    return expectData(await bridge().getAppInfo(), 'Read app info');
  },

  async loadDashboardState(): Promise<DashboardState> {
    const api = bridge();
    const [
      accountsResponse,
      currentResponse,
      daemonResponse,
      configResponse,
      appResponse,
      codexResponse,
      updateResponse,
      authStateResponse,
      oauthStatusResponse,
      diagnosticsResponse,
    ] = await Promise.all([
      captureResponse(() => api.listAccounts(), 'Read accounts'),
      captureResponse(() => api.getCurrentAccount(), 'Read current account'),
      captureResponse(() => api.getDaemonStatus(), 'Read daemon status'),
      captureResponse(() => api.getAutoSwitchConfig(), 'Read auto-switch config'),
      captureResponse(() => api.getAppInfo(), 'Read app info'),
      captureResponse(() => api.getCodexStatus(), 'Read Codex status'),
      captureResponse(() => api.getUpdateStatus(), 'Read update status'),
      captureResponse(() => api.getAuthState(), 'Read authentication state'),
      captureResponse(() => api.getOAuthStatus(), 'Read OAuth status'),
      captureResponse(() => api.getStorageDiagnostics(), 'Read storage diagnostics'),
    ]);

    const config = optionalData(configResponse, defaultConfig()) || defaultConfig();
    const rawAccounts = expectData(accountsResponse, 'Read accounts') || [];
    const currentAccount = optionalData(currentResponse, null);
    const daemon = optionalData(daemonResponse, defaultDaemonStatus()) || defaultDaemonStatus();
    const authState = authStateResponse.success === true
      ? authStateResponse.data
      : unverifiedAuthState(authStateResponse.error);

    return {
      accounts: rawAccounts.map((account) => mapAccountForUi(account, currentAccount, config)),
      rawAccounts,
      currentAccount,
      daemonRunning: !!daemon?.running,
      daemonSyncInterval: clampSyncIntervalMinutes(daemon?.syncIntervalMinutes ?? config.sync_interval_minutes),
      config,
      appInfo: optionalData(appResponse, null),
      codexStatus: optionalData(codexResponse, null),
      updateStatus: optionalData(updateResponse, null),
      authState: authState || defaultAuthState(),
      oauthStatus: optionalData(oauthStatusResponse, defaultOAuthStatus()) || defaultOAuthStatus(),
      storageDiagnostics: optionalData(diagnosticsResponse, []) || [],
      daemonLastSuccessAt: daemon?.lastSuccessAt || null,
      daemonLastRunAt: daemon?.lastRunAt || null,
      daemonLastError: daemon?.lastError || null,
      daemonPausedReason: daemon?.pausedReason || null,
    };
  },

  async refreshQuota(id: string, force = true) {
    return expectData(await bridge().refreshQuota(id, force), 'Refresh quota');
  },

  async refreshAllQuotas() {
    return expectData(await bridge().refreshAllQuotas(), 'Refresh all quotas') || [];
  },

  async refreshToken(id: string) {
    const result = expectData(await bridge().refreshToken(id), 'Refresh token');
    if (result && result.ok === false) throw new Error(result.error || 'Token refresh failed');
    return result;
  },

  async refreshAllTokens(force = false) {
    return expectData(await bridge().refreshAllTokens(force), 'Refresh all tokens');
  },

  async addAccount() {
    return expectData(await bridge().addAccount(), 'Add account');
  },

  async reauthorizeAccount(id: string) {
    return expectData(await bridge().reauthorizeAccount(id), 'Reauthorize account');
  },

  async getOAuthStatus() {
    return expectData(await bridge().getOAuthStatus(), 'Read OAuth status');
  },

  async cancelOAuth() {
    return expectData(await bridge().cancelOAuth(), 'Cancel OAuth');
  },

  async completeOAuthManually(callbackUrl: string) {
    return expectData(await bridge().completeOAuthManually(callbackUrl), 'Complete OAuth manually');
  },

  async adoptOfficialAccount() {
    return expectData(await bridge().adoptOfficialAccount(), 'Adopt official account');
  },

  async reapplyManagedAccount(id?: string | null) {
    return expectData(await bridge().reapplyManagedAccount(id), 'Reapply managed account');
  },

  async deleteAccount(id: string) {
    return expectData(await bridge().deleteAccount(id), 'Delete account');
  },

  async switchAccount(id: string) {
    return expectData(await bridge().switchAccount(id), 'Switch account');
  },

  async saveAutoSwitchConfig(config: DesktopAutoSwitchConfig) {
    return expectData(await bridge().saveAutoSwitchConfig(config), 'Save auto-switch config');
  },

  async runAutoSwitchTick() {
    return expectData(await bridge().runAutoSwitchTick(), 'Run auto-switch check');
  },

  async startDaemon() {
    return expectData(await bridge().startDaemon(), 'Start daemon');
  },

  async stopDaemon() {
    return expectData(await bridge().stopDaemon(), 'Stop daemon');
  },

  async getCodexStatus() {
    return expectData(await bridge().getCodexStatus(), 'Read Codex status');
  },

  async checkForUpdates() {
    return expectData(await bridge().checkForUpdates(), 'Check for updates');
  },

  async installUpdate() {
    return expectData(await bridge().installUpdate(), 'Install update');
  },

  async openExternal(url: string) {
    return expectData(await bridge().openExternal(url), 'Open external URL');
  },

  async openLogs() {
    return expectData(await bridge().openLogs(), 'Open log folder');
  },

  async minimizeWindow() {
    return expectData(await bridge().minimizeWindow(), 'Minimize window');
  },

  async toggleMaximizeWindow() {
    return expectData(await bridge().toggleMaximizeWindow(), 'Toggle maximize');
  },

  async closeWindow() {
    return expectData(await bridge().closeWindow(), 'Close window');
  },

  subscribe(events: {
    onDaemonTick?: () => void;
    onDaemonError?: (message: string) => void;
    onAutoSwitch?: (result: AutoSwitchRunResult) => void;
    onUpdateStatus?: (status: DesktopUpdateStatus) => void;
    onAuthConflict?: (state: DesktopAuthState) => void;
  }) {
    const api = getBridge();
    if (!api) return () => {};
    const cleanups = [
      api.onDaemonTick?.(() => events.onDaemonTick?.()),
      api.onDaemonError?.((payload) => events.onDaemonError?.(payload?.message || 'Daemon error')),
      api.onAutoSwitch?.((payload) => events.onAutoSwitch?.(payload)),
      api.onUpdateStatus?.((payload) => events.onUpdateStatus?.(payload)),
      api.onAuthConflict?.((payload) => events.onAuthConflict?.(payload)),
    ].filter(Boolean) as Array<() => void>;
    return () => cleanups.forEach((cleanup) => cleanup());
  },
};

import {
  AccountQuota,
  DesktopAppInfo,
  DesktopAutoSwitchConfig,
  DesktopCodexStatus,
  DesktopUpdateStatus,
} from '../types';

type ApiResponse<T> = { success: true; data: T } | { success: false; error?: string };

interface DesktopQuota {
  hourly_percentage?: number | null;
  hourly_reset_time?: string | number | null;
  hourly_window_minutes?: number | null;
  hourly_window_present?: boolean;
  weekly_percentage?: number | null;
  weekly_reset_time?: string | number | null;
  weekly_window_minutes?: number | null;
  weekly_window_present?: boolean;
  reset_credits_available?: number | null;
  reset_credits_next_expires_at?: string | number | null;
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
  reset_credits?: { available_count?: number | null; next_expires_at?: string | number | null } | null;
  token_status?: {
    accessAvailable?: boolean;
    refreshAvailable?: boolean;
    expired?: boolean;
    expiryDate?: string | number | null;
    timeLeft?: number | null;
  };
}

type AutoSwitchResult = {
  switched?: boolean;
  reason?: string;
  from?: DesktopAccount | null;
  to?: DesktopAccount | null;
};

type DesktopDaemonStatus = {
  running: boolean;
  syncIntervalMinutes?: number | null;
};

type DesktopSubscriptionRefreshResult = {
  changed?: boolean;
  plan_type?: string | null;
  subscription_active_until?: string | number | null;
};

interface DesktopBridge {
  getAppInfo: () => Promise<ApiResponse<DesktopAppInfo>>;
  getCodexStatus: () => Promise<ApiResponse<DesktopCodexStatus>>;
  getUpdateStatus: () => Promise<ApiResponse<DesktopUpdateStatus>>;
  checkForUpdates: () => Promise<ApiResponse<unknown>>;
  installUpdate: () => Promise<ApiResponse<unknown>>;
  openExternal: (url: string) => Promise<ApiResponse<boolean>>;
  listAccounts: () => Promise<ApiResponse<DesktopAccount[]>>;
  getCurrentAccount: () => Promise<ApiResponse<DesktopAccount | null>>;
  addAccount: () => Promise<ApiResponse<DesktopAccount | null>>;
  deleteAccount: (id: string) => Promise<ApiResponse<boolean>>;
  switchAccount: (id: string) => Promise<ApiResponse<unknown>>;
  refreshQuota: (id: string) => Promise<ApiResponse<DesktopQuota>>;
  refreshAllQuotas: () => Promise<ApiResponse<Array<{ id: string; email: string; quota?: DesktopQuota; error?: string }>>>;
  refreshToken: (id: string) => Promise<ApiResponse<{ ok?: boolean; skipped?: boolean; error?: string }>>;
  refreshAllTokens: (force?: boolean) => Promise<ApiResponse<unknown>>;
  consumeResetCredit: (id: string) => Promise<ApiResponse<boolean>>;
  refreshSubscription: (id: string, force?: boolean) => Promise<ApiResponse<DesktopSubscriptionRefreshResult>>;
  getAutoSwitchConfig: () => Promise<ApiResponse<DesktopAutoSwitchConfig>>;
  saveAutoSwitchConfig: (cfg: DesktopAutoSwitchConfig) => Promise<ApiResponse<boolean>>;
  runAutoSwitchTick: () => Promise<ApiResponse<AutoSwitchResult>>;
  startDaemon: () => Promise<ApiResponse<string>>;
  stopDaemon: () => Promise<ApiResponse<string>>;
  getDaemonStatus: () => Promise<ApiResponse<DesktopDaemonStatus>>;
  onDaemonTick?: (cb: (payload: unknown) => void) => () => void;
  onDaemonError?: (cb: (payload: { message?: string }) => void) => () => void;
  onAutoSwitch?: (cb: (payload: AutoSwitchResult) => void) => () => void;
  onUpdateStatus?: (cb: (payload: DesktopUpdateStatus) => void) => () => void;
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

function clampSyncIntervalMinutes(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 10;
  return Math.min(60, Math.max(1, Math.round(number)));
}

function clampPercent(value: unknown): number | null {
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
  if (!date) return 'Unknown';
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
  if (!Number.isFinite(value)) return 'Unknown';
  if (value <= 0) return 'Expired';
  if (value < 3600) return `${Math.max(1, Math.ceil(value / 60))}m`;
  if (value < 86400) return `${Math.floor(value / 3600)}h ${Math.ceil((value % 3600) / 60)}m`;
  return `${Math.floor(value / 86400)}d ${Math.floor((value % 86400) / 3600)}h`;
}

function formatReset(value: string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return 'Waiting';
  const seconds = Math.floor((date.getTime() - Date.now()) / 1000);
  return formatDuration(seconds);
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
  const hourly = clampPercent(account.quota?.hourly_percentage);
  const weekly = clampPercent(account.quota?.weekly_percentage);
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
  const hourlyRemaining = clampPercent(account.quota?.hourly_percentage);
  const weeklyRemaining = clampPercent(account.quota?.weekly_percentage);
  const resetCredits = Number(
    account.reset_credits?.available_count
    ?? account.quota?.reset_credits_available
    ?? 0,
  );
  const quotaError = account.quota_error?.message || account.quota_error?.code || null;
  const tokenStatus = account.token_status || {};

  return {
    id: account.id,
    name: displayName(account.email),
    email: account.email,
    status: statusForUi(account, config),
    fiveHourQuotaUsed: hourlyRemaining ?? 0,
    fiveHourQuotaTotal: 100,
    weeklyQuotaUsed: weeklyRemaining ?? 0,
    weeklyQuotaTotal: 100,
    priority: priorityForUi(account),
    plan: planForUi(account.plan_type || account.quota?.plan_type),
    tokenValidity: tokenStatus.expired ? 'Expired' : `${formatDuration(tokenStatus.timeLeft)} left`,
    resetInFiveHour: formatReset(account.quota?.hourly_reset_time),
    resetInWeekly: formatReset(account.quota?.weekly_reset_time),
    warning: account.reauth_reason || quotaError,
    isCurrent: !!currentAccount && currentAccount.id === account.id,
    quotaUpdatedAt: account.usage_updated_at,
    subscriptionActiveUntil: account.subscription_active_until,
    resetCreditsAvailable: resetCredits,
    resetCreditsNextExpiresAt: account.reset_credits?.next_expires_at || account.quota?.reset_credits_next_expires_at || null,
    quotaError,
    tokenExpired: !!tokenStatus.expired,
    tokenAccessAvailable: !!tokenStatus.accessAvailable,
    tokenRefreshAvailable: !!tokenStatus.refreshAvailable,
  };
}

export function needsQuotaAutoSync(account: AccountQuota): boolean {
  if (account.tokenExpired || account.tokenAccessAvailable === false) return false;
  if (account.status === 'SUSPENDED') return false;
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
    ] = await Promise.all([
      api.listAccounts(),
      api.getCurrentAccount(),
      api.getDaemonStatus(),
      api.getAutoSwitchConfig(),
      api.getAppInfo(),
      api.getCodexStatus(),
      api.getUpdateStatus(),
    ]);

    const config = expectData(configResponse, 'Read auto-switch config') || defaultConfig();
    const rawAccounts = expectData(accountsResponse, 'Read accounts') || [];
    const currentAccount = expectData(currentResponse, 'Read current account') || null;
    const daemon = expectData(daemonResponse, 'Read daemon status');

    return {
      accounts: rawAccounts.map((account) => mapAccountForUi(account, currentAccount, config)),
      rawAccounts,
      currentAccount,
      daemonRunning: !!daemon?.running,
      daemonSyncInterval: clampSyncIntervalMinutes(daemon?.syncIntervalMinutes ?? config.sync_interval_minutes),
      config,
      appInfo: expectData(appResponse, 'Read app info') || null,
      codexStatus: expectData(codexResponse, 'Read Codex status') || null,
      updateStatus: expectData(updateResponse, 'Read update status') || null,
    };
  },

  async refreshQuota(id: string) {
    return expectData(await bridge().refreshQuota(id), 'Refresh quota');
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

  async deleteAccount(id: string) {
    return expectData(await bridge().deleteAccount(id), 'Delete account');
  },

  async switchAccount(id: string) {
    return expectData(await bridge().switchAccount(id), 'Switch account');
  },

  async consumeResetCredit(id: string) {
    return expectData(await bridge().consumeResetCredit(id), 'Consume reset credit');
  },

  async refreshSubscription(id: string, force = true) {
    return expectData(await bridge().refreshSubscription(id, force), 'Refresh subscription');
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

  subscribe(events: {
    onDaemonTick?: () => void;
    onDaemonError?: (message: string) => void;
    onAutoSwitch?: (result: AutoSwitchResult) => void;
    onUpdateStatus?: (status: DesktopUpdateStatus) => void;
  }) {
    const api = getBridge();
    if (!api) return () => {};
    const cleanups = [
      api.onDaemonTick?.(() => events.onDaemonTick?.()),
      api.onDaemonError?.((payload) => events.onDaemonError?.(payload?.message || 'Daemon error')),
      api.onAutoSwitch?.((payload) => events.onAutoSwitch?.(payload)),
      api.onUpdateStatus?.((payload) => events.onUpdateStatus?.(payload)),
    ].filter(Boolean) as Array<() => void>;
    return () => cleanups.forEach((cleanup) => cleanup());
  },
};

import {
  AccountQuota,
  AutoSwitchRunResult,
  DesktopAppInfo,
  DesktopAutoSwitchConfig,
  DesktopAuthState,
  DesktopCodexStatus,
  DesktopOAuthStatus,
  DesktopUpdateStatus,
  LogEntry,
  StorageDiagnostic,
} from '../types';
import { toUserMessage } from './user-messages';

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
  banned?: boolean;
  probe?: {
    status?: string | null;
    error_code?: string | null;
    http_status?: number | null;
    checked_at?: string | number | null;
  } | null;
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
    banned?: boolean;
    gen?: number;
    error?: string;
  }>;
};

type DesktopFloatInspect = {
  exists: boolean;
  visible: boolean;
  alwaysOnTop: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  url?: string;
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
  showMainWindow: () => Promise<ApiResponse<boolean>>;
  showFloatWindow: () => Promise<ApiResponse<DesktopFloatInspect>>;
  hideFloatWindow: () => Promise<ApiResponse<boolean>>;
  setFloatAlwaysOnTop: (value: boolean) => Promise<ApiResponse<boolean>>;
  getFloatState: () => Promise<ApiResponse<{ visible: boolean; alwaysOnTop: boolean }>>;
  setFloatHeight: (height: number) => Promise<ApiResponse<boolean>>;
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
    banned?: boolean;
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

export const DEFAULT_SYNC_INTERVAL_MINUTES = 1;
export const CURRENT_QUOTA_AUTO_SYNC_STALE_MS = 60 * 1000;
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

const DASHBOARD_OPTIONAL_TIMEOUT_MS = 2500;

async function timedCapture<T>(
  task: () => Promise<ApiResponse<T>>,
  label: string,
  timeoutMs = DASHBOARD_OPTIONAL_TIMEOUT_MS,
): Promise<ApiResponse<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      captureResponse(task, label),
      new Promise<ApiResponse<T>>((resolve) => {
        timer = setTimeout(() => {
          resolve({ success: false, error: `${label} timed out` });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
    sync_interval_minutes: DEFAULT_SYNC_INTERVAL_MINUTES,
  };
}

function defaultDaemonStatus(): DesktopDaemonStatus {
  return { running: false, syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES };
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

function isBusyAuthMessage(message?: string): boolean {
  const text = String(message || '');
  return /timed out|busy/i.test(text);
}

function unverifiedAuthState(message?: string): DesktopAuthState {
  if (isBusyAuthMessage(message)) {
    return {
      status: 'unknown',
      requiresResolution: false,
      currentAccountId: null,
      matchedAccountId: null,
      officialIdentity: null,
      message: '正在确认官方登录，稍后会自动刷新',
    };
  }
  return {
    status: 'unknown',
    requiresResolution: true,
    currentAccountId: null,
    matchedAccountId: null,
    officialIdentity: null,
    message: message || '无法确认官方登录状态，自动同步已暂停',
  };
}

function defaultOAuthStatus(): DesktopOAuthStatus {
  return { status: 'idle', pending: false, message: null };
}

function clampSyncIntervalMinutes(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_SYNC_INTERVAL_MINUTES;
  return Math.min(60, Math.max(1, Math.round(number)));
}

export function quotaAutoSyncStaleMs(
  account: AccountQuota,
  syncIntervalMinutes?: number,
): number {
  if (!account.isCurrent) return QUOTA_AUTO_SYNC_STALE_MS;
  return Math.min(
    clampSyncIntervalMinutes(syncIntervalMinutes) * 60 * 1000,
    CURRENT_QUOTA_AUTO_SYNC_STALE_MS,
  );
}

function isAlertLogType(type: LogEntry['type'] | string): boolean {
  return type === 'warning' || type === 'error';
}

export function countUnreadAlertLogs(
  logs: Array<Pick<LogEntry, 'id' | 'type'>>,
  lastReadLogId?: string | null,
): number {
  let end = logs.length;
  if (lastReadLogId) {
    const index = logs.findIndex((log) => log.id === lastReadLogId);
    end = index < 0 ? logs.length : index;
  }
  let count = 0;
  for (let i = 0; i < end; i++) {
    if (isAlertLogType(logs[i].type)) count += 1;
  }
  return count;
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

export function quotaBarColor(remainingPercent: number | null | undefined): string {
  if (remainingPercent == null || !Number.isFinite(remainingPercent)) return 'bg-fill-3';
  if (remainingPercent < 25) return 'bg-danger';
  if (remainingPercent >= 55) return 'bg-ok';
  return 'bg-warn';
}

export function quotaTone(remainingPercent: number | null | undefined): 'ok' | 'warn' | 'danger' | 'muted' {
  if (remainingPercent == null || !Number.isFinite(remainingPercent)) return 'muted';
  if (remainingPercent < 25) return 'danger';
  if (remainingPercent >= 55) return 'ok';
  return 'warn';
}

export function quotaStroke(remainingPercent: number | null | undefined): string {
  const tone = quotaTone(remainingPercent);
  if (tone === 'ok') return '#30d158';
  if (tone === 'warn') return '#ff9f0a';
  if (tone === 'danger') return '#ff453a';
  return 'rgba(255, 255, 255, 0.14)';
}

export function quotaHero(account: AccountQuota | null | undefined): {
  percent: number | null;
  key: 'weekly' | 'fiveHour' | 'none';
  label: string;
} {
  if (!account) return { percent: null, key: 'none', label: '额度' };
  if (hideStaleQuota(account)) {
    return {
      percent: null,
      key: 'none',
      label: account.status === 'BANNED' ? '已封号' : '需重新授权后刷新',
    };
  }
  if (account.weeklyBlocksFiveHour && (account.weeklyQuotaRemaining === 0 || account.weeklyQuotaRemaining == null)) {
    return { percent: 0, key: 'weekly', label: '周额度' };
  }
  const candidates: Array<{ percent: number; key: 'weekly' | 'fiveHour'; label: string }> = [];
  if (account.fiveHourQuotaPresent !== false && account.fiveHourQuotaRemaining != null) {
    candidates.push({
      percent: account.fiveHourQuotaRemaining,
      key: 'fiveHour',
      label: '5 小时',
    });
  }
  if (account.weeklyQuotaPresent !== false && account.weeklyQuotaRemaining != null) {
    candidates.push({
      percent: account.weeklyQuotaRemaining,
      key: 'weekly',
      label: '周额度',
    });
  }
  if (candidates.length === 0) return { percent: null, key: 'none', label: '额度' };
  candidates.sort((left, right) => left.percent - right.percent);
  return candidates[0];
}

export function formatResetLine(value: string | number | null | undefined): string {
  const remain = formatReset(value);
  if (!value) return '';
  if (remain === '等待中' || remain === '未知') return remain;
  if (remain === '已过期') return '已重置';
  const clock = formatDateTime(value);
  if (clock && clock !== '未知') return `${remain}  ·  ${clock}`;
  return remain;
}

export function lastCheckCaption(lastChecked: string | null | undefined): string {
  const text = String(lastChecked || '').trim();
  if (!text || text === '尚未检查' || text === '未知') return '暂无检查记录';
  return `最近检查：${text}`;
}

export function formatDuration(seconds: unknown): string {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '未知';
  if (value <= 0) return '已过期';
  if (value < 3600) {
    const minutes = Math.max(1, Math.ceil(value / 60));
    return minutes >= 60 ? '1 小时' : `${minutes} 分钟`;
  }
  if (value < 86400) {
    const hours = Math.floor(value / 3600);
    const minutes = Math.ceil((value % 3600) / 60);
    if (minutes >= 60) return `${hours + 1} 小时`;
    if (minutes <= 0) return `${hours} 小时`;
    return `${hours} 小时 ${minutes} 分钟`;
  }
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  if (hours <= 0) return `${days} 天`;
  return `${days} 天 ${hours} 小时`;
}

function formatReset(value: string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return '等待中';
  const seconds = Math.floor((date.getTime() - Date.now()) / 1000);
  return formatDuration(seconds);
}

// Deterministic per-account avatar tint: low-saturation Apple system-color
// fills with a matching label, instead of loud gradients.
const AVATAR_GRADIENTS = [
  'bg-[#0a84ff]/18 text-[#6cb2ff]',
  'bg-[#bf5af2]/18 text-[#d29bf5]',
  'bg-[#30d158]/18 text-[#6fdd92]',
  'bg-[#ff9f0a]/18 text-[#ffbc57]',
  'bg-[#64d2ff]/18 text-[#9ce1ff]',
  'bg-[#ff375f]/18 text-[#ff7d97]',
  'bg-[#5e5ce6]/18 text-[#9c9af0]',
  'bg-[#66d4cf]/18 text-[#9de4e1]',
];

// Apple-style status presentation: a small colored dot plus quiet text
// instead of loud uppercase pills.
export const STATUS_DOT: Record<string, string> = {
  ACTIVE: 'bg-ok',
  READY: 'bg-teal',
  WARNING: 'bg-warn',
  LOW_QUOTA: 'bg-warn',
  SYNC_FAILED: 'bg-warn',
  LIMITED: 'bg-warn',
  EXPIRED: 'bg-danger',
  SUSPENDED: 'bg-danger',
  BANNED: 'bg-danger',
};

export const STATUS_TEXT: Record<string, string> = {
  ACTIVE: '活跃',
  READY: '就绪',
  WARNING: '注意',
  LOW_QUOTA: '额度偏低',
  SYNC_FAILED: '同步失败',
  LIMITED: '额度限流',
  EXPIRED: '已耗尽',
  SUSPENDED: '需重新授权',
  BANNED: '已封号',
};

export function needsHandling(account: Pick<AccountQuota, 'status'>): boolean {
  return account.status === 'SUSPENDED'
    || account.status === 'EXPIRED'
    || account.status === 'SYNC_FAILED'
    || account.status === 'BANNED'
    || account.status === 'LIMITED';
}

export function avatarGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

function planForUi(planType: string | null | undefined): AccountQuota['plan'] {
  const value = String(planType || '').toLowerCase().trim();
  if (value.includes('enterprise') || value.includes('team') || value.includes('business')) return 'Enterprise';
  if (value.includes('plus')) return 'Plus';
  if (value.includes('pro')) return 'Pro';
  if (value === 'go') return 'Go';
  return 'Standard';
}

export function planLabel(plan: AccountQuota['plan'] | string | null | undefined): string {
  const name = String(plan || '').trim();
  if (!name) return 'Plan';
  return name.endsWith(' Plan') ? name : `${name} Plan`;
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
  if (account.banned || account.probe?.status === 'banned') return 'BANNED';
  if (account.requires_reauth) return 'SUSPENDED';
  const tokenUnusable = (account.token_status?.expired || account.token_status?.accessAvailable === false)
    && account.token_status?.refreshAvailable === false;
  if (tokenUnusable) return 'SUSPENDED';
  const probeStatus = String(account.probe?.status || '');
  const errorCode = String(account.quota_error?.code || account.probe?.error_code || '').toLowerCase();
  if (
    probeStatus === 'usage_limited'
    || errorCode === 'usage_limit_reached'
    || errorCode === 'rate_limit'
    || errorCode === 'rate_limit_exceeded'
    || errorCode === 'http_429'
  ) {
    return 'LIMITED';
  }
  if (account.quota_error) return 'SYNC_FAILED';
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

export const ACCESS_REJECTED_CODES = new Set([
  'invalid_token',
  'token_invalidated',
  'token_revoked',
  'invalid_grant',
]);

export function leftoverAccessRejected(account: {
  probe?: { status?: string | null; error_code?: string | null; http_status?: number | null } | null;
}): boolean {
  const probe = account.probe;
  if (!probe || probe.status === 'banned') return false;
  const httpStatus = Number(probe.http_status || 0);
  if (httpStatus !== 401 && httpStatus !== 403) return false;
  return ACCESS_REJECTED_CODES.has(String(probe.error_code || '').toLowerCase());
}

function leftoverAccessUsableFor(account: DesktopAccount, tokenStatus: DesktopAccount['token_status']): boolean {
  return !!tokenStatus?.accessAvailable
    && !tokenStatus?.expired
    && !leftoverAccessRejected(account);
}

export function canRefreshQuota(account: Pick<AccountQuota, 'status' | 'leftoverAccessUsable' | 'tokenExpired' | 'tokenAccessAvailable' | 'tokenRefreshAvailable'>): boolean {
  if (account.status === 'BANNED' || account.status === 'SUSPENDED') return !!account.leftoverAccessUsable;
  if ((account.tokenExpired || account.tokenAccessAvailable === false) && account.tokenRefreshAvailable === false) return false;
  return true;
}

export function canJoinAutoSwitch(account: Pick<AccountQuota, 'status'>): boolean {
  return account.status !== 'BANNED' && account.status !== 'SUSPENDED';
}

export function canSwitchAccount(account: Pick<AccountQuota, 'status'>): boolean {
  return canJoinAutoSwitch(account);
}

export function pruneAutoSwitchAccountIds(ids: string[], accounts: AccountQuota[]): string[] {
  const allowed = new Set(accounts.filter(canJoinAutoSwitch).map((account) => account.id));
  return ids.filter((id) => allowed.has(id));
}

export function selectedAccountIdsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

export function summarizeRefreshAllResults(results: Array<{
  skipped?: boolean;
  banned?: boolean;
  error?: string;
  reason?: string;
}> = []): {
  refreshed: number;
  reauthSkipped: number;
  bannedSkipped: number;
  failed: number;
} {
  let refreshed = 0;
  let reauthSkipped = 0;
  let bannedSkipped = 0;
  let failed = 0;
  for (const item of results) {
    if (item.reason === 'account_banned' || (item.skipped && item.banned) || (item.error && item.banned)) {
      bannedSkipped += 1;
      continue;
    }
    if (item.reason === 'reauthorization_required' || item.skipped) {
      reauthSkipped += 1;
      continue;
    }
    if (item.error) {
      failed += 1;
      continue;
    }
    refreshed += 1;
  }
  return { refreshed, reauthSkipped, bannedSkipped, failed };
}

export function summarizeTokenCheckResults(results: Array<{
  ok?: boolean;
  skipped?: boolean;
  banned?: boolean;
  reauthRequired?: boolean;
  error?: string;
}> = []): {
  passed: number;
  reauthSkipped: number;
  bannedSkipped: number;
  failed: number;
} {
  let passed = 0;
  let reauthSkipped = 0;
  let bannedSkipped = 0;
  let failed = 0;
  for (const item of results) {
    if (item.banned) {
      bannedSkipped += 1;
      continue;
    }
    if (item.reauthRequired || (!item.ok && item.skipped)) {
      reauthSkipped += 1;
      continue;
    }
    if (!item.ok) {
      failed += 1;
      continue;
    }
    passed += 1;
  }
  return { passed, reauthSkipped, bannedSkipped, failed };
}

function warningForUi(account: DesktopAccount, status: AccountQuota['status'], quotaError: string | null): string | null {
  if (status === 'BANNED') return '账号已封号，无法继续使用。';
  if (status === 'LIMITED') return '额度已达上限或触发限流。';
  if (status === 'SYNC_FAILED') {
    if (quotaError && quotaError.includes('额度暂时没刷到')) return quotaError;
    return '额度同步失败，请稍后重试。';
  }
  if (status === 'SUSPENDED') return '该账号需要重新授权后才能使用。';
  if (account.reauth_reason) return toUserMessage(account.reauth_reason);
  return quotaError;
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
  const quotaError = account.quota_error?.message || account.quota_error?.code
    ? toUserMessage(account.quota_error?.message || account.quota_error?.code)
    : null;
  const status = statusForUi(account, config);
  const tokenStatus = account.token_status || {};
  const leftoverUsable = leftoverAccessUsableFor(account, tokenStatus);
  const leftoverRejected = !leftoverUsable
    && !!tokenStatus.accessAvailable
    && !tokenStatus.expired
    && (!!account.requires_reauth || !!account.banned || status === 'SUSPENDED' || status === 'BANNED');
  const expirySeconds = typeof tokenStatus.expiryDate === 'number' ? tokenStatus.expiryDate : null;
  const issuedSeconds = typeof tokenStatus.issuedAt === 'number' ? tokenStatus.issuedAt : null;
  let tokenValidityPct: number | null = null;
  if (tokenStatus.expired || leftoverRejected) {
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
    status,
    fiveHourQuotaRemaining: hourlyPresent ? hourlyRemaining : null,
    fiveHourQuotaTotal: 100,
    weeklyQuotaRemaining: weeklyPresent ? weeklyRemaining : null,
    weeklyQuotaTotal: 100,
    fiveHourQuotaPresent: hourlyPresent,
    weeklyQuotaPresent: weeklyPresent,
    weeklyBlocksFiveHour: !!account.quota?.weekly_blocks_hourly,
    priority: priorityForUi(account),
    plan: planForUi(account.plan_type || account.quota?.plan_type),
    tokenValidity: tokenStatus.expired ? '已过期' : leftoverRejected ? '已失效' : `剩余 ${formatDuration(tokenStatus.timeLeft)}`,
    tokenValidityPct,
    resetInFiveHour: formatReset(account.quota?.hourly_reset_time),
    resetInWeekly: formatReset(account.quota?.weekly_reset_time),
    fiveHourResetAt: account.quota?.hourly_reset_time ?? null,
    weeklyResetAt: account.quota?.weekly_reset_time ?? null,
    warning: warningForUi(account, status, quotaError),
    isCurrent: !!currentAccount && currentAccount.id === account.id,
    quotaUpdatedAt: account.usage_updated_at,
    quotaNextRetryAt: account.quota_next_retry_at,
    quotaError,
    tokenExpired: !!tokenStatus.expired,
    tokenAccessAvailable: !!tokenStatus.accessAvailable,
    tokenRefreshAvailable: !!tokenStatus.refreshAvailable,
    leftoverAccessUsable: leftoverUsable,
  };
}

export function isCurrentQuotaSufficient(
  account: AccountQuota | null | undefined,
  fiveHourThreshold: number,
  weeklyThreshold: number,
): boolean {
  if (!account) return false;
  if (account.status === 'BANNED' || account.status === 'SUSPENDED' || account.status === 'SYNC_FAILED' || account.status === 'LIMITED') {
    return false;
  }
  const hourlyPresent = account.fiveHourQuotaPresent !== false;
  const weeklyPresent = account.weeklyQuotaPresent !== false;
  const hourly = hourlyPresent && account.fiveHourQuotaRemaining != null
    ? Number(account.fiveHourQuotaRemaining)
    : null;
  const weekly = weeklyPresent && account.weeklyQuotaRemaining != null
    ? Number(account.weeklyQuotaRemaining)
    : null;
  if (hourly == null && weekly == null) return false;
  if (hourly != null && Number.isFinite(hourly) && hourly <= fiveHourThreshold) return false;
  if (weekly != null && Number.isFinite(weekly) && weekly <= weeklyThreshold) return false;
  return true;
}

export function autoSwitchStatusBanner(options: {
  hasCurrentAccount: boolean;
  quotaSufficient: boolean;
  globalSwitch: boolean;
  daemonRunning: boolean;
  pausedReason?: string | null;
  currentStatus?: AccountQuota['status'] | null;
}): { title: string; detail: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (!options.hasCurrentAccount) {
    return {
      title: '未选定当前账号',
      detail: '请先在账号管理中指定当前账号。',
      tone: 'neutral',
    };
  }
  if (!options.globalSwitch) {
    return {
      title: '自动切号未启用',
      detail: '全局开关已关闭。启用开关并启动 Daemon 后，将在额度低于阈值时切换账号。',
      tone: 'neutral',
    };
  }
  if (!options.daemonRunning) {
    return {
      title: '自动切号未运行',
      detail: '全局开关已启用，但 Daemon 已停止，不会自动切换账号。',
      tone: 'warn',
    };
  }
  const paused = String(options.pausedReason || '').trim();
  if (paused) {
    return {
      title: '自动切号已暂停',
      detail: /[。.!！]$/.test(paused) ? paused : `${paused}。`,
      tone: 'warn',
    };
  }
  if (options.currentStatus === 'BANNED') {
    return {
      title: '当前账号已封号',
      detail: '账号已封号，无法继续使用，将切换到其他可用账号。',
      tone: 'warn',
    };
  }
  if (options.currentStatus === 'SUSPENDED') {
    return {
      title: '当前账号需要重新授权',
      detail: '当前账号无法继续使用，将切换到其他可用账号。',
      tone: 'warn',
    };
  }
  if (options.currentStatus === 'LIMITED') {
    return {
      title: '当前账号额度限流',
      detail: '额度已达上限或触发限流，将切换到其他可用账号。',
      tone: 'warn',
    };
  }
  if (options.currentStatus === 'SYNC_FAILED') {
    return {
      title: '当前账号同步失败',
      detail: '额度同步失败，查清后再判断是否切号。',
      tone: 'warn',
    };
  }
  if (options.quotaSufficient) {
    return {
      title: '额度充足，暂不切换',
      detail: '自动切号已启用。额度低于阈值后将自动切换账号。',
      tone: 'ok',
    };
  }
  return {
    title: '当前额度偏低',
    detail: '自动切号已启用，将在下次检查时尝试切换账号。',
    tone: 'warn',
  };
}

export function hideStaleQuota(account: Pick<AccountQuota, 'status' | 'leftoverAccessUsable'> | null | undefined): boolean {
  if (!account) return false;
  if (account.status !== 'SUSPENDED' && account.status !== 'BANNED') return false;
  return account.leftoverAccessUsable !== true;
}

export function quotaSummaryPercent(text: string): number | null {
  const match = /^(\d+)%$/.exec(String(text || '').trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function quotaWindowSummary(
  window: 'fiveHour' | 'weekly',
  account: AccountQuota,
): { label: string; text: string } {
  const label = window === 'fiveHour' ? '5 小时' : '周额度';
  if (hideStaleQuota(account)) {
    return {
      label,
      text: account.status === 'BANNED' ? '已封号' : '需重新授权后刷新',
    };
  }
  if (account.status === 'LIMITED') {
    return { label, text: '额度限流' };
  }
  if (window === 'fiveHour' && account.weeklyBlocksFiveHour) {
    return { label, text: '周额度已用尽' };
  }
  const present = window === 'fiveHour' ? account.fiveHourQuotaPresent !== false : account.weeklyQuotaPresent !== false;
  const remaining = window === 'fiveHour' ? account.fiveHourQuotaRemaining : account.weeklyQuotaRemaining;
  const total = window === 'fiveHour' ? account.fiveHourQuotaTotal : account.weeklyQuotaTotal;
  if (account.quotaError && remaining == null) {
    return { label, text: '同步失败' };
  }
  if (!present || remaining == null) {
    return { label, text: '上游暂未提供' };
  }
  const pct = total > 0 ? Math.round((Number(remaining) / total) * 100) : Math.round(Number(remaining));
  if (!Number.isFinite(pct)) return { label, text: '暂无数据' };
  if (pct <= 0) return { label, text: '已用尽' };
  return { label, text: `${pct}%` };
}

export function quotaScopeCaption(account: AccountQuota): {
  shared: string | null;
  rows: Array<{ label: string; text: string }>;
} {
  const fiveHour = quotaWindowSummary('fiveHour', account);
  const weekly = quotaWindowSummary('weekly', account);
  const sameReason = fiveHour.text === weekly.text && !/^\d+%$/.test(fiveHour.text);
  if (sameReason) {
    return { shared: fiveHour.text, rows: [] };
  }
  return { shared: null, rows: [fiveHour, weekly] };
}

export function needsQuotaAutoSync(account: AccountQuota, staleMs = QUOTA_AUTO_SYNC_STALE_MS): boolean {
  if (!canRefreshQuota(account)) return false;
  const retryAt = toDate(account.quotaNextRetryAt);
  if (retryAt && retryAt.getTime() > Date.now()) return false;
  const leftoverKnown = !!account.leftoverAccessUsable
    && (account.status === 'SUSPENDED' || account.status === 'BANNED')
    && !!account.quotaUpdatedAt;
  if (!account.quotaUpdatedAt || (account.quotaError && !leftoverKnown)) return true;
  const date = toDate(account.quotaUpdatedAt);
  if (!date) return true;
  return Date.now() - date.getTime() > staleMs;
}

export const desktopApi = {
  async getAppInfo() {
    return expectData(await bridge().getAppInfo(), 'Read app info');
  },

  async loadDashboardState(): Promise<DashboardState> {
    const api = bridge();
    // Local account files must not wait on Codex detection, GitHub updates,
    // or inspectAuthState queued behind a daemon quota refresh (which can
    // sit on chatgpt.com for more than a minute and freeze first paint).
    const [
      accountsResponse,
      currentResponse,
      daemonResponse,
      configResponse,
      appResponse,
      oauthStatusResponse,
    ] = await Promise.all([
      captureResponse(() => api.listAccounts(), 'Read accounts'),
      captureResponse(() => api.getCurrentAccount(), 'Read current account'),
      captureResponse(() => api.getDaemonStatus(), 'Read daemon status'),
      captureResponse(() => api.getAutoSwitchConfig(), 'Read auto-switch config'),
      captureResponse(() => api.getAppInfo(), 'Read app info'),
      captureResponse(() => api.getOAuthStatus(), 'Read OAuth status'),
    ]);
    const [
      authStateResponse,
      updateResponse,
      diagnosticsResponse,
      codexResponse,
    ] = await Promise.all([
      timedCapture(() => api.getAuthState(), 'Read authentication state'),
      timedCapture(() => api.getUpdateStatus(), 'Read update status'),
      timedCapture(() => api.getStorageDiagnostics(), 'Read storage diagnostics'),
      timedCapture(() => api.getCodexStatus(), 'Read Codex status'),
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

  async loadFloatAccounts() {
    const api = bridge();
    const [accountsResponse, currentResponse, configResponse] = await Promise.all([
      captureResponse(() => api.listAccounts(), 'Read accounts'),
      captureResponse(() => api.getCurrentAccount(), 'Read current account'),
      captureResponse(() => api.getAutoSwitchConfig(), 'Read auto-switch config'),
    ]);
    const config = optionalData(configResponse, defaultConfig()) || defaultConfig();
    const rawAccounts = expectData(accountsResponse, 'Read accounts') || [];
    const currentAccount = optionalData(currentResponse, null);
    return {
      accounts: rawAccounts.map((account) => mapAccountForUi(account, currentAccount, config)),
      currentAccount,
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

  async showMainWindow() {
    return expectData(await bridge().showMainWindow(), 'Show main window');
  },

  async showFloatWindow() {
    return expectData(await bridge().showFloatWindow(), 'Show float window');
  },

  async hideFloatWindow() {
    return expectData(await bridge().hideFloatWindow(), 'Hide float window');
  },

  async setFloatAlwaysOnTop(value: boolean) {
    return expectData(await bridge().setFloatAlwaysOnTop(value), 'Set float always on top');
  },

  async getFloatState() {
    return expectData(await bridge().getFloatState(), 'Read float state');
  },

  async setFloatHeight(height: number) {
    return expectData(await bridge().setFloatHeight(height), 'Resize float window');
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

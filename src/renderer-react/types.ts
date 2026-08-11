export interface AccountQuota {
  id: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'WARNING' | 'EXPIRED' | 'LOW_QUOTA' | 'READY' | 'SUSPENDED';
  fiveHourQuotaRemaining: number | null;
  fiveHourQuotaTotal: number;
  weeklyQuotaRemaining: number | null;
  weeklyQuotaTotal: number;
  fiveHourQuotaPresent?: boolean;
  weeklyQuotaPresent?: boolean;
  weeklyBlocksFiveHour?: boolean;
  priority: 'High' | 'Normal' | 'Low' | 'Ultra';
  plan: 'Pro Plan' | 'Standard' | 'Enterprise';
  tokenValidity: string;
  tokenValidityPct?: number | null;
  resetInFiveHour: string;
  resetInWeekly: string;
  warning?: string | null;
  isCurrent?: boolean;
  quotaUpdatedAt?: string | number | null;
  quotaNextRetryAt?: string | number | null;
  quotaError?: string | null;
  tokenExpired?: boolean;
  tokenAccessAvailable?: boolean;
  tokenRefreshAvailable?: boolean;
}

export interface DaemonState {
  status: 'Running' | 'Stopped';
  syncInterval: number;
  lastChecked: string;
  lastSuccessAt?: string | number | null;
  lastError?: string | null;
  pausedReason?: string | null;
}

export interface DesktopAuthState {
  status: 'aligned' | 'conflict' | 'unmanaged_official_auth' | 'missing_official_auth' | 'unsupported_official_auth' | 'empty' | 'unknown';
  requiresResolution: boolean;
  currentAccountId?: string | null;
  matchedAccountId?: string | null;
  officialIdentity?: { email?: string | null; accountId?: string | null } | null;
  message?: string | null;
}

export interface DesktopOAuthStatus {
  status: string;
  pending?: boolean;
  message?: string | null;
  targetAccountId?: string | null;
  expiresAt?: number | null;
  callbackPort?: number;
  result?: {
    accountId?: string;
    email?: string;
    mismatch?: boolean;
    targetAccountId?: string | null;
  } | null;
}

export interface StorageDiagnostic {
  type: string;
  filePath: string;
  message: string;
  recovered: boolean;
  timestamp: number;
}

export interface SystemSettings {
  globalSwitch: boolean;
  fiveHourThreshold: number;
  weeklyThreshold: number;
  clientDetected: boolean;
  updateChannel: 'Beta Channel' | 'Stable Channel' | 'Developer Channel';
  version: string;
  latestStatus: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: 'success' | 'warning' | 'error' | 'info';
}

export interface DesktopAutoSwitchConfig {
  enabled: boolean;
  primary_threshold: number;
  secondary_threshold: number;
  account_scope_mode: 'all' | 'selected';
  selected_account_ids: string[];
  sync_interval_minutes?: number;
}

export interface AutoSwitchRunResult {
  switched?: boolean;
  reason?: string;
  error?: string | null;
  from?: { email?: string | null } | null;
  to?: { email?: string | null } | null;
}

export interface DesktopAppInfo {
  name: string;
  version: string;
  releaseChannel?: string;
  repository?: string;
  updateEnabled?: boolean;
}

export interface DesktopCodexStatus {
  installed?: boolean;
  appId?: string;
  source?: string;
  message?: string;
}

export interface DesktopUpdateStatus {
  status?: string;
  enabled?: boolean;
  channel?: string;
  message?: string;
  error?: string;
}

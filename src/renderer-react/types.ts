export interface AccountQuota {
  id: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'WARNING' | 'EXPIRED' | 'LOW_QUOTA' | 'READY' | 'SUSPENDED';
  fiveHourQuotaUsed: number;
  fiveHourQuotaTotal: number;
  weeklyQuotaUsed: number;
  weeklyQuotaTotal: number;
  priority: 'High' | 'Normal' | 'Low' | 'Ultra';
  plan: 'Pro Plan' | 'Standard' | 'Enterprise';
  tokenValidity: string;
  resetInFiveHour: string;
  resetInWeekly: string;
  warning?: string | null;
  isCurrent?: boolean;
  quotaUpdatedAt?: string | number | null;
  subscriptionActiveUntil?: string | number | null;
  resetCreditsAvailable?: number;
  resetCreditsNextExpiresAt?: string | number | null;
  quotaError?: string | null;
  tokenExpired?: boolean;
  tokenAccessAvailable?: boolean;
  tokenRefreshAvailable?: boolean;
}

export interface DaemonState {
  status: 'Running' | 'Stopped';
  syncInterval: number;
  lastChecked: string;
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

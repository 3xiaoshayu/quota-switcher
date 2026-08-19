export type ProductKind = 'codex' | 'cursor' | 'antigravity';
export type ManagedProductKind = 'cursor' | 'antigravity';

export interface AccountQuota {
  id: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'WARNING' | 'EXPIRED' | 'LOW_QUOTA' | 'READY' | 'SUSPENDED' | 'SYNC_FAILED' | 'BANNED' | 'LIMITED';
  quotaKind?: ProductKind;
  fiveHourQuotaRemaining: number | null;
  fiveHourQuotaTotal: number;
  weeklyQuotaRemaining: number | null;
  weeklyQuotaTotal: number;
  fiveHourQuotaPresent?: boolean;
  weeklyQuotaPresent?: boolean;
  weeklyBlocksFiveHour?: boolean;
  cursorPlanRemaining?: number | null;
  cursorAutoRemaining?: number | null;
  cursorApiRemaining?: number | null;
  agCreditsRemaining?: number | null;
  agCreditsLimit?: number | null;
  agTier?: string | null;
  agPrimaryModel?: string | null;
  agPrimaryRemaining?: number | null;
  agSecondaryModel?: string | null;
  agSecondaryRemaining?: number | null;
  agGeminiWeeklyRemaining?: number | null;
  agGeminiWeeklyResetAt?: string | number | null;
  agGeminiFiveHourRemaining?: number | null;
  agGeminiFiveHourResetAt?: string | number | null;
  agThirdPartyWeeklyRemaining?: number | null;
  agThirdPartyWeeklyResetAt?: string | number | null;
  agThirdPartyFiveHourRemaining?: number | null;
  agThirdPartyFiveHourResetAt?: string | number | null;
  priority: 'High' | 'Normal' | 'Low' | 'Ultra';
  plan: 'Plus' | 'Pro' | 'Go' | 'Standard' | 'Enterprise' | 'Team' | 'Free' | 'Ultra';
  tokenValidity: string;
  tokenValidityPct?: number | null;
  resetInFiveHour: string;
  resetInWeekly: string;
  fiveHourResetAt?: string | number | null;
  weeklyResetAt?: string | number | null;
  warning?: string | null;
  isCurrent?: boolean;
  quotaUpdatedAt?: string | number | null;
  quotaNextRetryAt?: string | number | null;
  quotaError?: string | null;
  tokenExpired?: boolean;
  tokenAccessAvailable?: boolean;
  tokenRefreshAvailable?: boolean;
  leftoverAccessUsable?: boolean;
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
    updated?: boolean;
    targetAccountId?: string | null;
    switched?: boolean;
    switchError?: string | null;
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
  cursorDetected?: boolean;
  cursorHasLocalLogin?: boolean;
  antigravityDetected?: boolean;
  antigravityHasLocalLogin?: boolean;
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

export interface DesktopCursorStatus {
  installed?: boolean;
  exePath?: string | null;
  vscdbPath?: string | null;
  vscdbPresent?: boolean;
  source?: string;
  message?: string;
}

export interface DesktopAntigravityStatus {
  installed?: boolean;
  exePath?: string | null;
  vscdbPath?: string | null;
  vscdbPresent?: boolean;
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

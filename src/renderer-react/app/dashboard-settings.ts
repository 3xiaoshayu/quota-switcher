import { INITIAL_SETTINGS } from '../data/mockData';
import type {
  DesktopAntigravityStatus,
  DesktopAppInfo,
  DesktopCodexStatus,
  DesktopCursorStatus,
  DesktopOfficialFormat,
  DesktopUpdateStatus,
  ProductKind,
  SystemSettings,
} from '../types';

// Collects the products whose official login format drifted, keyed by product
// with the main process's explanation, for the Settings detection card.
export function formatDriftFrom(statuses: {
  codex?: { officialFormat?: DesktopOfficialFormat } | null;
  cursor?: { officialFormat?: DesktopOfficialFormat } | null;
  antigravity?: { officialFormat?: DesktopOfficialFormat } | null;
}): Partial<Record<ProductKind, string>> {
  const drift: Partial<Record<ProductKind, string>> = {};
  for (const product of ['codex', 'cursor', 'antigravity'] as ProductKind[]) {
    const format = statuses[product]?.officialFormat;
    if (format?.status === 'drift') {
      drift[product] = format.detail || '官方登录格式变了，本管理器还不认识';
    }
  }
  return drift;
}

export function updateChannelForUi(status: DesktopUpdateStatus | null): SystemSettings['updateChannel'] {
  const channel = String(status?.channel || '').toLowerCase();
  if (channel.includes('dev')) return 'Developer Channel';
  if (channel.includes('stable')) return 'Stable Channel';
  return 'Beta Channel';
}

export function latestStatusForUi(status: DesktopUpdateStatus | null): string {
  if (!status) return '未知';
  if (status.status === 'error') return status.error || '检查更新失败';
  if (status.status === 'downloaded') return '可安装';
  if (status.status === 'checking') return '检查中';
  if (status.status === 'disabled') return status.message || '更新已禁用';
  return status.message || '已是最新';
}

export function settingsFromDesktopState(
  appInfo: DesktopAppInfo | null,
  codexStatus: DesktopCodexStatus | null,
  updateStatus: DesktopUpdateStatus | null,
  cursorStatus: DesktopCursorStatus | null = null,
  antigravityStatus: DesktopAntigravityStatus | null = null,
): SystemSettings {
  return {
    clientDetected: !!codexStatus?.installed,
    cursorDetected: !!cursorStatus?.installed,
    cursorHasLocalLogin: !!cursorStatus?.vscdbPresent,
    antigravityDetected: !!antigravityStatus?.installed,
    antigravityHasLocalLogin: !!antigravityStatus?.vscdbPresent,
    updateChannel: updateChannelForUi(updateStatus),
    version: appInfo?.version || INITIAL_SETTINGS.version,
    latestStatus: latestStatusForUi(updateStatus),
  };
}

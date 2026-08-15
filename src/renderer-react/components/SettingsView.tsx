import { useState } from 'react';
import { motion } from 'motion/react';
import { 
  Server, 
  Key, 
  Monitor, 
  Download, 
  Play, 
  Square, 
  CheckCircle, 
  AlertCircle,
  RotateCw, 
  ShieldCheck, 
  Github, 
  Activity,
  Zap,
  FolderOpen,
  Gauge
} from 'lucide-react';
import { SystemSettings, DaemonState } from '../types';

interface SettingsProps {
  settings: SystemSettings;
  daemonState: DaemonState;
  onToggleDaemon: () => void | Promise<void>;
  onPreviewSyncInterval: (interval: number) => void;
  onUpdateSyncInterval: (interval: number) => void;
  onAddLog: (msg: string, type: 'success' | 'info' | 'warning' | 'error') => void;
  onBatchVerifyTokens?: () => Promise<void>;
  onDetectClient?: () => Promise<void>;
  onCheckUpdates?: () => Promise<void>;
  onInstallUpdate?: () => Promise<void>;
  canInstallUpdate?: boolean;
  updateEnabled?: boolean;
  accountCount?: number;
  repositoryUrl?: string;
  onOpenLogs?: () => Promise<void>;
  onShowFloatWindow?: () => Promise<void>;
}

export default function SettingsView({
  settings,
  daemonState,
  onToggleDaemon,
  onPreviewSyncInterval,
  onUpdateSyncInterval,
  onAddLog,
  onBatchVerifyTokens,
  onDetectClient,
  onCheckUpdates,
  onInstallUpdate,
  canInstallUpdate = false,
  updateEnabled = false,
  accountCount = 128,
  repositoryUrl = 'https://github.com',
  onOpenLogs,
  onShowFloatWindow,
}: SettingsProps) {
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isVerifyingTokens, setIsVerifyingTokens] = useState(false);
  const [isDetectingClient, setIsDetectingClient] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [isTogglingDaemon, setIsTogglingDaemon] = useState(false);

  const handleToggleDaemon = async () => {
    if (isTogglingDaemon) return;
    setIsTogglingDaemon(true);
    try {
      await onToggleDaemon();
    } catch (error) {
      onAddLog(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setIsTogglingDaemon(false);
    }
  };

  const handleBatchVerify = async () => {
    if (isVerifyingTokens) return;
    setIsVerifyingTokens(true);
    onAddLog('正在检查各账号令牌...', 'info');
    try {
      if (onBatchVerifyTokens) {
        await onBatchVerifyTokens();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        onAddLog(`令牌检查完成，共 ${accountCount} 个账号。`, 'success');
      }
    } catch (error) {
      onAddLog(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setIsVerifyingTokens(false);
    }
  };

  const handleDetectClient = () => {
    if (onDetectClient) {
      setIsDetectingClient(true);
      onAddLog('正在检测官方 Codex...', 'info');
      onDetectClient()
        .then(() => onAddLog('官方 Codex 检测已更新。', 'success'))
        .catch((error) => onAddLog(error instanceof Error ? error.message : String(error), 'error'))
        .finally(() => setIsDetectingClient(false));
      return;
    }

    setIsDetectingClient(true);
    onAddLog('正在检测官方 Codex...', 'info');
    setTimeout(() => {
      setIsDetectingClient(false);
      onAddLog('已检测到官方 Codex。', 'success');
    }, 1200);
  };

  const handleCheckUpdates = () => {
    if (onCheckUpdates) {
      setIsCheckingUpdates(true);
      onAddLog('正在检查更新...', 'info');
      onCheckUpdates()
        .catch((error) => onAddLog(error instanceof Error ? error.message : String(error), 'error'))
        .finally(() => setIsCheckingUpdates(false));
      return;
    }

    setIsCheckingUpdates(true);
    onAddLog('正在检查更新...', 'info');
    setTimeout(() => {
      setIsCheckingUpdates(false);
      onAddLog('当前已是最新版本。', 'success');
    }, 1500);
  };

  const handleInstallUpdate = () => {
    if (!onInstallUpdate) return;
    setIsInstallingUpdate(true);
    onAddLog('正在安装更新并重启应用...', 'info');
    onInstallUpdate()
      .catch((error) => onAddLog(error instanceof Error ? error.message : String(error), 'error'))
      .finally(() => setIsInstallingUpdate(false));
  };

  const latestStatusText = settings.latestStatus || '未知';
  const latestStatusFailed = /失败|错误/.test(latestStatusText);
  const latestStatusBusy = /检查中/.test(latestStatusText);
  const latestStatusMuted = /未知|禁用|手动/.test(latestStatusText);
  const LatestStatusIcon = latestStatusFailed ? AlertCircle : latestStatusBusy ? Activity : CheckCircle;
  const latestStatusIconClass = latestStatusFailed
    ? 'text-danger'
    : latestStatusBusy
      ? 'text-accent'
      : latestStatusMuted
        ? 'text-label-3'
        : 'text-ok';

  return (
    <div className="flex-1 p-8 overflow-y-auto select-none" id="settings-view-container">
      {/* Page Title block */}
      <div className="flex flex-col mb-8 select-none" id="settings-title-group">
        <h2 className="text-[28px] font-bold tracking-tight text-label font-sans">
          设置
        </h2>
        <p className="text-[13px] text-label-2 mt-1.5 font-sans">
          管理 Codex 系统运行参数及账户同步配置
        </p>
      </div>

      <div className="flex flex-col gap-6" id="settings-cards-grid">
          <div className="glass-card rounded-2xl p-6 flex flex-col" id="card-daemon-settings">
            {/* Daemon Card Header */}
            <div className="flex items-start justify-between pb-5 border-b border-sep" id="daemon-header">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-[10px] bg-accent/15 flex items-center justify-center text-accent">
                  <Server className="w-4 h-4" />
                </div>
                <div className="flex flex-col text-left">
                  <h3 className="font-bold text-label text-sm tracking-wide font-sans">Daemon 服务</h3>
                  <span className="text-[11px] text-label-2 mt-0.5">定期续登录，并检查是否切号</span>
                </div>
              </div>

              {/* Toggle service trigger */}
              <motion.button
                onClick={handleToggleDaemon}
                disabled={isTogglingDaemon}
                aria-busy={isTogglingDaemon}
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.95 }}
                transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-[10px] text-[13px] font-medium transition-colors cursor-pointer ${
                  daemonState.status === 'Running' 
                    ? 'bg-danger/12 hover:bg-danger/20 text-danger' 
                    : 'bg-ok/12 hover:bg-ok/20 text-ok'
                }`}
                id="btn-toggle-daemon"
              >
                {daemonState.status === 'Running' ? (
                  <>
                    <Square className={`w-3 h-3 fill-danger ${isTogglingDaemon ? 'animate-pulse' : ''}`} />
                    {isTogglingDaemon ? '停止中...' : '停止服务'}
                  </>
                ) : (
                  <>
                    <Play className={`w-3 h-3 fill-ok ${isTogglingDaemon ? 'animate-pulse' : ''}`} />
                    {isTogglingDaemon ? '启动中...' : '启动服务'}
                  </>
                )}
              </motion.button>
            </div>

            {/* Slider and status display */}
            <div className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-6 items-center" id="daemon-body">
              {/* Status display */}
              <div className="space-y-1 text-left" id="daemon-status-box">
                <span className="text-[12px] font-medium text-label-3">当前状态</span>
                <div className="flex items-center gap-2 pt-1">
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    daemonState.status === 'Running' ? 'bg-ok' : 'bg-danger'
                  }`} />
                  <span className="font-medium text-sm text-label">{daemonState.status === 'Running' ? '运行中' : '已停止'}</span>
                </div>
                {daemonState.status === 'Running' && daemonState.pausedReason && (
                  <span className="block text-[10px] text-warn">已暂停：{daemonState.pausedReason}</span>
                )}
                {daemonState.status !== 'Running' && settings.globalSwitch && (
                  <span className="block text-[10px] text-warn">自动切号已启用，但 Daemon 已停止</span>
                )}
                {daemonState.lastError && (
                  <span className="block max-w-xs truncate text-[10px] text-danger" title={daemonState.lastError}>
                    最近检查：{daemonState.lastError}
                  </span>
                )}
              </div>

              {/* Sync Interval Slider */}
              <div className="space-y-2 text-left" id="daemon-interval-box">
                <div className="flex items-center justify-between text-[12px] font-medium" id="daemon-interval-labels">
                  <span className="text-label-3">检查间隔</span>
                  <span className="text-accent font-bold tabular-nums text-xs">{daemonState.syncInterval} 分钟</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="60"
                  value={daemonState.syncInterval}
                  onChange={(e) => onPreviewSyncInterval(Number(e.target.value))}
                  onPointerUp={(e) => onUpdateSyncInterval(Number(e.currentTarget.value))}
                  onKeyUp={(e) => onUpdateSyncInterval(Number(e.currentTarget.value))}
                  onBlur={(e) => onUpdateSyncInterval(Number(e.currentTarget.value))}
                  className="w-full h-1 bg-fill-2 rounded-lg appearance-none cursor-pointer accent-accent outline-none"
                  id="sync-interval-slider"
                />
                <p className="text-[11px] text-label-3">不影响界面额度刷新</p>
              </div>
            </div>
          </div>

        <div
          className={`grid grid-cols-1 gap-6 ${onShowFloatWindow ? 'lg:grid-cols-2' : ''}`}
          id="settings-local-row"
        >
          <div className="glass-card rounded-2xl p-6 flex items-center justify-between gap-4 h-full" id="card-client-detect">
            <div className="flex items-center gap-3.5">
              <div className="w-10 h-10 rounded-[10px] bg-accent/15 flex items-center justify-center text-accent">
                <Monitor className="w-4 h-4" />
              </div>
              <div className="flex flex-col text-left">
                <h3 className="font-bold text-label text-sm tracking-wide font-sans">官方 Codex</h3>
                <span className="text-[11px] text-label-2 mt-0.5">检测本机是否已安装微软商店版</span>
              </div>
            </div>

            <div className="flex items-center gap-4" id="client-detect-actions">
              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-label-2">
                <span className={`w-1.5 h-1.5 rounded-full ${settings.clientDetected ? 'bg-ok' : 'bg-danger'}`} />
                {settings.clientDetected ? '已安装' : '未安装'}
              </span>

              <motion.button
                onClick={handleDetectClient}
                disabled={isDetectingClient}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                className="px-4 py-2 rounded-[10px] bg-fill hover:bg-fill-2 text-label text-[13px] font-medium cursor-pointer transition-colors flex items-center gap-1.5"
                id="btn-re-detect-client"
              >
                <RotateCw className={`w-3 h-3 ${isDetectingClient ? 'animate-spin text-accent' : ''}`} />
                重新检测
              </motion.button>
            </div>
          </div>

          {onShowFloatWindow && (
            <div className="glass-card rounded-2xl p-6 flex items-center justify-between gap-4 h-full" id="card-float-lens">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-[10px] bg-accent/15 flex items-center justify-center text-accent">
                  <Gauge className="w-4 h-4" />
                </div>
                <div className="flex flex-col text-left">
                  <h3 className="font-bold text-label text-sm tracking-wide font-sans">桌面额度</h3>
                  <span className="text-[11px] text-label-2 mt-0.5">在桌面上放一块小仪表，随时看还剩多少额度</span>
                </div>
              </div>
              <motion.button
                onClick={() => {
                  onShowFloatWindow().catch((error) => onAddLog(error instanceof Error ? error.message : String(error), 'error'));
                }}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                className="px-4 py-2 rounded-[10px] bg-fill hover:bg-fill-2 text-label text-[13px] font-medium cursor-pointer transition-colors"
                id="btn-show-float-lens"
              >
                打开
              </motion.button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch" id="settings-account-row">
          <div className="glass-card rounded-2xl p-6 flex flex-col gap-6 h-full" id="card-tokens">
            <div className="flex items-start justify-between" id="tokens-header">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-[10px] bg-accent/15 flex items-center justify-center text-accent">
                  <Key className="w-4 h-4" />
                </div>
                <div className="flex flex-col text-left">
                  <h3 className="font-bold text-label text-sm tracking-wide font-sans">登录令牌</h3>
                  <span className="text-[11px] text-label-2 mt-0.5">检查各账号令牌是否仍可使用</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-6 mt-auto" id="tokens-body">
              <div className="flex flex-col text-left" id="tokens-stat-box">
                <span className="text-[28px] font-semibold text-label tracking-tight tabular-nums">{accountCount}</span>
                <span className="text-[12px] text-label-3 font-medium mt-1">已管理账号</span>
              </div>

              <motion.button
                onClick={handleBatchVerify}
                disabled={isVerifyingTokens}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                className="w-full py-2.5 bg-accent/15 hover:bg-accent/25 disabled:opacity-50 text-accent rounded-[10px] text-[13px] font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                id="btn-batch-login-check"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-accent" />
                {isVerifyingTokens ? '检查中...' : '检查令牌'}
              </motion.button>
            </div>
          </div>

          {/* Card 4: Update Channels */}
          <div className="glass-card rounded-2xl p-6 flex flex-col gap-5 h-full" id="card-software-update">
            <div className="flex items-start justify-between" id="updates-header">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-[10px] bg-accent/15 flex items-center justify-center text-accent">
                  <Download className="w-4 h-4" />
                </div>
                <div className="flex flex-col text-left">
                  <h3 className="font-bold text-label text-sm tracking-wide font-sans">软件更新</h3>
                  <span className="text-[11px] text-label-2 mt-0.5">当前版本状态与更新通道</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 mt-auto" id="updates-body">
              <div className="flex items-center justify-between text-xs font-semibold px-1" id="updates-status-labels">
                <span className="text-label-2">更新通道</span>
                <span className="px-2 py-0.5 bg-accent/15 text-accent rounded-md font-medium text-[11px]">{settings.updateChannel.replace('Beta Channel', 'Beta 通道').replace('Stable Channel', '稳定通道').replace('Developer Channel', '开发通道')}</span>
              </div>
              <div className="flex items-center justify-between text-xs font-semibold px-1 pb-1" id="updates-version-labels">
                <span className="text-label-2">最新状态</span>
                <span className="text-label font-medium flex items-center gap-1.5">
                  <LatestStatusIcon className={`w-3.5 h-3.5 ${latestStatusIconClass}`} />
                  {latestStatusText}
                </span>
              </div>

              <div className={`grid gap-2 ${canInstallUpdate ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <motion.button
                  onClick={handleCheckUpdates}
                  disabled={isCheckingUpdates}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                  className="w-full py-2.5 bg-accent/15 hover:bg-accent/25 text-accent text-[13px] font-medium rounded-[10px] cursor-pointer transition-colors flex items-center justify-center gap-1.5"
                  id="btn-check-for-updates"
                >
                  <Activity className={`w-3.5 h-3.5 text-accent ${isCheckingUpdates ? 'animate-spin' : ''}`} />
                  {isCheckingUpdates ? '检查中...' : (updateEnabled ? '检查更新' : '打开发布页')}
                </motion.button>
                {canInstallUpdate && (
                  <motion.button
                    onClick={handleInstallUpdate}
                    disabled={isInstallingUpdate || !onInstallUpdate}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                    className="w-full py-2.5 bg-ok/15 hover:bg-ok/25 text-ok text-[13px] font-medium rounded-[10px] cursor-pointer transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                    id="btn-install-update"
                  >
                    <Download className={`w-3.5 h-3.5 ${isInstallingUpdate ? 'animate-pulse' : ''}`} />
                    {isInstallingUpdate ? '安装中...' : '安装并重启'}
                  </motion.button>
                )}
              </div>
            </div>
          </div>
        </div>

      <div 
        className="glass-card rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 overflow-hidden relative"
        id="card-footer-banner"
      >
        <div className="flex items-center gap-4 text-left" id="footer-banner-left">
          <div className="w-11 h-11 rounded-[10px] bg-accent/15 flex items-center justify-center text-accent shrink-0">
            <Zap className="w-5 h-5" />
          </div>
          <div className="flex flex-col" id="footer-banner-titles">
            <span className="font-bold text-label text-sm tracking-wide font-sans">
              Codex Account Manager {settings.version.startsWith('v') ? settings.version : `v${settings.version}`}
            </span>
            <span className="text-xs text-label-2 mt-1">
              本地优先的 Codex 多账号管理工具。
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0" id="footer-banner-actions">
          {onOpenLogs && (
            <motion.button
              onClick={() => {
                onOpenLogs().catch(error => onAddLog(error instanceof Error ? error.message : String(error), 'error'));
              }}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              className="px-5 py-3 rounded-xl bg-fill hover:bg-fill-2 text-label-2 hover:text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all border border-sep"
              id="btn-open-logs"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              日志
            </motion.button>
          )}
          <motion.a
            href={repositoryUrl}
            target="_blank"
            rel="noopener noreferrer"
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 450, damping: 20 }}
            className="px-5 py-3 rounded-xl bg-fill hover:bg-fill-2 text-label-2 hover:text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all border border-sep"
            id="btn-github"
          >
            <Github className="w-3.5 h-3.5" />
            GitHub
          </motion.a>
        </div>
      </div>
      </div>
    </div>
  );
}

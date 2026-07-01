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
  RotateCw, 
  ShieldCheck, 
  Github, 
  FileText,
  Activity,
  Zap,
  FolderOpen
} from 'lucide-react';
import { SystemSettings, DaemonState } from '../types';

interface SettingsProps {
  settings: SystemSettings;
  daemonState: DaemonState;
  onToggleDaemon: () => void;
  onUpdateSyncInterval: (interval: number) => void;
  onAddLog: (msg: string, type: 'success' | 'info' | 'warning' | 'error') => void;
  onBatchVerifyTokens?: () => Promise<void>;
  onDetectClient?: () => Promise<void>;
  onCheckUpdates?: () => Promise<void>;
  onInstallUpdate?: () => Promise<void>;
  canInstallUpdate?: boolean;
  accountCount?: number;
  repositoryUrl?: string;
  onOpenLogs?: () => Promise<void>;
}

export default function SettingsView({
  settings,
  daemonState,
  onToggleDaemon,
  onUpdateSyncInterval,
  onAddLog,
  onBatchVerifyTokens,
  onDetectClient,
  onCheckUpdates,
  onInstallUpdate,
  canInstallUpdate = false,
  accountCount = 128,
  repositoryUrl = 'https://github.com',
  onOpenLogs,
}: SettingsProps) {
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isVerifyingTokens, setIsVerifyingTokens] = useState(false);
  const [tokenVerifyProgress, setTokenVerifyProgress] = useState(0);
  const [isDetectingClient, setIsDetectingClient] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);

  // Batch verify tokens simulation
  const handleBatchVerify = () => {
    if (onBatchVerifyTokens) {
      setIsVerifyingTokens(true);
      setTokenVerifyProgress(15);
      onAddLog('Initiating batch token integrity validation scan...', 'info');
      onBatchVerifyTokens()
        .then(() => {
          setTokenVerifyProgress(100);
          onAddLog('Batch Token Validation successful. Active tokens verified.', 'success');
        })
        .catch((error) => {
          onAddLog(error instanceof Error ? error.message : String(error), 'error');
        })
        .finally(() => {
          setTimeout(() => {
            setIsVerifyingTokens(false);
            setTokenVerifyProgress(0);
          }, 500);
        });
      return;
    }

    setIsVerifyingTokens(true);
    setTokenVerifyProgress(0);
    onAddLog('Initiating batch token integrity validation scan...', 'info');

    const interval = setInterval(() => {
      setTokenVerifyProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            setIsVerifyingTokens(false);
            onAddLog(`Batch Token Validation successful. ${accountCount} active tokens verified.`, 'success');
          }, 400);
          return 100;
        }
        return prev + 10;
      });
    }, 15000 / 100); // quick loader
  };

  const handleDetectClient = () => {
    if (onDetectClient) {
      setIsDetectingClient(true);
      onAddLog('Starting Client environment verification scanner...', 'info');
      onDetectClient()
        .then(() => onAddLog('Client environment detection refreshed.', 'success'))
        .catch((error) => onAddLog(error instanceof Error ? error.message : String(error), 'error'))
        .finally(() => setIsDetectingClient(false));
      return;
    }

    setIsDetectingClient(true);
    onAddLog('Starting Client environment verification scanner...', 'info');
    setTimeout(() => {
      setIsDetectingClient(false);
      onAddLog('Client environment detected. Microsoft Store package valid.', 'success');
    }, 1200);
  };

  const handleCheckUpdates = () => {
    if (onCheckUpdates) {
      setIsCheckingUpdates(true);
      onAddLog('Checking remote repositories for applet updates...', 'info');
      onCheckUpdates()
        .then(() => onAddLog('Update check completed.', 'success'))
        .catch((error) => onAddLog(error instanceof Error ? error.message : String(error), 'error'))
        .finally(() => setIsCheckingUpdates(false));
      return;
    }

    setIsCheckingUpdates(true);
    onAddLog('Checking remote repositories for applet updates...', 'info');
    setTimeout(() => {
      setIsCheckingUpdates(false);
      onAddLog('You are running the latest version of Codex Account Manager.', 'success');
    }, 1500);
  };

  const handleInstallUpdate = () => {
    if (!onInstallUpdate) return;
    setIsInstallingUpdate(true);
    onAddLog('Installing downloaded update and restarting application...', 'info');
    onInstallUpdate()
      .catch((error) => onAddLog(error instanceof Error ? error.message : String(error), 'error'))
      .finally(() => setIsInstallingUpdate(false));
  };

  return (
    <div className="flex-1 p-8 overflow-y-auto select-none" id="settings-view-container">
      {/* Page Title block */}
      <div className="flex flex-col mb-8 select-none" id="settings-title-group">
        <h2 className="text-3xl font-bold tracking-tight text-white font-sans">
          设置
        </h2>
        <p className="text-xs text-slate-300 mt-1 font-sans">
          管理 Codex 系统运行参数及账户同步配置
        </p>
      </div>

      {/* Main Settings Cards Grid - Matches exact screen 4 layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-8" id="settings-cards-grid">
        {/* Left Column: Daemon Service config (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-6" id="settings-left-col">
          {/* Card 1: Daemon Service */}
          <div className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex flex-col shadow-xl" id="card-daemon-settings">
            {/* Daemon Card Header */}
            <div className="flex items-start justify-between pb-5 border-b border-white/5" id="daemon-header">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                  <Server className="w-4 h-4" />
                </div>
                <div className="flex flex-col text-left">
                  <h3 className="font-bold text-slate-100 text-sm tracking-wide font-sans">Daemon 服务</h3>
                  <span className="text-[11px] text-slate-400 mt-0.5">控制后台同步守护进程</span>
                </div>
              </div>

              {/* Toggle service trigger */}
              <motion.button
                onClick={() => {
                  onToggleDaemon();
                }}
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.95 }}
                transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all border cursor-pointer ${
                  daemonState.status === 'Running' 
                    ? 'bg-rose-500/10 hover:bg-rose-500/15 border-rose-500/25 text-rose-300 hover:text-rose-200' 
                    : 'bg-emerald-500/10 hover:bg-emerald-500/15 border-emerald-500/25 text-emerald-300 hover:text-emerald-200'
                }`}
                id="btn-toggle-daemon"
              >
                {daemonState.status === 'Running' ? (
                  <>
                    <Square className="w-3 h-3 fill-rose-300" />
                    Stop Service
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3 fill-emerald-300" />
                    Start Service
                  </>
                )}
              </motion.button>
            </div>

            {/* Slider and status display */}
            <div className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-6 items-center" id="daemon-body">
              {/* Status display */}
              <div className="space-y-1 text-left" id="daemon-status-box">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider font-mono">当前状态</span>
                <div className="flex items-center gap-2 pt-1">
                  <span className={`w-2 h-2 rounded-full ${
                    daemonState.status === 'Running' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
                  }`} />
                  <span className={`font-bold text-sm ${
                    daemonState.status === 'Running' ? 'text-emerald-400' : 'text-rose-400'
                  }`}>{daemonState.status}</span>
                </div>
                {daemonState.pausedReason && (
                  <span className="block text-[10px] text-amber-300">Paused: {daemonState.pausedReason}</span>
                )}
                {daemonState.lastError && (
                  <span className="block max-w-xs truncate text-[10px] text-rose-300" title={daemonState.lastError}>
                    {daemonState.lastError}
                  </span>
                )}
              </div>

              {/* Sync Interval Slider */}
              <div className="space-y-2 text-left" id="daemon-interval-box">
                <div className="flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase tracking-wider font-mono">
                  <span>同步间隔 (Minutes)</span>
                  <span className="text-slate-200 font-mono text-xs">{daemonState.syncInterval}</span>
                </div>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="1"
                    max="60"
                    value={daemonState.syncInterval}
                    onChange={(e) => {
                      onUpdateSyncInterval(Number(e.target.value));
                    }}
                    className="flex-1 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500 outline-none"
                    id="sync-interval-slider"
                  />
                  <span className="text-slate-100 font-bold font-mono text-sm">{daemonState.syncInterval}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: Codex Client environment */}
          <div className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex items-center justify-between shadow-xl" id="card-client-detect">
            <div className="flex items-center gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                <Monitor className="w-4 h-4" />
              </div>
              <div className="flex flex-col text-left">
                <h3 className="font-bold text-slate-100 text-sm tracking-wide font-sans">Codex Client</h3>
                <span className="text-[11px] text-slate-400 mt-0.5">客户端环境检测</span>
              </div>
            </div>

            <div className="flex items-center gap-4" id="client-detect-actions">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 border text-[10px] font-bold rounded-xl uppercase tracking-wider ${
                settings.clientDetected
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                  : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
              }`}>
                Microsoft Store version
                <span className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[9px] font-extrabold ml-1">
                  {settings.clientDetected ? 'DETECTED' : 'NOT FOUND'}
                </span>
              </div>

              <motion.button
                onClick={handleDetectClient}
                disabled={isDetectingClient}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 text-slate-200 text-xs font-semibold cursor-pointer transition-all flex items-center gap-1"
                id="btn-re-detect-client"
              >
                <RotateCw className={`w-3 h-3 ${isDetectingClient ? 'animate-spin text-blue-400' : ''}`} />
                Re-detect
              </motion.button>
            </div>
          </div>
        </div>

        {/* Right Column: Tokens integrity & Updates (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-6" id="settings-right-col">
          {/* Card 3: Tokens */}
          <div className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex flex-col justify-between h-44 shadow-xl" id="card-tokens">
            <div className="flex items-start justify-between" id="tokens-header">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                  <Key className="w-4 h-4" />
                </div>
                <div className="flex flex-col text-left">
                  <h3 className="font-bold text-slate-100 text-sm tracking-wide font-sans">Tokens 令牌</h3>
                  <span className="text-[11px] text-slate-400 mt-0.5">凭证完整性校验</span>
                </div>
              </div>
            </div>

            <div className="flex items-end justify-between" id="tokens-body">
              <div className="flex flex-col text-left" id="tokens-stat-box">
                <span className="text-3xl font-extrabold text-white tracking-tight font-mono">{accountCount}</span>
                <span className="text-[10px] text-slate-400 uppercase tracking-widest font-mono font-bold mt-1">Total Active Accounts</span>
              </div>

              <motion.button
                onClick={handleBatchVerify}
                disabled={isVerifyingTokens}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                className="px-4 py-3 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 disabled:opacity-50 text-blue-300 hover:text-blue-200 rounded-2xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all"
                id="btn-batch-login-check"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-cyan-300" />
                {isVerifyingTokens ? `Checking... ${tokenVerifyProgress}%` : 'Batch Login Check'}
              </motion.button>
            </div>
          </div>

          {/* Card 4: Update Channels */}
          <div className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex flex-col justify-between h-48 shadow-xl" id="card-software-update">
            <div className="flex items-start justify-between" id="updates-header">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                  <Download className="w-4 h-4" />
                </div>
                <div className="flex flex-col text-left">
                  <h3 className="font-bold text-slate-100 text-sm tracking-wide font-sans">软件更新</h3>
                  <span className="text-[11px] text-slate-400 mt-0.5">当前版本状态与更新通道</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3" id="updates-body">
              <div className="flex items-center justify-between text-xs font-semibold px-1" id="updates-status-labels">
                <span className="text-slate-400">Update Channel</span>
                <span className="px-2.5 py-0.5 bg-blue-500/10 border border-blue-500/20 text-blue-300 rounded-full font-bold uppercase tracking-wider text-[9px]">{settings.updateChannel}</span>
              </div>
              <div className="flex items-center justify-between text-xs font-semibold px-1 pb-1" id="updates-version-labels">
                <span className="text-slate-400">Latest Status</span>
                <span className="text-emerald-400/90 font-bold uppercase tracking-wide flex items-center gap-1">
                  <CheckCircle className="w-3 h-3 text-emerald-400" />
                  {settings.latestStatus}
                </span>
              </div>

              <div className={`grid gap-2 ${canInstallUpdate ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <motion.button
                  onClick={handleCheckUpdates}
                  disabled={isCheckingUpdates}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                  className="w-full py-2.5 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-blue-300 hover:text-blue-200 text-xs font-bold rounded-2xl cursor-pointer transition-all flex items-center justify-center gap-1.5"
                  id="btn-check-for-updates"
                >
                  <Activity className={`w-3.5 h-3.5 text-blue-400 ${isCheckingUpdates ? 'animate-spin' : ''}`} />
                  {isCheckingUpdates ? 'Checking...' : 'Check for Updates'}
                </motion.button>
                {canInstallUpdate && (
                  <motion.button
                    onClick={handleInstallUpdate}
                    disabled={isInstallingUpdate || !onInstallUpdate}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                    className="w-full py-2.5 bg-emerald-500/10 hover:bg-emerald-500/15 border border-emerald-500/20 text-emerald-300 hover:text-emerald-200 text-xs font-bold rounded-2xl cursor-pointer transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
                    id="btn-install-update"
                  >
                    <Download className={`w-3.5 h-3.5 ${isInstallingUpdate ? 'animate-pulse' : ''}`} />
                    {isInstallingUpdate ? 'Installing...' : 'Install & Restart'}
                  </motion.button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Card 5: Banner footer link */}
      <div 
        className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-lg overflow-hidden relative"
        id="card-footer-banner"
      >
        <div className="absolute top-0 left-0 w-[3px] h-full bg-gradient-to-b from-blue-500/50 to-cyan-400/50" />

        <div className="flex items-center gap-4 text-left" id="footer-banner-left">
          <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
            <Zap className="w-5 h-5 text-blue-400 animate-pulse" />
          </div>
          <div className="flex flex-col" id="footer-banner-titles">
            <span className="font-bold text-slate-100 text-sm tracking-wide font-sans">
              Codex Account Manager {settings.version.startsWith('v') ? settings.version : `v${settings.version}`}
            </span>
            <span className="text-xs text-slate-400 mt-1">
              Built for precision account switching and high-velocity workflow automation.
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
              className="px-5 py-3 rounded-2xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all border border-white/5"
              id="btn-open-logs"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Logs
            </motion.button>
          )}
          <motion.a
            href={repositoryUrl}
            target="_blank"
            rel="noopener noreferrer"
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 450, damping: 20 }}
            className="px-5 py-3 rounded-2xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all border border-white/5"
            id="btn-github"
          >
            <Github className="w-3.5 h-3.5" />
            GitHub
          </motion.a>
          <motion.a
            href={`${repositoryUrl}#readme`}
            target="_blank"
            rel="noopener noreferrer"
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 450, damping: 20 }}
            className="px-5 py-3 rounded-2xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all border border-white/5"
            id="btn-documentation"
          >
            <FileText className="w-3.5 h-3.5" />
            Documentation
          </motion.a>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { 
  Zap, 
  Check, 
  CheckCircle2, 
  Clock, 
  Users
} from 'lucide-react';
import { AccountQuota, AutoSwitchRunResult, LogEntry, SystemSettings, DaemonState } from '../types';

interface AutoSwitchProps {
  accounts: AccountQuota[];
  logs: LogEntry[];
  settings: SystemSettings;
  daemonState: DaemonState;
  onToggleGlobalSwitch: () => void | Promise<void>;
  onPreviewThreshold: (type: '5h' | 'weekly', val: number) => void;
  onUpdateThreshold: (type: '5h' | 'weekly', val: number) => void;
  onAddLog: (msg: string, type: 'success' | 'info' | 'warning' | 'error') => void;
  onToggleAccountSelection: (id: string) => void;
  selectedAccountIds: string[];
  scopeMode?: 'all' | 'selected';
  onScopeModeChange?: (mode: 'all' | 'selected') => void | Promise<void>;
  onRunCheckNow?: () => Promise<AutoSwitchRunResult | void>;
}

function manualCheckLog(result: AutoSwitchRunResult | void): {
  message: string;
  type: 'success' | 'info' | 'warning' | 'error';
} {
  if (!result) return { message: 'Manual quota check completed.', type: 'success' };
  if (result.switched) {
    return {
      message: `Manual check switched to ${result.to?.email || 'another account'}.`,
      type: 'success',
    };
  }

  switch (result.reason) {
    case 'quota_sufficient':
      return { message: 'Manual check complete. Current quota is sufficient.', type: 'success' };
    case 'no_monitored':
      return { message: 'Manual check skipped: select at least one account or use All Accounts.', type: 'warning' };
    case 'current_not_monitored':
      return { message: 'Manual check skipped: the current account is outside the selected scope.', type: 'warning' };
    case 'no_candidates':
      return { message: 'Manual check complete: no eligible replacement account is available.', type: 'warning' };
    case 'no_accounts':
      return { message: 'Manual check skipped: no managed accounts are available.', type: 'warning' };
    case 'no_quota_data':
      return { message: 'Manual check could not find quota data for the current account.', type: 'warning' };
    case 'auth_conflict':
      return { message: 'Manual check paused until the official Codex login conflict is resolved.', type: 'error' };
    case 'current_quota_refresh_failed':
      return { message: `Manual check failed: ${result.error || 'current quota refresh failed'}.`, type: 'error' };
    case 'cancelled':
      return { message: 'Manual check was cancelled.', type: 'warning' };
    default:
      return {
        message: `Manual check completed${result.reason ? `: ${result.reason}` : '.'}`,
        type: 'info',
      };
  }
}

export default function AutoSwitchView({
  accounts,
  logs,
  settings,
  daemonState,
  onToggleGlobalSwitch,
  onPreviewThreshold,
  onUpdateThreshold,
  onAddLog,
  onToggleAccountSelection,
  selectedAccountIds,
  scopeMode = 'selected',
  onScopeModeChange,
  onRunCheckNow,
}: AutoSwitchProps) {
  const [activeScopeTab, setActiveScopeTab] = useState<'all' | 'specific'>(scopeMode === 'all' ? 'all' : 'specific');
  const [isCheckingNow, setIsCheckingNow] = useState(false);
  const [isTogglingGlobal, setIsTogglingGlobal] = useState(false);

  useEffect(() => {
    setActiveScopeTab(scopeMode === 'all' ? 'all' : 'specific');
  }, [scopeMode]);

  const scopeAccounts = accounts;
  const rotationCount = logs.filter((log) => /switch|rotation/i.test(log.message)).length;
  const attentionCount = accounts.filter((account) => ['WARNING', 'EXPIRED', 'SUSPENDED', 'LOW_QUOTA'].includes(account.status)).length;
  const selectedAccounts = accounts.filter((account) => selectedAccountIds.includes(account.id));
  const visibleAvatars = selectedAccounts.slice(0, 3);
  const hiddenAvatarCount = Math.max(0, selectedAccounts.length - visibleAvatars.length);
  const currentAccount = accounts.find((account) => account.isCurrent);
  const currentQuotaSufficient = !!currentAccount && currentAccount.status === 'ACTIVE';

  const handleCheckNow = async () => {
    setIsCheckingNow(true);
    onAddLog('Initiating manual quota scanning protocol...', 'info');
    if (onRunCheckNow) {
      try {
        const result = await onRunCheckNow();
        const log = manualCheckLog(result);
        onAddLog(log.message, log.type);
      } catch (error) {
        onAddLog(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        setIsCheckingNow(false);
      }
      return;
    }
    setTimeout(() => {
      setIsCheckingNow(false);
      onAddLog('Manual quota scanning complete. All selected accounts checked.', 'success');
    }, 1500);
  };

  const handleToggleGlobal = async () => {
    if (isTogglingGlobal) return;
    setIsTogglingGlobal(true);
    try {
      await onToggleGlobalSwitch();
    } catch (error) {
      onAddLog(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setIsTogglingGlobal(false);
    }
  };

  const getScopeStatusBadge = (status: AccountQuota['status']) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="flex items-center gap-1 text-emerald-400 text-[10px] font-bold uppercase tracking-wider">
            <span className="w-1 h-1 rounded-full bg-emerald-400" />
            Active
          </span>
        );
      case 'LOW_QUOTA':
        return (
          <span className="flex items-center gap-1 text-amber-500 text-[10px] font-bold uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Low Quota
          </span>
        );
      case 'SUSPENDED':
        return (
          <span className="flex items-center gap-1 text-rose-500 text-[10px] font-bold uppercase tracking-wider">
            <span className="w-1 h-1 rounded-full bg-rose-500" />
            Suspended
          </span>
        );
      case 'READY':
        return (
          <span className="flex items-center gap-1 text-teal-400 text-[10px] font-bold uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-teal-400" />
            Ready
          </span>
        );
      default:
        return (
          <span className="text-slate-400 text-[10px] uppercase font-bold">{status}</span>
        );
    }
  };

  const getPriorityBadge = (priority: AccountQuota['priority']) => {
    let colors = "text-slate-400";
    if (priority === 'Ultra') colors = "text-cyan-400";
    if (priority === 'High') colors = "text-blue-400";
    if (priority === 'Normal') colors = "text-slate-300";
    if (priority === 'Low') colors = "text-slate-500";
    return <span className={`text-[10px] ${colors} font-semibold font-mono`}>Priority: {priority}</span>;
  };

  return (
    <div className="flex-1 p-8 overflow-y-auto select-none" id="autoswitch-view-container">
      {/* Page Title & Check Now Header Bar */}
      <div className="flex items-center justify-between mb-8" id="autoswitch-title-row">
        <div className="flex flex-col" id="autoswitch-title-group">
          <h2 className="text-3xl font-bold tracking-tight text-white font-sans">
            自动切号
          </h2>
          <p className="text-xs text-slate-300 mt-1 font-sans">
            智能配额监控与自动化账号轮转
          </p>
        </div>

        {/* Daemon status and Trigger button */}
        <div className="flex items-center gap-3" id="autoswitch-trigger-group">
          {/* Daemon active widget */}
          <div className="flex items-center gap-2 px-4 py-2 bg-slate-900/40 border border-white/5 rounded-2xl text-xs font-semibold" id="daemon-capsule-autoswitch">
            <span className={`w-2 h-2 rounded-full ${daemonState.status === 'Running' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
            <span className="text-slate-400">Daemon Status</span>
            <span className={`${daemonState.status === 'Running' ? 'text-emerald-400' : 'text-rose-400'} font-bold uppercase tracking-wide`}>{daemonState.status}</span>
          </div>

          <motion.button
            onClick={handleCheckNow}
            disabled={isCheckingNow}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            className="flex items-center gap-2 px-5 py-3 rounded-2xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 disabled:opacity-50 text-blue-300 hover:text-blue-200 text-xs font-bold transition-all"
            id="autoswitch-btn-checknow"
          >
            <Zap className={`w-3.5 h-3.5 ${isCheckingNow ? 'animate-bounce text-cyan-300' : ''}`} />
            Check Now
          </motion.button>
        </div>
      </div>

      {/* Main double column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-8" id="autoswitch-main-grid">
        {/* Left Side: Control Settings & Switch Config (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-6" id="autoswitch-left-panel">
          {/* Controls Card */}
          <div className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex flex-col shadow-xl" id="autoswitch-control-card">
            {/* Global Switch row */}
            <div className="flex items-center justify-between pb-6 border-b border-white/5" id="autoswitch-global-row">
              <div className="flex flex-col" id="autoswitch-global-text">
                <span className="font-bold text-slate-100 text-sm font-sans">全局开关</span>
                <span className="text-xs text-slate-400 mt-1">启用系统自动监测并切换账号</span>
              </div>
              {/* Custom IOS style Toggle */}
              <motion.button
                onClick={handleToggleGlobal}
                disabled={isTogglingGlobal}
                aria-busy={isTogglingGlobal}
                whileTap={{ scale: 0.92 }}
                className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer outline-none relative ${
                  settings.globalSwitch ? 'bg-blue-500' : 'bg-slate-800'
                }`}
                id="autoswitch-global-toggle-btn"
              >
                <motion.div 
                  layout
                  transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                  className={`w-5 h-5 rounded-full bg-white shadow-md absolute top-0.5 ${
                    settings.globalSwitch ? 'right-0.5' : 'left-0.5'
                  }`} 
                />
              </motion.button>
            </div>

            {/* Threshold Sliders */}
            <div className="pt-6 space-y-6" id="autoswitch-sliders-container">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider font-mono">阈值设定</h4>

              {/* 5h Quota Threshold */}
              <div className="space-y-2" id="threshold-5h-container">
                <div className="flex items-center justify-between text-xs font-semibold" id="threshold-5h-labels">
                  <span className="text-slate-300">5h Quota Threshold</span>
                  <span className="text-blue-400 font-bold font-mono">{settings.fiveHourThreshold}%</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="50"
                  value={settings.fiveHourThreshold}
                  onChange={(e) => onPreviewThreshold('5h', Number(e.target.value))}
                  onPointerUp={(e) => onUpdateThreshold('5h', Number(e.currentTarget.value))}
                  onKeyUp={(e) => onUpdateThreshold('5h', Number(e.currentTarget.value))}
                  onBlur={(e) => onUpdateThreshold('5h', Number(e.currentTarget.value))}
                  className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500 outline-none"
                  id="threshold-5h-slider"
                />
              </div>

              {/* Weekly Quota Threshold */}
              <div className="space-y-2" id="threshold-weekly-container">
                <div className="flex items-center justify-between text-xs font-semibold" id="threshold-weekly-labels">
                  <span className="text-slate-300">Weekly Quota Threshold</span>
                  <span className="text-blue-400 font-bold font-mono">{settings.weeklyThreshold}%</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="50"
                  value={settings.weeklyThreshold}
                  onChange={(e) => onPreviewThreshold('weekly', Number(e.target.value))}
                  onPointerUp={(e) => onUpdateThreshold('weekly', Number(e.currentTarget.value))}
                  onKeyUp={(e) => onUpdateThreshold('weekly', Number(e.currentTarget.value))}
                  onBlur={(e) => onUpdateThreshold('weekly', Number(e.currentTarget.value))}
                  className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500 outline-none"
                  id="threshold-weekly-slider"
                />
              </div>
            </div>
          </div>

          {/* Status Log & Banner Panel */}
          <div className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex flex-col shadow-xl" id="autoswitch-logs-card">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider font-mono mb-4">状态日志</h4>

            {/* Green banner */}
            <div className={`p-4 border rounded-2xl flex items-start gap-3 mb-4 ${currentQuotaSufficient ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-amber-500/10 border-amber-500/20'}`} id="autoswitch-log-banner">
              <CheckCircle2 className={`w-5 h-5 shrink-0 mt-0.5 animate-pulse ${currentQuotaSufficient ? 'text-emerald-400' : 'text-amber-400'}`} />
              <div className="flex flex-col" id="autoswitch-banner-text">
                <span className={`text-xs font-bold ${currentQuotaSufficient ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {currentAccount ? (currentQuotaSufficient ? 'Current quota sufficient' : 'Current account needs attention') : 'No current account'}
                </span>
                <span className={`text-[11px] mt-0.5 ${currentQuotaSufficient ? 'text-emerald-400/80' : 'text-amber-400/80'}`}>
                  {settings.globalSwitch ? 'Automatic rotation enabled' : 'Automatic rotation disabled'}
                </span>
              </div>
            </div>

            {/* Checked time banner */}
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-4 px-1" id="autoswitch-lastcheck-row">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span>Last checked: {daemonState.lastChecked}</span>
            </div>

            {/* Log Scroll Container */}
            <div className="h-44 overflow-y-auto space-y-2.5 pr-1 text-slate-300 font-sans" id="autoswitch-logs-list">
              {logs.slice(0, 5).map((log) => {
                let badgeColor = "bg-slate-400";
                if (log.type === 'success') badgeColor = "bg-emerald-400";
                if (log.type === 'error') badgeColor = "bg-rose-400";
                if (log.type === 'warning') badgeColor = "bg-amber-400";
                if (log.type === 'info') badgeColor = "bg-blue-400";

                return (
                  <div key={log.id} className="flex items-start gap-2.5 text-[11px]" id={`log-item-${log.id}`}>
                    <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${badgeColor}`} />
                    <div className="flex flex-col" id={`log-item-desc-${log.id}`}>
                      <span className="text-slate-300 font-medium leading-normal">{log.message}</span>
                      <span className="text-[9px] text-slate-500 font-mono mt-0.5">{log.timestamp}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Side: Scope Selection (7 cols) */}
        <div className="lg:col-span-7 backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex flex-col shadow-xl" id="autoswitch-right-panel">
          {/* Card header and tab selector */}
          <div className="flex items-center justify-between pb-5 border-b border-white/5 mb-5" id="scope-header-row">
            <h4 className="text-sm font-bold text-slate-100 tracking-wide font-sans">Scope Selection</h4>
            <div className="flex bg-slate-950/40 p-1 rounded-xl border border-white/5 text-xs font-semibold relative" id="scope-tabs-capsule">
              <button
                onClick={() => {
                  setActiveScopeTab('all');
                  onScopeModeChange?.('all');
                  onAddLog('Scope filter toggled to All Accounts.', 'info');
                }}
                className={`px-4 py-2 rounded-lg transition-all relative cursor-pointer z-10 ${
                  activeScopeTab === 'all' ? 'text-white font-bold' : 'text-slate-400 hover:text-slate-300'
                }`}
                id="scope-tab-all"
              >
                {activeScopeTab === 'all' && (
                  <motion.div
                    layoutId="scopeActiveBg"
                    className="absolute inset-0 bg-white/10 rounded-lg -z-10"
                    transition={{ type: 'spring', stiffness: 450, damping: 25 }}
                  />
                )}
                All Accounts
              </button>
              <button
                onClick={() => {
                  setActiveScopeTab('specific');
                  onScopeModeChange?.('selected');
                  onAddLog('Scope filter toggled to Specific Accounts.', 'info');
                }}
                className={`px-4 py-2 rounded-lg transition-all relative cursor-pointer z-10 ${
                  activeScopeTab === 'specific' ? 'text-white font-bold' : 'text-slate-400 hover:text-slate-300'
                }`}
                id="scope-tab-specific"
              >
                {activeScopeTab === 'specific' && (
                  <motion.div
                    layoutId="scopeActiveBg"
                    className="absolute inset-0 bg-white/10 rounded-lg -z-10"
                    transition={{ type: 'spring', stiffness: 450, damping: 25 }}
                  />
                )}
                Specific Accounts
              </button>
            </div>
          </div>

          {/* Account check list */}
          <div className="flex-1 space-y-4" id="scope-accounts-list">
            {scopeAccounts.map((account) => {
              const isChecked = selectedAccountIds.includes(account.id);
              return (
                <motion.div
                  key={account.id}
                  onClick={() => onToggleAccountSelection(account.id)}
                  whileHover={{ scale: 1.015, x: 4, backgroundColor: 'rgba(255, 255, 255, 0.05)' }}
                  whileTap={{ scale: 0.985 }}
                  transition={{ type: 'spring', stiffness: 450, damping: 24 }}
                  className={`p-4 rounded-2xl border flex items-center justify-between transition-all cursor-pointer group ${
                    isChecked 
                      ? 'bg-white/[0.04] border-white/10 hover:border-white/15' 
                      : 'bg-transparent border-transparent opacity-60 hover:opacity-80'
                  }`}
                  id={`scope-acc-card-${account.id}`}
                >
                  <div className="flex items-center gap-4" id={`scope-acc-left-${account.id}`}>
                    {/* Custom Checkbox */}
                    <div 
                      className={`w-5 h-5 rounded-md border flex items-center justify-center transition-all shrink-0 ${
                        isChecked 
                          ? 'bg-blue-500 border-blue-400 text-white' 
                          : 'border-white/20 group-hover:border-white/30'
                      }`}
                      id={`scope-checkbox-${account.id}`}
                    >
                      {isChecked && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                    </div>

                    {/* Account Icon */}
                    <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/5 flex items-center justify-center text-slate-300" id={`scope-icon-${account.id}`}>
                      <Users className="w-4 h-4 text-slate-400" />
                    </div>

                    {/* Title and details */}
                    <div className="flex flex-col text-left" id={`scope-titles-${account.id}`}>
                      <span className="font-bold text-slate-100 text-sm font-sans">{account.name}</span>
                      <span className="text-[11px] text-slate-400 font-mono mt-0.5">
                        5H Remaining: {account.fiveHourQuotaRemaining == null
                          ? '--'
                          : `${Math.round((account.fiveHourQuotaRemaining / account.fiveHourQuotaTotal) * 100)}%`}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col items-end text-right gap-1" id={`scope-acc-right-${account.id}`}>
                    {getScopeStatusBadge(account.status)}
                    {getPriorityBadge(account.priority)}
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bottom Horizontal statistics bar */}
      <div 
        className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 grid grid-cols-1 md:grid-cols-4 gap-6 items-center shadow-md select-none"
        id="autoswitch-stats-bar"
      >
        {/* Rotation Count */}
        <div className="flex flex-col" id="stat-col-rotation">
          <span className="text-[10px] font-bold text-slate-400 tracking-wider font-mono">SESSION SWITCH EVENTS</span>
          <span className="text-2xl font-bold text-blue-400 mt-1 font-mono">{rotationCount}</span>
        </div>

        {/* Average Uptime */}
        <div className="flex flex-col" id="stat-col-uptime">
          <span className="text-[10px] font-bold text-slate-400 tracking-wider font-mono">DAEMON STATUS</span>
          <span className={`text-2xl font-bold mt-1 font-mono ${daemonState.status === 'Running' ? 'text-emerald-400' : 'text-rose-400'}`}>
            {daemonState.status}
          </span>
        </div>

        {/* Blocked Threads */}
        <div className="flex flex-col" id="stat-col-blocked">
          <span className="text-[10px] font-bold text-slate-400 tracking-wider font-mono">ACCOUNTS NEEDING ACTION</span>
          <span className="text-2xl font-bold text-slate-200 mt-1 font-mono">{attentionCount}</span>
        </div>

        {/* User Badges Avatar Bubbles */}
        <div className="flex flex-col items-start md:items-end" id="stat-col-avatars">
          <div className="flex items-center -space-x-2" id="avatars-overlap-container">
            {visibleAvatars.map((account, index) => (
              <div
                key={account.id}
                className={`w-8 h-8 rounded-full border-2 border-slate-900 flex items-center justify-center text-white text-[10px] font-bold shadow-lg ${
                  index === 0 ? 'bg-gradient-to-r from-blue-500 to-cyan-500' : index === 1 ? 'bg-gradient-to-r from-purple-500 to-pink-500' : 'bg-gradient-to-r from-amber-500 to-orange-500'
                }`}
                title={account.email}
              >
                {account.name.charAt(0).toUpperCase() || '?'}
              </div>
            ))}
            {hiddenAvatarCount > 0 && (
              <div className="w-10 h-8 rounded-full bg-slate-800 border-2 border-slate-900 flex items-center justify-center text-slate-300 text-[10px] font-bold px-2 shadow-lg">
                +{hiddenAvatarCount}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

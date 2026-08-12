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
import { STATUS_DOT, STATUS_TEXT } from '../api/desktop';

interface AutoSwitchProps {
  accounts: AccountQuota[];
  logs: LogEntry[];
  settings: SystemSettings;
  daemonState: DaemonState;
  sessionSwitchCount: number;
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
  if (!result) return { message: '手动额度检查已完成。', type: 'success' };
  if (result.switched) {
    return {
      message: `手动检查已切换至 ${result.to?.email || '另一账号'}。`,
      type: 'success',
    };
  }

  switch (result.reason) {
    case 'quota_sufficient':
      return { message: '手动检查完成，当前额度充足。', type: 'success' };
    case 'no_monitored':
      return { message: '已跳过：请至少选择一个账号，或使用全部账号范围。', type: 'warning' };
    case 'current_not_monitored':
      return { message: '已跳过：当前账号不在选定范围内。', type: 'warning' };
    case 'no_candidates':
      return { message: '检查完成：暂无可用的替换账号。', type: 'warning' };
    case 'no_accounts':
      return { message: '已跳过：没有可用的管理账号。', type: 'warning' };
    case 'no_quota_data':
      return { message: '未能获取当前账号的额度数据。', type: 'warning' };
    case 'auth_conflict':
      return { message: '手动检查已暂停：请先处理官方 Codex 登录冲突。', type: 'error' };
    case 'current_quota_refresh_failed':
      return { message: `手动检查失败：${result.error || '当前账号额度刷新失败'}。`, type: 'error' };
    case 'cancelled':
      return { message: '手动检查已取消。', type: 'warning' };
    default:
      return {
        message: `手动检查完成${result.reason ? `：${result.reason}` : '。'}`,
        type: 'info',
      };
  }
}

export default function AutoSwitchView({
  accounts,
  logs,
  settings,
  daemonState,
  sessionSwitchCount,
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
  const currentAccount = accounts.find((account) => account.isCurrent);
  const currentQuotaSufficient = !!currentAccount && currentAccount.status === 'ACTIVE';

  const handleCheckNow = async () => {
    setIsCheckingNow(true);
    onAddLog('正在执行手动额度检查...', 'info');
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
      onAddLog('手动额度检查完成。', 'success');
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

  const getScopeStatusBadge = (status: AccountQuota['status']) => (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-label-2">
      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] || 'bg-fill-3'}`} />
      {STATUS_TEXT[status] || status}
    </span>
  );

  const getPriorityBadge = (priority: AccountQuota['priority']) => (
    <span className="text-[11px] text-label-3 tabular-nums">优先级 {priority}</span>
  );

  return (
    <div className="flex-1 p-8 overflow-y-auto select-none" id="autoswitch-view-container">
      {/* Page Title & Check Now Header Bar */}
      <div className="flex items-center justify-between mb-8" id="autoswitch-title-row">
        <div className="flex flex-col" id="autoswitch-title-group">
          <h2 className="text-[28px] font-bold tracking-tight text-label font-sans">
            自动切号
          </h2>
          <p className="text-[13px] text-label-2 mt-1.5 font-sans">
            智能配额监控与自动化账号轮转
          </p>
        </div>

        {/* Daemon status and Trigger button */}
        <div className="flex items-center gap-3" id="autoswitch-trigger-group">
          {/* Daemon active widget */}
          <div className="flex items-center gap-2 px-3.5 py-2 bg-fill rounded-[10px] text-[12px] font-medium" id="daemon-capsule-autoswitch">
            <span className={`w-1.5 h-1.5 rounded-full ${daemonState.status === 'Running' ? 'bg-ok' : 'bg-danger'}`} />
            <span className="text-label-2">Daemon</span>
            <span className="text-label">{daemonState.status === 'Running' ? '运行中' : '已停止'}</span>
          </div>

          {/* Session switch counter */}
          <div className="flex items-center gap-2 px-3.5 py-2 bg-fill rounded-[10px] text-[12px] font-medium" id="autoswitch-session-capsule">
            <span className="text-label-2">本次切换</span>
            <span className="text-label tabular-nums">{sessionSwitchCount}</span>
          </div>

          <motion.button
            onClick={handleCheckNow}
            disabled={isCheckingNow}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            className="flex items-center gap-2 px-4 py-2 rounded-[10px] bg-accent/15 hover:bg-accent/25 disabled:opacity-50 text-accent text-[13px] font-medium transition-colors"
            id="autoswitch-btn-checknow"
          >
            <Zap className={`w-3.5 h-3.5 ${isCheckingNow ? 'animate-pulse text-accent' : ''}`} />
            立即检查
          </motion.button>
        </div>
      </div>

      {/* Main double column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-8" id="autoswitch-main-grid">
        {/* Left Side: Control Settings & Switch Config (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-6" id="autoswitch-left-panel">
          {/* Controls Card */}
          <div className="glass-card rounded-2xl p-6 flex flex-col" id="autoswitch-control-card">
            {/* Global Switch row */}
            <div className="flex items-center justify-between pb-6 border-b border-sep" id="autoswitch-global-row">
              <div className="flex flex-col" id="autoswitch-global-text">
                <span className="font-bold text-label text-sm font-sans">全局开关</span>
                <span className="text-xs text-label-2 mt-1">启用系统自动监测并切换账号</span>
              </div>
              {/* Custom IOS style Toggle */}
              <motion.button
                onClick={handleToggleGlobal}
                disabled={isTogglingGlobal}
                aria-busy={isTogglingGlobal}
                whileTap={{ scale: 0.92 }}
                className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer outline-none relative ${
                  settings.globalSwitch ? 'bg-accent' : 'bg-fill-3'
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
              <h4 className="text-[13px] font-semibold text-label">阈值设定</h4>

              {/* 5h Quota Threshold */}
              <div className="space-y-2" id="threshold-5h-container">
                <div className="flex items-center justify-between text-xs font-semibold" id="threshold-5h-labels">
                  <span className="text-label-2">5 小时额度阈值</span>
                  <span className="text-accent font-bold tabular-nums">{settings.fiveHourThreshold}%</span>
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
                  className="w-full h-1 bg-fill-2 rounded-lg appearance-none cursor-pointer accent-accent outline-none"
                  id="threshold-5h-slider"
                />
              </div>

              {/* Weekly Quota Threshold */}
              <div className="space-y-2" id="threshold-weekly-container">
                <div className="flex items-center justify-between text-xs font-semibold" id="threshold-weekly-labels">
                  <span className="text-label-2">周额度阈值</span>
                  <span className="text-accent font-bold tabular-nums">{settings.weeklyThreshold}%</span>
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
                  className="w-full h-1 bg-fill-2 rounded-lg appearance-none cursor-pointer accent-accent outline-none"
                  id="threshold-weekly-slider"
                />
              </div>
            </div>
          </div>

          {/* Status Log & Banner Panel */}
          <div className="glass-card rounded-2xl p-6 flex flex-col" id="autoswitch-logs-card">
            <h4 className="text-[13px] font-semibold text-label mb-4">状态日志</h4>

            {/* Green banner */}
            <div className={`p-4 rounded-[10px] flex items-start gap-3 mb-4 ${currentQuotaSufficient ? 'bg-ok/12' : 'bg-warn/12'}`} id="autoswitch-log-banner">
              <CheckCircle2 className={`w-5 h-5 shrink-0 mt-0.5 ${currentQuotaSufficient ? 'text-ok' : 'text-warn'}`} />
              <div className="flex flex-col" id="autoswitch-banner-text">
                <span className={`text-xs font-bold ${currentQuotaSufficient ? 'text-ok' : 'text-warn'}`}>
                  {currentAccount ? (currentQuotaSufficient ? '当前额度充足' : '当前账号需要关注') : '暂无当前账号'}
                </span>
                <span className={`text-[11px] mt-0.5 ${currentQuotaSufficient ? 'text-ok/80' : 'text-warn/80'}`}>
                  {settings.globalSwitch ? '自动轮换已启用' : '自动轮换已禁用'}
                </span>
              </div>
            </div>

            {/* Checked time banner */}
            <div className="flex items-center gap-2 text-xs text-label-2 mb-4 px-1" id="autoswitch-lastcheck-row">
              <Clock className="w-3.5 h-3.5 text-label-2" />
              <span>最近检查：{daemonState.lastChecked}</span>
            </div>

            {/* Log Scroll Container */}
            <div className="h-44 overflow-y-auto space-y-2.5 pr-1 text-label-2 font-sans" id="autoswitch-logs-list">
              {logs.slice(0, 5).map((log) => {
                let badgeColor = "bg-fill-3";
                if (log.type === 'success') badgeColor = "bg-ok";
                if (log.type === 'error') badgeColor = "bg-danger";
                if (log.type === 'warning') badgeColor = "bg-warn";
                if (log.type === 'info') badgeColor = "bg-accent";

                return (
                  <div key={log.id} className="flex items-start gap-2.5 text-[11px]" id={`log-item-${log.id}`}>
                    <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${badgeColor}`} />
                    <div className="flex flex-col" id={`log-item-desc-${log.id}`}>
                      <span className="text-label-2 font-medium leading-normal">{log.message}</span>
                      <span className="text-[10px] text-label-3 tabular-nums mt-0.5">{log.timestamp}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Side: Scope Selection (7 cols) */}
        <div className="lg:col-span-7 glass-card rounded-2xl p-6 flex flex-col" id="autoswitch-right-panel">
          {/* Card header and tab selector */}
          <div className="flex items-center justify-between pb-5 border-b border-sep mb-5" id="scope-header-row">
            <h4 className="text-sm font-bold text-label tracking-wide font-sans">生效范围</h4>
            <div className="flex bg-fill p-1 rounded-xl border border-sep text-xs font-semibold relative" id="scope-tabs-capsule">
              <button
                onClick={() => {
                  setActiveScopeTab('all');
                  onScopeModeChange?.('all');
                  onAddLog('生效范围已切换为全部账号。', 'info');
                }}
                className={`px-4 py-2 rounded-lg transition-all relative cursor-pointer z-10 ${
                  activeScopeTab === 'all' ? 'text-white font-bold' : 'text-label-2 hover:text-label-2'
                }`}
                id="scope-tab-all"
              >
                {activeScopeTab === 'all' && (
                  <motion.div
                    layoutId="scopeActiveBg"
                    className="absolute inset-0 bg-fill-2 rounded-lg -z-10"
                    transition={{ type: 'spring', stiffness: 450, damping: 25 }}
                  />
                )}
                全部账号
              </button>
              <button
                onClick={() => {
                  setActiveScopeTab('specific');
                  onScopeModeChange?.('selected');
                  onAddLog('生效范围已切换为指定账号。', 'info');
                }}
                className={`px-4 py-2 rounded-lg transition-all relative cursor-pointer z-10 ${
                  activeScopeTab === 'specific' ? 'text-white font-bold' : 'text-label-2 hover:text-label-2'
                }`}
                id="scope-tab-specific"
              >
                {activeScopeTab === 'specific' && (
                  <motion.div
                    layoutId="scopeActiveBg"
                    className="absolute inset-0 bg-fill-2 rounded-lg -z-10"
                    transition={{ type: 'spring', stiffness: 450, damping: 25 }}
                  />
                )}
                指定账号
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
                  whileTap={{ scale: 0.99 }}
                  transition={{ type: 'spring', stiffness: 450, damping: 24 }}
                  className={`p-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer group ${
                    isChecked 
                      ? 'bg-white/[0.04] border-sep hover:border-white/15' 
                      : 'bg-transparent border-transparent opacity-60 hover:opacity-80'
                  }`}
                  id={`scope-acc-card-${account.id}`}
                >
                  <div className="flex items-center gap-4" id={`scope-acc-left-${account.id}`}>
                    {/* Custom Checkbox */}
                    <div 
                      className={`w-5 h-5 rounded-md border flex items-center justify-center transition-all shrink-0 ${
                        isChecked 
                          ? 'bg-accent border-accent text-white' 
                          : 'border-white/20 group-hover:border-white/30'
                      }`}
                      id={`scope-checkbox-${account.id}`}
                    >
                      {isChecked && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                    </div>

                    {/* Account Icon */}
                    <div className="w-10 h-10 rounded-full bg-fill flex items-center justify-center text-label-2" id={`scope-icon-${account.id}`}>
                      <Users className="w-4 h-4 text-label-2" />
                    </div>

                    {/* Title and details */}
                    <div className="flex flex-col text-left" id={`scope-titles-${account.id}`}>
                      <span className="font-bold text-label text-sm font-sans">{account.name}</span>
                      <span className="text-[11px] text-label-2 tabular-nums mt-0.5">
                        5 小时剩余: {account.fiveHourQuotaRemaining == null
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
    </div>
  );
}

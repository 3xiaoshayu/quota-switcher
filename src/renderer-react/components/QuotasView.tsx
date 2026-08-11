import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Users, 
  Bell, 
  BarChart3, 
  MoreHorizontal, 
  RefreshCw, 
  Activity
} from 'lucide-react';
import { AccountQuota } from '../types';
import { avatarGradient, formatDateTime } from '../api/desktop';

interface QuotasProps {
  accounts: AccountQuota[];
  onRefreshAccount: (id: string) => void | Promise<void>;
  onRefreshToken?: (id: string) => void | Promise<void>;
  onRefreshAll: () => void | Promise<void>;
  isRefreshingAll: boolean;
}

function toEpochMs(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

export default function QuotasView({
  accounts,
  onRefreshAccount,
  onRefreshToken,
  onRefreshAll,
  isRefreshingAll,
}: QuotasProps) {
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [refreshingCardId, setRefreshingCardId] = useState<string | null>(null);
  const [refreshingTokenId, setRefreshingTokenId] = useState<string | null>(null);

  const gridAccounts = accounts;

  // Calculate dynamic stats
  const totalAccounts = accounts.length;
  const actionRequiredCount = accounts.filter(
    acc => acc.status === 'EXPIRED' || acc.status === 'WARNING' || acc.status === 'SUSPENDED' || acc.status === 'LOW_QUOTA',
  ).length;
  
  // Calculate average quota remaining
  const visibleQuotaPercentages = accounts.flatMap((account) => {
    const percentages: number[] = [];
    if (account.fiveHourQuotaRemaining != null) {
      percentages.push((account.fiveHourQuotaRemaining / account.fiveHourQuotaTotal) * 100);
    }
    if (account.weeklyQuotaRemaining != null) {
      percentages.push((account.weeklyQuotaRemaining / account.weeklyQuotaTotal) * 100);
    }
    return percentages;
  });
  const avgRemaining = Math.round(
    visibleQuotaPercentages.length
      ? visibleQuotaPercentages.reduce((sum, percentage) => sum + percentage, 0) / visibleQuotaPercentages.length
      : 0,
  );

  const syncedCount = accounts.filter(acc => acc.quotaUpdatedAt && !acc.quotaError).length;
  const lastUpdatedAtMs = accounts.reduce<number | null>((latest, account) => {
    const updated = toEpochMs(account.quotaUpdatedAt);
    if (updated === null) return latest;
    return latest === null || updated > latest ? updated : latest;
  }, null);

  const handleCardRefresh = async (id: string) => {
    setRefreshingCardId(id);
    try {
      await onRefreshAccount(id);
    } catch {
      // The app-level handler already reports the error through toast/log state.
    } finally {
      setRefreshingCardId(null);
    }
  };

  const handleTokenRefresh = async (id: string) => {
    if (!onRefreshToken || refreshingTokenId) return;
    setRefreshingTokenId(id);
    try {
      await onRefreshToken(id);
    } finally {
      setRefreshingTokenId(null);
    }
  };

  const getStatusBadge = (status: AccountQuota['status']) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold rounded-full uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Active
          </span>
        );
      case 'WARNING':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold rounded-full uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Warning
          </span>
        );
      case 'EXPIRED':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] font-bold rounded-full uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
            Expired
          </span>
        );
      case 'LOW_QUOTA':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold rounded-full uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Low Quota
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 bg-slate-500/10 border border-slate-500/20 text-slate-400 text-[10px] font-bold rounded-full uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
            {status}
          </span>
        );
    }
  };

  const getAccountIcon = (account: AccountQuota) => (
    <div className={`w-11 h-11 rounded-2xl flex items-center justify-center bg-gradient-to-br ${avatarGradient(account.id)} text-white font-bold text-base shadow-md`}>
      {(account.name.charAt(0) || '?').toUpperCase()}
    </div>
  );

  return (
    <div className="flex-1 p-8 overflow-y-auto" id="quotas-view-container">
      {/* Title Header with Subtitle & Refresh All button */}
      <div className="flex items-center justify-between mb-8 select-none" id="quotas-view-title-row">
        <div className="flex flex-col" id="quotas-title-group">
          <h2 className="text-3xl font-bold tracking-tight text-white font-sans">
            配额总览
          </h2>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-300 font-medium font-sans" id="quotas-meta-row">
            <span className="flex items-center gap-1 text-slate-200">
              <RefreshCw className="w-3.5 h-3.5 text-blue-400" />
              已同步 {syncedCount}/{accounts.length}
            </span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-400">
              最近同步：{lastUpdatedAtMs !== null ? formatDateTime(lastUpdatedAtMs) : '等待同步'}
            </span>
          </div>
        </div>

        <motion.button
          onClick={onRefreshAll}
          disabled={isRefreshingAll}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          className="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-white/10 hover:bg-white/15 border border-white/10 text-white text-xs font-semibold tracking-wide transition-all shadow-lg cursor-pointer"
          id="quotas-btn-refresh-all-secondary"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingAll ? 'animate-spin text-blue-400' : ''}`} />
          全部刷新
        </motion.button>
      </div>

      {/* Top 3 Metric Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 select-none" id="quotas-metrics-grid">
        {/* Total Accounts */}
        <div 
          className="glass-card backdrop-blur-xl bg-slate-900/40 border border-white/5 rounded-3xl p-5 flex items-center gap-4 shadow-xl group"
          id="quota-stat-card-total"
        >
          <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
            <Users className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-slate-400 tracking-wider uppercase tabular-nums">账号总数</span>
            <span className="text-2xl font-bold text-white mt-0.5 tracking-tight">{totalAccounts}</span>
          </div>
        </div>

        {/* Action Required */}
        <div 
          className="glass-card backdrop-blur-xl bg-slate-900/40 border border-white/5 rounded-3xl p-5 flex items-center gap-4 shadow-xl group"
          id="quota-stat-card-action"
        >
          <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
            <Bell className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-slate-400 tracking-wider uppercase tabular-nums">需要处理</span>
            <span className="text-2xl font-bold text-white mt-0.5 tracking-tight">{actionRequiredCount}</span>
          </div>
        </div>

        {/* Avg Remaining */}
        <div 
          className="glass-card backdrop-blur-xl bg-slate-900/40 border border-white/5 rounded-3xl p-5 flex items-center gap-4 shadow-xl group"
          id="quota-stat-card-remaining"
        >
          <div className="w-12 h-12 rounded-2xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center text-teal-400">
            <BarChart3 className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-slate-400 tracking-wider uppercase tabular-nums">平均剩余</span>
            <span className="text-2xl font-bold text-white mt-0.5 tracking-tight">{avgRemaining}%</span>
          </div>
        </div>
      </div>

      {/* Empty state */}
      {accounts.length === 0 && (
        <div className="glass-card backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl px-8 py-16 flex flex-col items-center text-center shadow-xl" id="quotas-empty-state">
          <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 mb-4">
            <Users className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-bold text-white">还没有账号</h3>
          <p className="mt-2 max-w-xs text-xs leading-5 text-slate-400">前往“账号管理”页面添加你的第一个 Codex 账号，额度状态会在这里展示。</p>
        </div>
      )}

      {/* Grid of Main 4 Account Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" id="quotas-accounts-grid">
        <AnimatePresence initial={false}>
        {gridAccounts.map((account) => {
          const isCardRefreshing = refreshingCardId === account.id;
          const fiveHourPercentage = account.fiveHourQuotaRemaining == null
            ? null
            : Math.min((account.fiveHourQuotaRemaining / account.fiveHourQuotaTotal) * 100, 100);
          const weeklyPercentage = account.weeklyQuotaRemaining == null
            ? null
            : Math.min((account.weeklyQuotaRemaining / account.weeklyQuotaTotal) * 100, 100);
          const fiveHourExceeded = fiveHourPercentage === 0;
          const weeklyExceeded = weeklyPercentage === 0;
          const tokenRefreshUnavailable = account.status === 'SUSPENDED' || account.tokenRefreshAvailable === false;
          const accountRequiresReauthorization = account.status === 'SUSPENDED';

          // Progress color follows remaining quota: low red, medium amber, high green.
          const barColor5h = fiveHourPercentage == null
            ? "bg-slate-600/40"
            : fiveHourPercentage <= 25
            ? "bg-gradient-to-r from-rose-500/40 via-rose-400/50 to-rose-500/40 shadow-[0_0_12px_rgba(244,63,94,0.1)]"
            : fiveHourPercentage >= 70
              ? "bg-gradient-to-r from-emerald-500/40 via-green-400/50 to-emerald-500/40 shadow-[0_0_12px_rgba(52,211,153,0.15)]"
              : "bg-gradient-to-r from-amber-500/40 via-yellow-400/50 to-amber-500/40 shadow-[0_0_12px_rgba(251,191,36,0.1)]";

          const barColorWeekly = weeklyPercentage == null
            ? "bg-slate-600/40"
            : weeklyPercentage <= 25
            ? "bg-gradient-to-r from-rose-600/40 via-rose-500/50 to-rose-600/40 shadow-[0_0_12px_rgba(225,29,72,0.1)]"
            : weeklyPercentage >= 70
              ? "bg-gradient-to-r from-emerald-600/40 via-green-500/50 to-emerald-600/40 shadow-[0_0_12px_rgba(16,185,129,0.15)]"
              : "bg-gradient-to-r from-amber-600/40 via-yellow-500/50 to-amber-600/40 shadow-[0_0_12px_rgba(217,119,6,0.1)]";

          return (
            <motion.div
              layout
              key={account.id}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              whileHover={{ y: -4, borderColor: 'rgba(255,255,255,0.12)' }}
              transition={{ type: 'spring', stiffness: 350, damping: 28 }}
              className="glass-card backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex flex-col shadow-2xl relative overflow-hidden group"
              id={`quota-account-card-${account.id}`}
            >
              {/* Highlight Overlay on hover */}
              <div className="absolute inset-0 bg-white/[0.01] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

              {/* Card Header Row */}
              <div className="flex items-start justify-between mb-6" id={`quota-card-header-${account.id}`}>
                <div className="flex items-center gap-4" id={`quota-card-meta-${account.id}`}>
                  {getAccountIcon(account)}
                  <div className="flex flex-col select-all" id={`quota-card-titles-${account.id}`}>
                    <h3 className="font-bold text-slate-100 tracking-wide text-sm font-sans">{account.name}</h3>
                    <span className="text-xs text-slate-400 mt-0.5">{account.email}</span>
                  </div>
                </div>
                {getStatusBadge(account.status)}
              </div>

              {/* Quotas Progress Info */}
              <div className="space-y-4 flex-1 select-none" id={`quota-progress-container-${account.id}`}>
                {/* 5h Quota */}
                {fiveHourPercentage !== null && (
                <div className="space-y-1.5" id={`quota-5h-row-${account.id}`}>
                  <div className="flex items-center justify-between text-xs font-semibold" id={`quota-5h-labels-${account.id}`}>
                    <span className="text-slate-400">5 小时额度</span>
                    <span className="text-slate-300 tabular-nums">
                      {fiveHourExceeded ? '已用尽' : `剩余 ${Math.round(fiveHourPercentage)}%`}
                    </span>
                  </div>
                  <div className="h-1.5 bg-slate-950/50 rounded-full overflow-hidden relative" id={`quota-5h-bar-bg-${account.id}`}>
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${fiveHourPercentage}%` }}
                      transition={{ duration: 0.8, ease: 'easeOut' }}
                      className={`h-full rounded-full ${barColor5h}`} 
                    />
                  </div>
                </div>
                )}

                {/* Weekly Quota */}
                {weeklyPercentage !== null && (
                <div className="space-y-1.5 animate-pulse-slow" id={`quota-weekly-row-${account.id}`}>
                  <div className="flex items-center justify-between text-xs font-semibold" id={`quota-weekly-labels-${account.id}`}>
                    <span className="text-slate-400">周额度</span>
                    <span className="text-slate-300 tabular-nums">
                      {weeklyExceeded ? '已用尽' : `剩余 ${Math.round(weeklyPercentage)}%`}
                    </span>
                  </div>
                  <div className="h-1.5 bg-slate-950/50 rounded-full overflow-hidden relative" id={`quota-weekly-bar-bg-${account.id}`}>
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${weeklyPercentage}%` }}
                      transition={{ duration: 0.8, ease: 'easeOut' }}
                      className={`h-full rounded-full ${barColorWeekly}`} 
                    />
                  </div>
                </div>
                )}
                {fiveHourPercentage === null && weeklyPercentage === null && (
                  <div className="rounded-xl bg-slate-950/35 px-3 py-4 text-xs text-slate-400">
                    该账号未返回额度窗口数据。
                  </div>
                )}
              </div>

              {/* Action Buttons Row */}
              <div className="flex items-center gap-3 mt-6 pt-4 border-t border-white/5" id={`quota-actions-row-${account.id}`}>
                <motion.button
                  onClick={() => handleCardRefresh(account.id)}
                  disabled={isCardRefreshing || accountRequiresReauthorization}
                  title={accountRequiresReauthorization ? '该账号需要重新授权后才能刷新额度' : '刷新额度'}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.96 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                  className="flex-1 py-3 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 disabled:bg-white/5 disabled:border-white/5 disabled:text-slate-500 disabled:cursor-not-allowed text-blue-300 hover:text-blue-200 text-xs font-bold rounded-xl flex items-center justify-center gap-2 cursor-pointer transition-all"
                  id={`quota-btn-refresh-${account.id}`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isCardRefreshing ? 'animate-spin' : ''}`} />
                  {isCardRefreshing ? '刷新中...' : accountRequiresReauthorization ? '重新授权后刷新' : '快速刷新'}
                </motion.button>

                {/* More Action Popover Toggle */}
                <div className="relative" id={`quota-more-wrapper-${account.id}`}>
                  <motion.button
                    onClick={() => setActiveMenuId(activeMenuId === account.id ? null : account.id)}
                    whileHover={{ scale: 1.06 }}
                    whileTap={{ scale: 0.94 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                    className="p-3 bg-white/5 hover:bg-white/10 rounded-xl border border-white/5 text-slate-300 hover:text-white transition-all cursor-pointer"
                    id={`quota-btn-more-${account.id}`}
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </motion.button>

                  <AnimatePresence>
                    {activeMenuId === account.id && (
                      <>
                        <div 
                          className="fixed inset-0 z-10" 
                          onClick={() => setActiveMenuId(null)} 
                        />
                        <motion.div
                          initial={{ opacity: 0, scale: 0.95, y: 10 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: 10 }}
                          className="absolute right-0 bottom-full mb-2 w-48 backdrop-blur-xl bg-slate-900/95 border border-white/10 rounded-2xl p-2 shadow-2xl z-20 select-none text-slate-300"
                          id={`quota-more-dropdown-${account.id}`}
                        >
                          <button
                            onClick={() => {
                              setActiveMenuId(null);
                              void handleTokenRefresh(account.id);
                            }}
                            disabled={!onRefreshToken || refreshingTokenId !== null || tokenRefreshUnavailable}
                            aria-busy={refreshingTokenId === account.id}
                            id={`quota-menu-refresh-token-${account.id}`}
                            title={tokenRefreshUnavailable ? '该账号需要重新授权后才能刷新 Token' : '刷新 Token'}
                            className="w-full px-3 py-2 hover:bg-white/5 rounded-xl text-left text-xs text-rose-400 hover:text-rose-300 flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Activity className={`w-3.5 h-3.5 ${refreshingTokenId === account.id ? 'animate-spin' : ''}`} />
                            {refreshingTokenId === account.id ? '刷新中...' : tokenRefreshUnavailable ? '需要重新授权' : '刷新 Token'}
                          </button>
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          );
        })}
        </AnimatePresence>
      </div>
    </div>
  );
}

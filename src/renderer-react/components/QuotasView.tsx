import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Users, 
  Bell, 
  BarChart3, 
  Cloud, 
  Database, 
  AlertTriangle, 
  Play, 
  MoreHorizontal, 
  RefreshCw, 
  RotateCcw,
  Sparkles,
  HelpCircle,
  Activity,
  CheckCircle2,
  XCircle
} from 'lucide-react';
import { AccountQuota } from '../types';

interface QuotasProps {
  accounts: AccountQuota[];
  onRefreshAccount: (id: string) => void | Promise<void>;
  onResetAccount: (id: string) => void | Promise<void>;
  onRefreshToken?: (id: string) => void | Promise<void>;
  onRefreshAll: () => void | Promise<void>;
  isRefreshingAll: boolean;
}

export default function QuotasView({
  accounts,
  onRefreshAccount,
  onResetAccount,
  onRefreshToken,
  onRefreshAll,
  isRefreshingAll,
}: QuotasProps) {
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [refreshingCardId, setRefreshingCardId] = useState<string | null>(null);

  const gridAccounts = accounts;

  // Calculate dynamic stats
  const totalAccounts = accounts.length;
  const actionRequiredCount = accounts.filter(acc => acc.status === 'EXPIRED' || acc.status === 'WARNING' || acc.status === 'SUSPENDED').length;
  
  // Calculate average quota remaining
  const avgRemaining = Math.round(
    accounts.length ? accounts.reduce((acc, curr) => {
      const remainingPct = (curr.fiveHourQuotaUsed / curr.fiveHourQuotaTotal) * 100;
      return acc + remainingPct;
    }, 0) / accounts.length : 0
  );

  const syncedCount = accounts.filter(acc => acc.quotaUpdatedAt && !acc.quotaError).length;

  const handleCardRefresh = async (id: string) => {
    setRefreshingCardId(id);
    try {
      await onRefreshAccount(id);
    } finally {
      setRefreshingCardId(null);
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

  const getAccountIcon = (id: string, status: AccountQuota['status']) => {
    const baseClasses = "w-11 h-11 rounded-2xl flex items-center justify-center border shadow-md";
    if (id === '1') {
      return (
        <div className={`${baseClasses} bg-blue-500/15 border-blue-500/25 text-blue-400`}>
          <Cloud className="w-5 h-5" />
        </div>
      );
    }
    if (id === '2') {
      return (
        <div className={`${baseClasses} bg-amber-500/15 border-amber-500/25 text-amber-400`}>
          <Database className="w-5 h-5" />
        </div>
      );
    }
    if (id === '3') {
      return (
        <div className={`${baseClasses} bg-rose-500/15 border-rose-500/25 text-rose-400`}>
          <AlertTriangle className="w-5 h-5 animate-bounce-slow" />
        </div>
      );
    }
    return (
      <div className={`${baseClasses} bg-cyan-500/15 border-cyan-500/25 text-cyan-400`}>
        <Sparkles className="w-5 h-5" />
      </div>
    );
  };

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
              <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin-slow" />
              已同步 {syncedCount}/{accounts.length}
            </span>
            <span className="text-slate-400">|</span>
            <span className="text-slate-400">Last updated: {syncedCount ? 'Synced' : 'Waiting for sync'}</span>
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
          Refresh All
        </motion.button>
      </div>

      {/* Top 3 Metric Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 select-none" id="quotas-metrics-grid">
        {/* Total Accounts */}
        <motion.div 
          whileHover={{ y: -4, scale: 1.02, borderColor: 'rgba(255,255,255,0.1)' }}
          whileTap={{ scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 450, damping: 25 }}
          className="backdrop-blur-xl bg-slate-900/40 border border-white/5 rounded-3xl p-5 flex items-center gap-4 hover:border-white/10 transition-all shadow-xl group cursor-pointer"
          id="quota-stat-card-total"
        >
          <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 group-hover:scale-105 transition-all">
            <Users className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-slate-400 tracking-wider uppercase font-mono">TOTAL ACCOUNTS</span>
            <span className="text-2xl font-bold text-white mt-0.5 tracking-tight">{totalAccounts}</span>
          </div>
        </motion.div>

        {/* Action Required */}
        <motion.div 
          whileHover={{ y: -4, scale: 1.02, borderColor: 'rgba(255,255,255,0.1)' }}
          whileTap={{ scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 450, damping: 25 }}
          className="backdrop-blur-xl bg-slate-900/40 border border-white/5 rounded-3xl p-5 flex items-center gap-4 hover:border-white/10 transition-all shadow-xl group cursor-pointer"
          id="quota-stat-card-action"
        >
          <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 group-hover:scale-105 transition-all">
            <Bell className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-slate-400 tracking-wider uppercase font-mono">ACTION REQUIRED</span>
            <span className="text-2xl font-bold text-white mt-0.5 tracking-tight">{actionRequiredCount}</span>
          </div>
        </motion.div>

        {/* Avg Remaining */}
        <motion.div 
          whileHover={{ y: -4, scale: 1.02, borderColor: 'rgba(255,255,255,0.1)' }}
          whileTap={{ scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 450, damping: 25 }}
          className="backdrop-blur-xl bg-slate-900/40 border border-white/5 rounded-3xl p-5 flex items-center gap-4 hover:border-white/10 transition-all shadow-xl group cursor-pointer"
          id="quota-stat-card-remaining"
        >
          <div className="w-12 h-12 rounded-2xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center text-teal-400 group-hover:scale-105 transition-all">
            <BarChart3 className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-slate-400 tracking-wider uppercase font-mono">AVG REMAINING</span>
            <span className="text-2xl font-bold text-white mt-0.5 tracking-tight">{avgRemaining}%</span>
          </div>
        </motion.div>
      </div>

      {/* Grid of Main 4 Account Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" id="quotas-accounts-grid">
        {gridAccounts.map((account) => {
          const isCardRefreshing = refreshingCardId === account.id;
          const fiveHourPercentage = Math.min((account.fiveHourQuotaUsed / account.fiveHourQuotaTotal) * 100, 100);
          const weeklyPercentage = Math.min((account.weeklyQuotaUsed / account.weeklyQuotaTotal) * 100, 100);
          const isExceeded = account.status === 'EXPIRED';
          const hasResetCredits = Number(account.resetCreditsAvailable || 0) > 0;

          // Progress bar color selection
          let barColor5h = "bg-gradient-to-r from-teal-500/40 via-teal-400/50 to-cyan-500/40 shadow-[0_0_12px_rgba(45,212,191,0.15)]";
          if (account.status === 'WARNING') barColor5h = "bg-gradient-to-r from-amber-500/40 via-yellow-400/50 to-amber-500/40 shadow-[0_0_12px_rgba(251,191,36,0.1)]";
          if (account.status === 'EXPIRED') barColor5h = "bg-gradient-to-r from-rose-500/40 via-rose-400/50 to-rose-500/40 shadow-[0_0_12px_rgba(244,63,94,0.1)]";

          let barColorWeekly = "bg-gradient-to-r from-blue-500/40 via-indigo-400/50 to-cyan-500/40 shadow-[0_0_12px_rgba(99,102,241,0.15)]";
          if (account.status === 'WARNING') barColorWeekly = "bg-gradient-to-r from-amber-600/40 via-yellow-500/50 to-amber-600/40 shadow-[0_0_12px_rgba(217,119,6,0.1)]";
          if (account.status === 'EXPIRED') barColorWeekly = "bg-gradient-to-r from-rose-600/40 via-rose-500/50 to-rose-600/40 shadow-[0_0_12px_rgba(225,29,72,0.1)]";

          return (
            <motion.div
              layout
              key={account.id}
              whileHover={{ y: -4, borderColor: 'rgba(255,255,255,0.12)' }}
              transition={{ type: 'spring', stiffness: 350, damping: 25 }}
              className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex flex-col shadow-2xl relative overflow-hidden transition-all duration-300 group"
              id={`quota-account-card-${account.id}`}
            >
              {/* Highlight Overlay on hover */}
              <div className="absolute inset-0 bg-white/[0.01] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

              {/* Card Header Row */}
              <div className="flex items-start justify-between mb-6" id={`quota-card-header-${account.id}`}>
                <div className="flex items-center gap-4" id={`quota-card-meta-${account.id}`}>
                  {getAccountIcon(account.id, account.status)}
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
                <div className="space-y-1.5" id={`quota-5h-row-${account.id}`}>
                  <div className="flex items-center justify-between text-xs font-semibold" id={`quota-5h-labels-${account.id}`}>
                    <span className="text-slate-400">5h Quota</span>
                    <span className="text-slate-300 font-mono">
                      {isExceeded ? 'EXCEEDED' : `${Math.round(fiveHourPercentage)}% remaining`}
                    </span>
                  </div>
                  <div className="h-1 bg-slate-950/40 border border-white/[0.03] shadow-[inset_0_1px_1px_rgba(0,0,0,0.5)] rounded-full overflow-hidden relative" id={`quota-5h-bar-bg-${account.id}`}>
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${fiveHourPercentage}%` }}
                      transition={{ duration: 0.8, ease: 'easeOut' }}
                      className={`h-full rounded-full ${barColor5h}`} 
                    />
                  </div>
                </div>

                {/* Weekly Quota */}
                <div className="space-y-1.5 animate-pulse-slow" id={`quota-weekly-row-${account.id}`}>
                  <div className="flex items-center justify-between text-xs font-semibold" id={`quota-weekly-labels-${account.id}`}>
                    <span className="text-slate-400">Weekly Quota</span>
                    <span className="text-slate-300 font-mono">
                      {isExceeded ? 'EXCEEDED' : `${Math.round(weeklyPercentage)}% remaining`}
                    </span>
                  </div>
                  <div className="h-1 bg-slate-950/40 border border-white/[0.03] shadow-[inset_0_1px_1px_rgba(0,0,0,0.5)] rounded-full overflow-hidden relative" id={`quota-weekly-bar-bg-${account.id}`}>
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${weeklyPercentage}%` }}
                      transition={{ duration: 0.8, ease: 'easeOut' }}
                      className={`h-full rounded-full ${barColorWeekly}`} 
                    />
                  </div>
                </div>
              </div>

              {/* Action Buttons Row */}
              <div className="flex items-center gap-3 mt-6 pt-4 border-t border-white/5" id={`quota-actions-row-${account.id}`}>
                {isExceeded && hasResetCredits ? (
                  <motion.button
                    onClick={() => onResetAccount(account.id)}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.96 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                    className="flex-1 py-3 bg-rose-500/10 hover:bg-rose-500/15 border border-rose-500/25 text-rose-300 hover:text-rose-200 text-xs font-bold rounded-2xl flex items-center justify-center gap-2 cursor-pointer transition-all"
                    id={`quota-btn-reset-${account.id}`}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset Account
                  </motion.button>
                ) : (
                  <motion.button
                    onClick={() => handleCardRefresh(account.id)}
                    disabled={isCardRefreshing}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.96 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                    className="flex-1 py-3 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 disabled:bg-white/5 disabled:border-white/5 disabled:text-slate-500 text-blue-300 hover:text-blue-200 text-xs font-bold rounded-2xl flex items-center justify-center gap-2 cursor-pointer transition-all"
                    id={`quota-btn-refresh-${account.id}`}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isCardRefreshing ? 'animate-spin' : ''}`} />
                    {isCardRefreshing ? 'Refreshing...' : 'Quick Refresh'}
                  </motion.button>
                )}

                {/* More Action Popover Toggle */}
                <div className="relative" id={`quota-more-wrapper-${account.id}`}>
                  <motion.button
                    onClick={() => setActiveMenuId(activeMenuId === account.id ? null : account.id)}
                    whileHover={{ scale: 1.06 }}
                    whileTap={{ scale: 0.94 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                    className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl border border-white/5 text-slate-300 hover:text-white transition-all cursor-pointer"
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
                              handleCardRefresh(account.id);
                            }}
                            disabled={!hasResetCredits}
                            className="w-full px-3 py-2 hover:bg-white/5 rounded-xl text-left text-xs flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <RefreshCw className="w-3.5 h-3.5 text-blue-400" />
                            立即同步
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenuId(null);
                              onResetAccount(account.id);
                            }}
                            className="w-full px-3 py-2 hover:bg-white/5 rounded-xl text-left text-xs flex items-center gap-2 cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5 text-rose-400" />
                            重置统计
                          </button>
                          <div className="h-[1px] bg-white/5 my-1" />
                          <button
                            onClick={() => {
                              setActiveMenuId(null);
                              onRefreshToken?.(account.id);
                            }}
                            disabled={!onRefreshToken}
                            className="w-full px-3 py-2 hover:bg-white/5 rounded-xl text-left text-xs text-rose-400 hover:text-rose-300 flex items-center gap-2 cursor-pointer"
                          >
                            <Activity className="w-3.5 h-3.5" />
                            刷新 Token
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
      </div>
    </div>
  );
}

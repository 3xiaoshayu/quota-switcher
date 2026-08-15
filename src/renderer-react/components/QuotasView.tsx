import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  AtSign, 
  Bell, 
  BarChart3, 
  MoreHorizontal, 
  RefreshCw, 
  Activity
} from 'lucide-react';
import { AccountQuota } from '../types';
import { avatarGradient, canRefreshQuota, formatDateTime, hideStaleQuota, needsHandling, quotaBarColor, quotaSummaryPercent, quotaWindowSummary, STATUS_DOT, STATUS_TEXT } from '../api/desktop';

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

  // backdrop-filter on the cards turns them into containing blocks for fixed
  // descendants, so a click-away overlay can never cover the page; close the
  // menu from a document-level listener instead.
  useEffect(() => {
    if (!activeMenuId) return;
    const close = () => setActiveMenuId(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [activeMenuId]);
  const [refreshingCardIds, setRefreshingCardIds] = useState<Set<string>>(new Set());
  const [refreshingTokenId, setRefreshingTokenId] = useState<string | null>(null);

  const gridAccounts = accounts;

  // Calculate dynamic stats
  const totalAccounts = accounts.length;
  const actionRequiredCount = accounts.filter(needsHandling).length;
  
  // Calculate average quota remaining
  const visibleQuotaPercentages = accounts.flatMap((account) => {
    if (hideStaleQuota(account)) return [];
    const percentages: number[] = [];
    if (account.fiveHourQuotaRemaining != null) {
      percentages.push((account.fiveHourQuotaRemaining / account.fiveHourQuotaTotal) * 100);
    }
    if (account.weeklyQuotaRemaining != null) {
      percentages.push((account.weeklyQuotaRemaining / account.weeklyQuotaTotal) * 100);
    }
    return percentages;
  });
  const avgRemaining = visibleQuotaPercentages.length
    ? `${Math.round(visibleQuotaPercentages.reduce((sum, percentage) => sum + percentage, 0) / visibleQuotaPercentages.length)}%`
    : '--';

  const syncedCount = accounts.filter(acc => acc.quotaUpdatedAt && !acc.quotaError).length;
  const lastUpdatedAtMs = accounts.reduce<number | null>((latest, account) => {
    const updated = toEpochMs(account.quotaUpdatedAt);
    if (updated === null) return latest;
    return latest === null || updated > latest ? updated : latest;
  }, null);

  const handleCardRefresh = async (id: string) => {
    if (refreshingCardIds.has(id)) return;
    setRefreshingCardIds(prev => new Set(prev).add(id));
    try {
      await onRefreshAccount(id);
    } catch {
      // The app-level handler already reports the error through toast/log state.
    } finally {
      setRefreshingCardIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
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

  const getStatusBadge = (status: AccountQuota['status']) => (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-label-2">
      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] || 'bg-fill-3'}`} />
      {STATUS_TEXT[status] || status}
    </span>
  );

  const getAccountIcon = (account: AccountQuota) => (
    <div className={`w-11 h-11 rounded-full flex items-center justify-center ${avatarGradient(account.id)} font-semibold text-base`}>
      {(account.name.charAt(0) || '?').toUpperCase()}
    </div>
  );

  return (
    <div className="flex-1 p-8 overflow-y-auto" id="quotas-view-container">
      {/* Title Header with Subtitle & Refresh All button */}
      <div className="flex items-center justify-between mb-8 select-none" id="quotas-view-title-row">
        <div className="flex flex-col" id="quotas-title-group">
          <h2 className="text-[28px] font-bold tracking-tight text-label font-sans">
            配额总览
          </h2>
          <p className="mt-1.5 text-[13px] text-label-2 font-sans" id="quotas-meta-row">
            已同步 {syncedCount}/{accounts.length} · 最近同步 {lastUpdatedAtMs !== null ? formatDateTime(lastUpdatedAtMs) : '等待同步'}
          </p>
        </div>

        <motion.button
          onClick={onRefreshAll}
          disabled={isRefreshingAll}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          className="flex items-center gap-2 px-4 py-2 rounded-[10px] bg-fill-2 hover:bg-fill-3 text-label text-[13px] font-medium transition-colors cursor-pointer"
          id="quotas-btn-refresh-all-secondary"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingAll ? 'animate-spin text-accent' : ''}`} />
          全部刷新
        </motion.button>
      </div>

      {/* Top 3 Metric Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 select-none" id="quotas-metrics-grid">
        {/* Total Accounts */}
        <div 
          className="glass-card rounded-2xl p-5 flex items-center gap-4 group"
          id="quota-stat-card-total"
        >
          <div className="w-11 h-11 rounded-[10px] bg-fill-2 flex items-center justify-center text-label-2">
            <AtSign className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] font-medium text-label-3">账号总数</span>
            <span className="text-[22px] font-semibold text-label mt-0.5 tracking-tight tabular-nums">{totalAccounts}</span>
          </div>
        </div>

        {/* Action Required */}
        <div 
          className="glass-card rounded-2xl p-5 flex items-center gap-4 group"
          id="quota-stat-card-action"
        >
          <div className="w-11 h-11 rounded-[10px] bg-danger/15 flex items-center justify-center text-danger">
            <Bell className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] font-medium text-label-3">需要处理</span>
            <span className="text-[22px] font-semibold text-label mt-0.5 tracking-tight tabular-nums">{actionRequiredCount}</span>
          </div>
        </div>

        {/* Avg Remaining */}
        <div 
          className="glass-card rounded-2xl p-5 flex items-center gap-4 group"
          id="quota-stat-card-remaining"
        >
          <div className="w-11 h-11 rounded-[10px] bg-teal/15 flex items-center justify-center text-teal">
            <BarChart3 className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] font-medium text-label-3">平均剩余</span>
            <span className="text-[22px] font-semibold text-label mt-0.5 tracking-tight tabular-nums">{avgRemaining}</span>
          </div>
        </div>
      </div>

      {/* Empty state */}
      {accounts.length === 0 && (
        <div className="glass-card rounded-2xl px-8 py-16 flex flex-col items-center text-center" id="quotas-empty-state">
          <div className="w-14 h-14 rounded-xl bg-fill-2 flex items-center justify-center text-label-2 mb-4">
            <AtSign className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-bold text-white">还没有账号</h3>
          <p className="mt-2 max-w-xs text-xs leading-5 text-label-2">前往“账号管理”页面添加你的第一个 Codex 账号，额度状态会在这里展示。</p>
        </div>
      )}

      {/* Grid of Main 4 Account Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" id="quotas-accounts-grid">
        <AnimatePresence initial={false}>
        {gridAccounts.map((account) => {
          const isCardRefreshing = refreshingCardIds.has(account.id);
          const fiveHourSummary = quotaWindowSummary('fiveHour', account);
          const weeklySummary = quotaWindowSummary('weekly', account);
          const fiveHourPercentage = quotaSummaryPercent(fiveHourSummary.text);
          const weeklyPercentage = quotaSummaryPercent(weeklySummary.text);
          const fiveHourBar = fiveHourSummary.text === '已用尽' ? 0 : fiveHourPercentage;
          const weeklyBar = weeklySummary.text === '已用尽' ? 0 : weeklyPercentage;
          const tokenRefreshUnavailable = account.status === 'SUSPENDED' || account.status === 'BANNED' || account.tokenRefreshAvailable === false;
          const accountBanned = account.status === 'BANNED';
          const refreshBlocked = !canRefreshQuota(account);

          const barColor5h = quotaBarColor(fiveHourBar);
          const barColorWeekly = quotaBarColor(weeklyBar);

          return (
            <motion.div
              layout
              key={account.id}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 350, damping: 28 }}
              className="glass-card rounded-2xl p-6 flex flex-col relative overflow-hidden group"
              id={`quota-account-card-${account.id}`}
            >
              {/* Highlight Overlay on hover */}
              <div className="absolute inset-0 bg-white/[0.01] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

              {/* Card Header Row */}
              <div className="flex items-start justify-between mb-6" id={`quota-card-header-${account.id}`}>
                <div className="flex items-center gap-4" id={`quota-card-meta-${account.id}`}>
                  {getAccountIcon(account)}
                  <div className="flex flex-col select-all" id={`quota-card-titles-${account.id}`}>
                    <h3 className="font-bold text-label tracking-wide text-sm font-sans">{account.name}</h3>
                    <span className="text-xs text-label-2 mt-0.5">{account.email}</span>
                  </div>
                </div>
                {getStatusBadge(account.status)}
              </div>

              {account.warning ? (
                <p className={`mb-4 text-[12px] leading-5 ${account.status === 'BANNED' ? 'text-danger' : 'text-warn'}`} id={`quota-card-notice-${account.id}`}>
                  {account.warning}
                </p>
              ) : null}

              {/* Quotas Progress Info */}
              <div className="space-y-4 flex-1 select-none" id={`quota-progress-container-${account.id}`}>
                {/* 5h Quota (kept visible even while upstream omits the window) */}
                <div className="space-y-1.5" id={`quota-5h-row-${account.id}`}>
                  <div className="flex items-center justify-between text-xs font-semibold" id={`quota-5h-labels-${account.id}`}>
                    <span className="text-label-2">5 小时额度</span>
                    <span className={`tabular-nums ${fiveHourPercentage === null ? 'text-label-3' : 'text-label-2'}`}>
                      {fiveHourSummary.text === '已用尽' ? '已用尽' : fiveHourPercentage === null ? fiveHourSummary.text : `剩余 ${fiveHourPercentage}%`}
                    </span>
                  </div>
                  <div className="h-1 bg-fill rounded-full overflow-hidden relative" id={`quota-5h-bar-bg-${account.id}`}>
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${fiveHourBar ?? 0}%` }}
                      transition={{ duration: 0.8, ease: 'easeOut' }}
                      className={`h-full rounded-full ${barColor5h}`} 
                    />
                  </div>
                </div>

                {/* Weekly Quota */}
                <div className="space-y-1.5" id={`quota-weekly-row-${account.id}`}>
                  <div className="flex items-center justify-between text-xs font-semibold" id={`quota-weekly-labels-${account.id}`}>
                    <span className="text-label-2">周额度</span>
                    <span className={`tabular-nums ${weeklyPercentage === null ? 'text-label-3' : 'text-label-2'}`}>
                      {weeklySummary.text === '已用尽' ? '已用尽' : weeklyPercentage === null ? weeklySummary.text : `剩余 ${weeklyPercentage}%`}
                    </span>
                  </div>
                  <div className="h-1 bg-fill rounded-full overflow-hidden relative" id={`quota-weekly-bar-bg-${account.id}`}>
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${weeklyBar ?? 0}%` }}
                      transition={{ duration: 0.8, ease: 'easeOut' }}
                      className={`h-full rounded-full ${barColorWeekly}`} 
                    />
                  </div>
                </div>
              </div>

              {/* Action Buttons Row */}
              <div className="flex items-center gap-3 mt-6 pt-4 border-t border-sep" id={`quota-actions-row-${account.id}`}>
                <motion.button
                  onClick={() => handleCardRefresh(account.id)}
                  disabled={isCardRefreshing || refreshBlocked}
                  title={refreshBlocked
                    ? (accountBanned ? '账号已封号，无法刷新额度' : '该账号需要重新授权后才能刷新额度')
                    : '刷新额度'}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.96 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                  className="flex-1 py-3 bg-accent/12 hover:bg-accent/20 border border-accent/20 disabled:bg-fill disabled:border-sep disabled:text-label-3 disabled:cursor-not-allowed disabled:opacity-40 text-accent hover:text-accent-hi text-xs font-bold rounded-xl flex items-center justify-center gap-2 cursor-pointer transition-all"
                  id={`quota-btn-refresh-${account.id}`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isCardRefreshing ? 'animate-spin' : ''}`} />
                  {isCardRefreshing ? '刷新中...' : '快速刷新'}
                </motion.button>

                {/* More Action Popover Toggle */}
                <div className="relative" id={`quota-more-wrapper-${account.id}`}>
                  <motion.button
                    onClick={(event) => {
                      event.stopPropagation();
                      setActiveMenuId(activeMenuId === account.id ? null : account.id);
                    }}
                    whileHover={{ scale: 1.06 }}
                    whileTap={{ scale: 0.94 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                    className="p-3 bg-fill hover:bg-fill-2 rounded-xl border border-sep text-label-2 hover:text-white transition-all cursor-pointer"
                    id={`quota-btn-more-${account.id}`}
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </motion.button>

                  <AnimatePresence>
                    {activeMenuId === account.id && (
                      <>
                        <motion.div
                          onClick={(event) => event.stopPropagation()}
                          initial={{ opacity: 0, scale: 0.95, y: 10 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: 10 }}
                          className="absolute right-0 bottom-full mb-2 w-48 bg-surface-2 border border-sep rounded-xl p-2 shadow-xl z-20 select-none text-label-2"
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
                            title={accountBanned ? '账号已封号，不再刷新令牌' : (tokenRefreshUnavailable ? '该账号需要重新授权后才能刷新 Token' : '刷新 Token')}
                            className="w-full px-3 py-2 hover:bg-fill rounded-xl text-left text-xs text-danger hover:text-danger flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Activity className={`w-3.5 h-3.5 ${refreshingTokenId === account.id ? 'animate-spin' : ''}`} />
                            {refreshingTokenId === account.id ? '刷新中...' : '刷新 Token'}
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

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Users, 
  Award, 
  Plus, 
  Search, 
  User, 
  AlertTriangle, 
  ArrowLeftRight, 
  Trash2, 
  Star,
  X,
  Mail,
  KeyRound,
  Link,
  RefreshCw
} from 'lucide-react';
import { AccountQuota, DesktopOAuthStatus } from '../types';
import { avatarGradient } from '../api/desktop';

interface AccountsProps {
  accounts: AccountQuota[];
  onAddAccount: (acc: Omit<AccountQuota, 'id'>) => void | Promise<void>;
  onDeleteAccount: (id: string) => void | Promise<void>;
  onSwitchCurrentAccount: (id: string) => void | Promise<void>;
  onRefreshAccount: (id: string) => void | Promise<void>;
  onAddLog: (msg: string, type: 'success' | 'info' | 'warning' | 'error') => void;
  onReauthorizeAccount?: (id: string) => void | Promise<void>;
  onCancelOAuth?: () => void | Promise<void>;
  onCompleteOAuthManually?: (callbackUrl: string) => void | Promise<void>;
  oauthMode?: boolean;
  oauthStatus?: DesktopOAuthStatus | null;
}

export default function AccountsView({
  accounts,
  onAddAccount,
  onDeleteAccount,
  onSwitchCurrentAccount,
  onRefreshAccount,
  onAddLog,
  onReauthorizeAccount,
  onCancelOAuth,
  onCompleteOAuthManually,
  oauthMode = false,
  oauthStatus = null,
}: AccountsProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'current' | 'warning'>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [reauthorizeId, setReauthorizeId] = useState<string | null>(null);
  const [manualCallbackUrl, setManualCallbackUrl] = useState('');
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isRecoveredOAuth, setIsRecoveredOAuth] = useState(false);

  // New account form state
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPlan, setNewPlan] = useState<'Pro Plan' | 'Standard' | 'Enterprise'>('Pro Plan');
  const [newPriority, setNewPriority] = useState<AccountQuota['priority']>('Normal');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (!oauthMode) return;
    if (oauthStatus?.pending) {
      setIsRecoveredOAuth(true);
      setShowAddModal(true);
      setIsAdding(true);
      setReauthorizeId(oauthStatus.targetAccountId || null);
      return;
    }
    if (!isRecoveredOAuth) return;
    setIsRecoveredOAuth(false);
    setIsAdding(false);
    setShowAddModal(false);
    setReauthorizeId(null);
    setManualCallbackUrl('');
    setFormError('');
  }, [isRecoveredOAuth, oauthMode, oauthStatus?.pending, oauthStatus?.targetAccountId]);

  // Escape closes the add-account modal, except while an OAuth authorization
  // is pending (cancelling that must be an explicit choice).
  useEffect(() => {
    if (!showAddModal) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isAdding) return;
      setShowAddModal(false);
      setReauthorizeId(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddModal, isAdding]);

  // Handle single card refresh animation
  const handleSingleRefresh = async (id: string, name: string) => {
    setRefreshingId(id);
    onAddLog(`Refreshing account status for ${name}...`, 'info');
    try {
      await onRefreshAccount(id);
      onAddLog(`Account ${name} refreshed successfully.`, 'success');
    } catch (error) {
      onAddLog(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setRefreshingId(null);
    }
  };

  const handleSwitchAccount = async (id: string) => {
    if (switchingId) return;
    setSwitchingId(id);
    try {
      await onSwitchCurrentAccount(id);
    } catch (error) {
      onAddLog(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setSwitchingId(null);
    }
  };

  const handleDeleteAccount = async (id: string) => {
    if (deletingId || switchingId) return;
    setDeletingId(id);
    try {
      await onDeleteAccount(id);
    } catch (error) {
      onAddLog(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setDeletingId(null);
    }
  };

  // Filter accounts
  const filteredAccounts = accounts.filter(acc => {
    // Search filter
    const matchesSearch = acc.email.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          acc.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          acc.plan.toLowerCase().includes(searchTerm.toLowerCase());
    
    if (!matchesSearch) return false;

    // Tabs filter
    if (filterTab === 'current') return acc.isCurrent;
    if (filterTab === 'warning') {
      return acc.status === 'WARNING' || acc.status === 'EXPIRED' || acc.status === 'SUSPENDED' || acc.status === 'LOW_QUOTA';
    }
    
    return true;
  });

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oauthMode && (!newEmail || !newName)) {
      setFormError('请完整填写所有必填字段');
      return;
    }
    if (!oauthMode && !newEmail.includes('@')) {
      setFormError('请输入有效的电子邮件地址');
      return;
    }

    setIsAdding(true);
    try {
      const formAccount: Omit<AccountQuota, 'id'> = {
        name: newName || 'OAuth account',
        email: newEmail || 'oauth@pending.local',
        status: 'ACTIVE',
        fiveHourQuotaRemaining: 100,
        fiveHourQuotaTotal: 100,
        weeklyQuotaRemaining: 100,
        weeklyQuotaTotal: 100,
        priority: newPriority,
        plan: newPlan,
        tokenValidity: 'Pending OAuth',
        resetInFiveHour: 'Waiting',
        resetInWeekly: 'Waiting',
      };
      if (reauthorizeId && onReauthorizeAccount) await onReauthorizeAccount(reauthorizeId);
      else await onAddAccount(formAccount);

      onAddLog(oauthMode ? 'OAuth account flow completed.' : `Created new account: ${newEmail} (${newPlan})`, 'success');
      setNewEmail('');
      setNewName('');
      setNewPlan('Pro Plan');
      setNewPriority('Normal');
      setFormError('');
      setReauthorizeId(null);
      setManualCallbackUrl('');
      setShowAddModal(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAdding(false);
    }
  };

  const currentPlan = accounts.find(account => account.isCurrent)?.plan || 'Unknown';

  return (
    <div className="flex-1 p-8 overflow-y-auto select-none" id="accounts-view-container">
      {/* Title block with stats & action triggers */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8" id="accounts-header-row">
        <div className="flex flex-col" id="accounts-title-block">
          <h2 className="text-3xl font-bold tracking-tight text-white font-sans">
            账号管理
          </h2>
          <div className="flex items-center gap-4 mt-2.5 text-xs text-slate-300 font-medium font-sans" id="accounts-meta-labels">
            <span className="flex items-center gap-1.5 text-slate-200">
              <Users className="w-3.5 h-3.5 text-blue-400" />
              账号总数: {accounts.length}
            </span>
            <span className="text-slate-500">·</span>
            <span className="flex items-center gap-1.5 text-amber-300 font-bold">
              <Award className="w-3.5 h-3.5 text-amber-400" />
              当前套餐: {currentPlan}
            </span>
          </div>
        </div>

        {/* Action button triggers */}
        <div className="flex items-center gap-3 shrink-0" id="accounts-actions-group">
          <motion.button
            onClick={() => {
              setReauthorizeId(null);
              setFormError('');
              setShowAddModal(true);
            }}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            className="flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 text-blue-300 hover:text-blue-200 text-xs font-bold transition-all cursor-pointer shadow-lg"
            id="btn-add-account-modal-trigger"
          >
            <Plus className="w-4 h-4" />
            添加账号
          </motion.button>
        </div>
      </div>

      {/* Filters & Search Control Bar */}
      <div 
        className="glass-card backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8 shadow-md"
        id="accounts-search-filter-row"
      >
        {/* Search input with icon */}
        <div className="relative flex-1 max-w-md" id="accounts-search-group">
          <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400 pointer-events-none">
            <Search className="w-4 h-4" />
          </span>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索邮箱或计划..."
            className="w-full pl-10 pr-4 py-2.5 bg-slate-950/40 border border-white/5 rounded-2xl text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all text-xs font-sans font-medium"
            id="accounts-search-input"
          />
        </div>

        {/* Tab Filters capsule */}
        <div className="flex bg-slate-950/40 p-1 rounded-2xl border border-white/5 text-xs font-semibold relative" id="accounts-filter-tabs">
          <button
            onClick={() => setFilterTab('all')}
            className={`px-5 py-2.5 rounded-xl transition-all relative cursor-pointer z-10 ${
              filterTab === 'all' ? 'text-white font-bold' : 'text-slate-400 hover:text-slate-300'
            }`}
            id="filter-tab-all"
          >
            {filterTab === 'all' && (
              <motion.div
                layoutId="accountsActiveFilterBg"
                className="absolute inset-0 bg-white/10 rounded-xl -z-10"
                transition={{ type: 'spring', stiffness: 450, damping: 25 }}
              />
            )}
            全部
          </button>
          <button
            onClick={() => setFilterTab('current')}
            className={`px-5 py-2.5 rounded-xl transition-all relative cursor-pointer z-10 ${
              filterTab === 'current' ? 'text-white font-bold' : 'text-slate-400 hover:text-slate-300'
            }`}
            id="filter-tab-current"
          >
            {filterTab === 'current' && (
              <motion.div
                layoutId="accountsActiveFilterBg"
                className="absolute inset-0 bg-white/10 rounded-xl -z-10"
                transition={{ type: 'spring', stiffness: 450, damping: 25 }}
              />
            )}
            当前
          </button>
          <button
            onClick={() => setFilterTab('warning')}
            className={`px-5 py-2.5 rounded-xl transition-all relative cursor-pointer z-10 flex items-center gap-1.5 ${
              filterTab === 'warning' ? 'text-white font-bold' : 'text-slate-400 hover:text-slate-300'
            }`}
            id="filter-tab-warning"
          >
            {filterTab === 'warning' && (
              <motion.div
                layoutId="accountsActiveFilterBg"
                className="absolute inset-0 bg-white/10 rounded-xl -z-10"
                transition={{ type: 'spring', stiffness: 450, damping: 25 }}
              />
            )}
            需要操作
            {accounts.filter(acc => acc.status === 'WARNING' || acc.status === 'EXPIRED' || acc.status === 'LOW_QUOTA' || acc.status === 'SUSPENDED').length > 0 && (
              <span className="px-1.5 py-0.5 bg-rose-500 text-white rounded-full text-[9px] font-bold">
                {accounts.filter(acc => acc.status === 'WARNING' || acc.status === 'EXPIRED' || acc.status === 'LOW_QUOTA' || acc.status === 'SUSPENDED').length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Empty state */}
      {filteredAccounts.length === 0 && (
        <div className="glass-card backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl px-8 py-16 flex flex-col items-center text-center shadow-xl" id="accounts-empty-state">
          <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 mb-4">
            <Users className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-bold text-white">{accounts.length === 0 ? '还没有账号' : '没有匹配的账号'}</h3>
          <p className="mt-2 max-w-xs text-xs leading-5 text-slate-400">
            {accounts.length === 0 ? '通过 OAuth 授权添加你的第一个 Codex 账号。' : '换个关键词，或切换筛选条件再试试。'}
          </p>
          {accounts.length === 0 && (
            <button
              onClick={() => {
                setReauthorizeId(null);
                setFormError('');
                setShowAddModal(true);
              }}
              className="mt-6 flex items-center gap-1.5 px-5 py-3 rounded-2xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 text-blue-300 hover:text-blue-200 text-xs font-bold transition-all cursor-pointer"
              id="accounts-empty-add"
            >
              <Plus className="w-4 h-4" />
              添加账号
            </button>
          )}
        </div>
      )}

      {/* Cards Double Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" id="accounts-cards-grid">
        <AnimatePresence initial={false}>
        {filteredAccounts.map((account) => {
          const isCardRefreshing = refreshingId === account.id;
          const fiveHourPct = account.fiveHourQuotaRemaining == null
            ? null
            : Math.round((account.fiveHourQuotaRemaining / account.fiveHourQuotaTotal) * 100);
          const weeklyPct = account.weeklyQuotaRemaining == null || account.weeklyQuotaTotal <= 0
            ? null
            : Math.round((account.weeklyQuotaRemaining / account.weeklyQuotaTotal) * 100);
          const hasWarningBanner = account.status === 'WARNING' || account.status === 'EXPIRED' || account.status === 'LOW_QUOTA' || account.status === 'SUSPENDED';

          // Progress colors
          const color5h = fiveHourPct == null
            ? 'bg-slate-600/40'
            : fiveHourPct <= 25
            ? 'bg-gradient-to-r from-rose-500/45 via-rose-400/55 to-rose-500/45 shadow-[0_0_8px_rgba(244,63,94,0.1)]' 
            : fiveHourPct >= 70
              ? 'bg-gradient-to-r from-emerald-500/45 via-green-400/55 to-emerald-500/45 shadow-[0_0_8px_rgba(52,211,153,0.12)]'
              : 'bg-gradient-to-r from-amber-500/45 via-yellow-400/55 to-amber-500/45 shadow-[0_0_8px_rgba(251,191,36,0.1)]';
          
          const colorWeekly = weeklyPct == null
            ? 'bg-slate-600/40'
            : weeklyPct <= 25
            ? 'bg-gradient-to-r from-rose-600/45 via-rose-500/55 to-rose-600/45 shadow-[0_0_8px_rgba(225,29,72,0.1)]' 
            : weeklyPct !== null && weeklyPct >= 70
              ? 'bg-gradient-to-r from-emerald-600/45 via-green-500/55 to-emerald-600/45 shadow-[0_0_8px_rgba(16,185,129,0.12)]'
              : 'bg-gradient-to-r from-amber-600/45 via-yellow-500/55 to-amber-600/45 shadow-[0_0_8px_rgba(217,119,6,0.1)]';

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
              id={`account-manage-card-${account.id}`}
            >
              {/* Highlight glass background on hover */}
              <div className="absolute inset-0 bg-white/[0.01] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

              {/* Card Title Area */}
              <div className="flex items-start justify-between mb-5" id={`account-m-header-${account.id}`}>
                <div className="flex items-center gap-3.5" id={`account-m-user-${account.id}`}>
                  <div className={`w-11 h-11 rounded-2xl flex items-center justify-center bg-gradient-to-br ${avatarGradient(account.id)} text-white font-bold text-base shadow-md`}>
                    {(account.name.charAt(0) || '?').toUpperCase()}
                  </div>

                  <div className="flex flex-col text-left select-all" id={`account-m-titles-${account.id}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-100 text-sm tracking-wide font-sans truncate max-w-[140px] sm:max-w-none">
                        {account.email}
                      </span>
                      {account.isCurrent && (
                        <span className="px-2.5 py-0.5 bg-blue-500/20 border border-blue-500/30 text-blue-300 text-[9px] font-bold rounded-full uppercase tracking-wider" id="current-account-badge">
                          当前
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1" id={`account-m-badges-${account.id}`}>
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${
                        account.status === 'ACTIVE'
                          ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                          : account.status === 'WARNING'
                            ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                            : account.status === 'READY'
                              ? 'bg-teal-500/10 border-teal-500/20 text-teal-400'
                              : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
                      }`}>{account.status}</span>
                      <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-blue-500/10 border border-blue-500/20 text-blue-300">{account.plan}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Red Warning Banner if needed */}
              {hasWarningBanner && (
                <div className="mb-5 p-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-2 text-xs text-rose-300" id={`warning-banner-${account.id}`}>
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span className="font-medium">
                    {account.warning || (account.weeklyBlocksFiveHour
                      ? '周额度已用尽，5 小时额度暂不可用。'
                      : '额度状态需要关注。')}
                  </span>
                </div>
              )}

              {/* Token Validity Slider/Progress Info */}
              <div className="space-y-5 flex-1" id={`account-m-details-${account.id}`}>
                {/* TOKEN VALIDITY Row */}
                <div className="space-y-1.5" id={`token-validity-row-${account.id}`}>
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="text-slate-400 uppercase tracking-wider text-[10px] tabular-nums">TOKEN 有效期</span>
                    <span className="text-slate-300 font-semibold">{account.tokenValidity}</span>
                  </div>
                  <div className="h-1.5 bg-slate-950/50 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-blue-500/40 via-cyan-400/50 to-indigo-500/40 rounded-full"
                      style={{ width: `${Math.round(account.tokenValidityPct ?? 0)}%` }}
                    />
                  </div>
                </div>

                {/* Sub Quotas Progress Boxes Grid */}
                <div className={`grid ${fiveHourPct !== null && weeklyPct !== null ? 'grid-cols-2' : 'grid-cols-1'} gap-4 select-none`} id={`quotas-boxes-grid-${account.id}`}>
                  {/* 5H QUOTA */}
                  {fiveHourPct !== null && (
                  <div className="bg-slate-950/35 rounded-2xl p-4 text-left" id={`quota-box-5h-${account.id}`}>
                    <span className="text-[10px] font-bold text-slate-500 tracking-wider uppercase tabular-nums">5 小时额度</span>
                    <span className={`text-2xl font-bold block mt-1.5 tracking-tight tabular-nums ${
                      fiveHourPct <= 25 ? 'text-rose-400' : fiveHourPct >= 70 ? 'text-emerald-400' : 'text-amber-300'
                    }`}>{fiveHourPct}%</span>
                    <div className="h-1.5 bg-slate-950/50 rounded-full overflow-hidden mt-3">
                      <div className={`h-full rounded-full ${color5h}`} style={{ width: `${fiveHourPct}%` }} />
                    </div>
                    <span className="text-[10px] text-slate-500 mt-2 block font-medium">重置: {account.resetInFiveHour}</span>
                  </div>
                  )}

                  {/* WEEKLY QUOTA */}
                  {weeklyPct !== null && (
                  <div className="bg-slate-950/35 rounded-2xl p-4 text-left" id={`quota-box-weekly-${account.id}`}>
                    <span className="text-[10px] font-bold text-slate-500 tracking-wider uppercase tabular-nums">周额度</span>
                    <span className={`text-2xl font-bold block mt-1.5 tracking-tight tabular-nums ${
                      weeklyPct !== null && weeklyPct <= 25 ? 'text-rose-400' : weeklyPct !== null && weeklyPct >= 70 ? 'text-emerald-400' : 'text-amber-300'
                    }`}>
                      {weeklyPct !== null ? `${weeklyPct}%` : '--'}
                    </span>
                    <div className="h-1.5 bg-slate-950/50 rounded-full overflow-hidden mt-3">
                      <div className={`h-full rounded-full ${colorWeekly}`} style={{ width: `${weeklyPct || 0}%` }} />
                    </div>
                    <span className="text-[10px] text-slate-500 mt-2 block font-medium">
                      {weeklyPct !== null ? `重置: ${account.resetInWeekly}` : '暂无数据'}
                    </span>
                  </div>
                  )}
                  {fiveHourPct === null && weeklyPct === null && (
                    <div className="bg-slate-950/35 rounded-2xl p-4 text-left text-xs text-slate-400">
                      该账号未返回额度窗口数据。
                    </div>
                  )}
                </div>
              </div>

              {/* Action buttons footer */}
              <div className="flex items-center justify-between gap-2.5 mt-6 pt-4 border-t border-white/5" id={`account-actions-${account.id}`}>
                {/* 1. Refresh */}
                <motion.button
                  onClick={() => handleSingleRefresh(account.id, account.name)}
                  disabled={isCardRefreshing || account.status === 'SUSPENDED'}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.95 }}
                  transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                  className="flex-1 py-3 px-2 bg-white/5 hover:bg-white/10 rounded-xl text-slate-300 hover:text-white transition-all text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                  title={account.status === 'SUSPENDED' ? 'Reauthorize this account before refreshing quotas' : '刷新此账号'}
                  id={`action-refresh-${account.id}`}
                >
            <RefreshCw className={`w-3.5 h-3.5 ${isCardRefreshing ? 'animate-spin text-blue-400' : ''}`} />
                  {account.status === 'SUSPENDED' ? '请先重新授权' : '刷新'}
                </motion.button>

                {account.status === 'SUSPENDED' && onReauthorizeAccount && (
                  <motion.button
                    onClick={() => {
                      setReauthorizeId(account.id);
                      setFormError('');
                      setShowAddModal(true);
                    }}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                    className="flex-1 py-3 px-2 bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/20 rounded-xl text-amber-300 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                    id={`action-reauthorize-${account.id}`}
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    重新授权
                  </motion.button>
                )}

                {/* 2. Switch/Check (Star/Switch) */}
                {account.isCurrent ? (
                  <motion.button
                    className="flex-1 py-3 px-2 bg-blue-500/15 border border-blue-500/30 rounded-xl text-blue-300 transition-all text-xs font-bold flex items-center justify-center gap-1.5 cursor-not-allowed"
                    disabled
                    id={`action-current-${account.id}`}
                  >
                    <Star className="w-3.5 h-3.5 fill-blue-300" />
                    当前
                  </motion.button>
                ) : (
                  <motion.button
                    onClick={() => void handleSwitchAccount(account.id)}
                    disabled={account.status === 'SUSPENDED' || switchingId !== null || deletingId === account.id}
                    aria-busy={switchingId === account.id}
                    title={account.status === 'SUSPENDED' ? '该账号需要重新授权后才能切换' : '切换到此账号'}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                    className="flex-1 py-3 px-2 bg-white/5 hover:bg-blue-500/15 hover:text-blue-300 hover:border-blue-500/35 border border-transparent rounded-xl text-slate-300 transition-all text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    id={`action-switch-${account.id}`}
                  >
                    <ArrowLeftRight className={`w-3.5 h-3.5 ${switchingId === account.id ? 'animate-pulse' : ''}`} />
                    {switchingId === account.id ? '切换中...' : account.status === 'SUSPENDED' ? '不可用' : '切换'}
                  </motion.button>
                )}

                {/* 3. Delete / Check */}
                <motion.button
                  onClick={() => {
                    if (account.isCurrent) {
                      onAddLog('Cannot delete the active current account.', 'error');
                      return;
                    }
                    void handleDeleteAccount(account.id);
                  }}
                  disabled={account.isCurrent || deletingId !== null || switchingId !== null}
                  aria-busy={deletingId === account.id}
                  whileHover={account.isCurrent ? {} : { scale: 1.05, backgroundColor: 'rgba(239, 68, 68, 0.1)' }}
                  whileTap={account.isCurrent ? {} : { scale: 0.95 }}
                  transition={{ type: 'spring', stiffness: 450, damping: 15 }}
                  className={`py-3 px-4 rounded-xl transition-all text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer ${
                    account.isCurrent 
                      ? 'bg-white/5 text-slate-500 cursor-not-allowed' 
                      : 'bg-white/5 text-slate-300 hover:text-rose-400'
                  }`}
                  title="删除此账号"
                  id={`action-delete-${account.id}`}
                >
                  <Trash2 className={`w-3.5 h-3.5 ${deletingId === account.id ? 'animate-pulse' : ''}`} />
                </motion.button>
              </div>
            </motion.div>
          );
        })}
        </AnimatePresence>
      </div>

      {/* Add Account Modal Overlay */}
      <AnimatePresence>
      {showAddModal && (
          <motion.div
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-center justify-center p-4"
            id="add-account-modal-overlay"
            initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className="glass-card backdrop-blur-2xl bg-slate-900/90 border border-white/10 rounded-3xl p-8 w-full max-w-lg shadow-2xl relative text-white select-none"
              id="add-account-modal"
              role="dialog"
              aria-modal="true"
            >
              <button
                onClick={() => {
                  if (!isAdding) {
                    setShowAddModal(false);
                    setReauthorizeId(null);
                  }
                }}
                disabled={isAdding}
                className="absolute top-5 right-5 p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                id="btn-close-modal"
              >
                <X className="w-4 h-4" />
              </button>

              <h3 className="text-xl font-bold tracking-tight mb-2 font-sans">
                {reauthorizeId ? '重新授权账号' : '添加配置账号'}
              </h3>
              <p className="text-xs text-slate-400 mb-6 font-sans">
                {oauthMode ? '将打开 OpenAI OAuth 授权页面，邮箱、套餐与凭证会在授权完成后自动读取。' : '为 Codex 账号管理器配置一个新的接入凭证和配额检测对象。'}
              </p>

              <form onSubmit={handleAddSubmit} className="space-y-5" id="add-account-form">
                {/* Email input */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-300 tracking-wider uppercase tabular-nums block ml-1">
                    电子邮箱 (Email Address)
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-500">
                      <Mail className="w-4 h-4" />
                    </span>
                    <input
                      type="text"
                      value={oauthMode ? '' : newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      placeholder={oauthMode ? '由 OAuth 自动读取' : 'user@example.com'}
                      readOnly={oauthMode}
                      className="w-full pl-11 pr-4 py-3 bg-slate-950/40 border border-white/10 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all font-sans text-xs"
                      id="input-add-email"
                    />
                  </div>
                </div>

                {/* Name input */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-300 tracking-wider uppercase tabular-nums block ml-1">
                    展示名称 (Display Name)
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-500">
                      <User className="w-4 h-4" />
                    </span>
                    <input
                      type="text"
                      value={oauthMode ? '' : newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={oauthMode ? '由账号邮箱自动生成' : 'My Operations Node'}
                      readOnly={oauthMode}
                      className="w-full pl-11 pr-4 py-3 bg-slate-950/40 border border-white/10 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all font-sans text-xs"
                      id="input-add-name"
                    />
                  </div>
                </div>

                {/* Plan select */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-300 tracking-wider uppercase tabular-nums block ml-1">
                      {oauthMode ? '套餐（OAuth 自动识别）' : '选择方案 / 套餐 (Plan)'}
                    </label>
                    {oauthMode ? (
                      <div
                        className="w-full px-4 py-3 bg-slate-950 border border-white/10 rounded-2xl text-slate-500 text-xs"
                        id="input-add-plan"
                        role="status"
                      >
                        授权完成后自动识别
                      </div>
                    ) : (
                      <select
                        value={newPlan}
                        onChange={(e) => setNewPlan(e.target.value as any)}
                        className="w-full px-4 py-3 bg-slate-950 border border-white/10 rounded-2xl text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all text-xs"
                        id="input-add-plan"
                      >
                        <option value="Pro Plan">Pro Plan</option>
                        <option value="Standard">Standard</option>
                        <option value="Enterprise">Enterprise</option>
                      </select>
                    )}
                  </div>

                  {/* Priority Select */}
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-300 tracking-wider uppercase tabular-nums block ml-1">
                      {oauthMode ? '轮转优先级（自动计算）' : '轮转优先级 (Priority)'}
                    </label>
                    {oauthMode ? (
                      <div
                        className="w-full px-4 py-3 bg-slate-950 border border-white/10 rounded-2xl text-slate-500 text-xs"
                        id="input-add-priority"
                        role="status"
                      >
                        根据实际套餐自动计算
                      </div>
                    ) : (
                      <select
                        value={newPriority}
                        onChange={(e) => setNewPriority(e.target.value as any)}
                        className="w-full px-4 py-3 bg-slate-950 border border-white/10 rounded-2xl text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all text-xs"
                        id="input-add-priority"
                      >
                        <option value="Ultra">Ultra</option>
                        <option value="High">High</option>
                        <option value="Normal">Normal</option>
                        <option value="Low">Low</option>
                      </select>
                    )}
                  </div>
                </div>

                {formError && (
                  <p className="text-xs text-rose-400 font-semibold bg-rose-500/10 border border-rose-500/20 p-3 rounded-2xl text-center break-words">
                    {formError}
                  </p>
                )}

                {isAdding && oauthMode && (
                  <div className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/30 p-4">
                    <p className="text-xs text-slate-400">
                      正在等待浏览器回调。如果浏览器无法自动返回，请粘贴完整的回调网址。
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={manualCallbackUrl}
                        onChange={(event) => setManualCallbackUrl(event.target.value)}
                        placeholder="http://localhost:1455/auth/callback?code=..."
                        className="min-w-0 flex-1 px-3 py-2 bg-slate-950/50 border border-white/10 rounded-xl text-xs text-slate-200"
                        id="oauth-manual-callback-input"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setFormError('');
                          Promise.resolve(onCompleteOAuthManually?.(manualCallbackUrl))
                            .catch(error => setFormError(error instanceof Error ? error.message : String(error)));
                        }}
                        disabled={!manualCallbackUrl || !onCompleteOAuthManually}
                        className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-300 disabled:opacity-40"
                        title="提交回调网址"
                        id="oauth-manual-callback-submit"
                      >
                        <Link className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex gap-3 pt-4 border-t border-white/5">
                  <button
                    type="button"
                    onClick={() => {
                      if (isAdding) {
                        Promise.resolve(onCancelOAuth?.()).catch(() => {});
                        return;
                      }
                      setShowAddModal(false);
                      setReauthorizeId(null);
                    }}
                    className="flex-1 py-3 bg-white/5 hover:bg-white/10 text-white rounded-2xl text-xs font-semibold cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isAdding ? '取消 OAuth' : '取消'}
                  </button>
                  <button
                    type="submit"
                    disabled={isAdding}
                    className="flex-1 py-3 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 text-blue-300 hover:text-blue-200 rounded-2xl text-xs font-bold transition-all cursor-pointer"
                  >
                    {isAdding ? '正在打开授权...' : oauthMode ? '打开 OAuth 授权' : '添加配置'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}

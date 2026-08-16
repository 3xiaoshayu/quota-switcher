import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Award, 
  Plus, 
  Search, 
  User,
  AtSign, 
  ArrowLeftRight, 
  Trash2, 
  Star,
  X,
  Mail,
  KeyRound,
  Link,
  RefreshCw,
  MoreHorizontal
} from 'lucide-react';
import { AccountQuota, DesktopAuthState, DesktopOAuthStatus } from '../types';
import { avatarGradient, needsHandling, planLabel, quotaBarColor, quotaSummaryPercent, quotaWindowSummary, STATUS_DOT, STATUS_TEXT, canRefreshQuota, canSwitchAccount } from '../api/desktop';
import { toUserMessage } from '../api/user-messages';

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
  authState?: DesktopAuthState | null;
  onOpenModal?: () => void;
  filterTab?: 'all' | 'current' | 'warning';
  onFilterTabChange?: (tab: 'all' | 'current' | 'warning') => void;
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
  authState = null,
  onOpenModal,
  filterTab: filterTabProp,
  onFilterTabChange,
}: AccountsProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [localFilterTab, setLocalFilterTab] = useState<'all' | 'current' | 'warning'>('all');
  const filterTab = filterTabProp ?? localFilterTab;
  const setFilterTab = (tab: 'all' | 'current' | 'warning') => {
    if (onFilterTabChange) onFilterTabChange(tab);
    else setLocalFilterTab(tab);
  };
  const [showAddModal, setShowAddModal] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const [reauthorizeId, setReauthorizeId] = useState<string | null>(null);
  const [manualCallbackUrl, setManualCallbackUrl] = useState('');
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [moreMenuId, setMoreMenuId] = useState<string | null>(null);
  const [isRecoveredOAuth, setIsRecoveredOAuth] = useState(false);
  const [isSubmittingCallback, setIsSubmittingCallback] = useState(false);
  const [isCancellingOAuth, setIsCancellingOAuth] = useState(false);

  // New account form state
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPlan, setNewPlan] = useState<AccountQuota['plan']>('Plus');
  const [newPriority, setNewPriority] = useState<AccountQuota['priority']>('Normal');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (!oauthMode) return;
    if (oauthStatus?.pending) {
      setIsRecoveredOAuth(true);
      setShowAddModal(true);
      setIsAdding(true);
      setReauthorizeId(oauthStatus.targetAccountId || null);
      setFormError('');
      return;
    }
    if (!isRecoveredOAuth) return;
    setIsRecoveredOAuth(false);
    setIsAdding(false);
    if (oauthStatus?.status === 'error' || oauthStatus?.status === 'expired') {
      setFormError(toUserMessage(oauthStatus.message || '授权未完成'));
      setShowAddModal(true);
      return;
    }
    setShowAddModal(false);
    setReauthorizeId(null);
    setManualCallbackUrl('');
    setFormError('');
  }, [isRecoveredOAuth, oauthMode, oauthStatus?.message, oauthStatus?.pending, oauthStatus?.status, oauthStatus?.targetAccountId]);

  useEffect(() => {
    if (showAddModal) onOpenModal?.();
  }, [showAddModal, onOpenModal]);

  useEffect(() => {
    if (!moreMenuId) return;
    const close = () => setMoreMenuId(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [moreMenuId]);

  // Escape 关闭添加弹窗；授权进行中则取消授权，而不是把窗口卡死。
  const cancelPendingOAuth = async () => {
    if (isCancellingOAuth) return;
    setIsCancellingOAuth(true);
    try {
      await onCancelOAuth?.();
    } catch (error) {
      setFormError(toUserMessage(error instanceof Error ? error.message : String(error)));
    } finally {
      setIsCancellingOAuth(false);
    }
  };

  useEffect(() => {
    if (!showAddModal) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isAdding) {
        event.preventDefault();
        void cancelPendingOAuth();
        return;
      }
      setShowAddModal(false);
      setReauthorizeId(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAdding, isCancellingOAuth, onCancelOAuth, showAddModal]);

  // Handle single card refresh animation
  const handleSingleRefresh = async (id: string, name: string) => {
    if (refreshingIds.has(id)) return;
    setRefreshingIds(prev => new Set(prev).add(id));
    onAddLog(`正在刷新账号状态：${name}...`, 'info');
    try {
      await onRefreshAccount(id);
    } catch {
      // App 层已经用 toast / 日志报过结果
    } finally {
      setRefreshingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleSwitchAccount = async (id: string) => {
    if (switchingId || oauthStatus?.pending) return;
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
    if (filterTab === 'warning') return needsHandling(acc);
    
    return true;
  });

  const startReauthorize = (id: string) => {
    if (!onReauthorizeAccount || oauthStatus?.pending) return;
    setFormError('');
    setReauthorizeId(id);
    void Promise.resolve(onReauthorizeAccount(id)).catch((error) => {
      setFormError(toUserMessage(error instanceof Error ? error.message : String(error)));
      setShowAddModal(true);
      setIsAdding(false);
    });
  };

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

      if (!oauthMode) onAddLog(`已添加账号：${newEmail} (${newPlan})`, 'success');
      setNewEmail('');
      setNewName('');
      setNewPlan('Plus');
      setNewPriority('Normal');
      setFormError('');
      setReauthorizeId(null);
      setManualCallbackUrl('');
      setShowAddModal(false);
    } catch (error) {
      setFormError(toUserMessage(error instanceof Error ? error.message : String(error)));
    } finally {
      setIsAdding(false);
    }
  };

  const currentAccount = accounts.find(account => account.isCurrent);
  const currentPlanText = currentAccount ? planLabel(currentAccount.plan) : '暂无';
  const handlingCount = accounts.filter(needsHandling).length;

  return (
    <div className="flex-1 p-8 overflow-y-auto select-none" id="accounts-view-container">
      {/* Title block with stats & action triggers */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6" id="accounts-header-row">
        <div className="flex flex-col" id="accounts-title-block">
          <h2 className="text-[28px] font-bold tracking-tight text-label font-sans">
            账号管理
          </h2>
          <p className="mt-1.5 text-[13px] text-label-2 font-sans" id="accounts-meta-labels">
            {accounts.length} 个账号 · {handlingCount > 0 ? `${handlingCount} 个需要处理` : `当前套餐 ${currentPlanText}`}
          </p>
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
            className="flex items-center gap-1.5 px-4 py-2 rounded-[10px] bg-accent/15 hover:bg-accent/25 border border-accent/20 text-accent text-[13px] font-medium transition-colors cursor-pointer"
            id="btn-add-account-modal-trigger"
          >
            <Plus className="w-4 h-4" />
            添加账号
          </motion.button>
        </div>
      </div>

      {/* Filters & Search Control Bar */}
      <div 
        className="glass-card rounded-2xl p-3 flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8"
        id="accounts-search-filter-row"
      >
        {/* Search input with icon */}
        <div className="relative flex-1 max-w-md" id="accounts-search-group">
          <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-label-2 pointer-events-none">
            <Search className="w-4 h-4" />
          </span>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索邮箱或计划..."
            className="w-full pl-10 pr-4 py-2.5 bg-fill border border-sep rounded-xl text-label placeholder-label-3 focus:outline-none focus:ring-2 focus:ring-accent/60 transition-all text-xs font-sans font-medium"
            id="accounts-search-input"
          />
        </div>

        {/* Tab Filters capsule */}
        <div className="flex bg-fill p-1 rounded-xl border border-sep text-xs font-semibold relative" id="accounts-filter-tabs">
          <button
            onClick={() => setFilterTab('all')}
            className={`px-5 py-2.5 rounded-xl transition-all relative cursor-pointer z-10 ${
              filterTab === 'all' ? 'text-white font-bold' : 'text-label-2 hover:text-label-2'
            }`}
            id="filter-tab-all"
          >
            {filterTab === 'all' && (
              <motion.div
                layoutId="accountsActiveFilterBg"
                className="absolute inset-0 bg-fill-2 rounded-xl -z-10"
                transition={{ type: 'spring', stiffness: 450, damping: 25 }}
              />
            )}
            全部
          </button>
          <button
            onClick={() => setFilterTab('current')}
            className={`px-5 py-2.5 rounded-xl transition-all relative cursor-pointer z-10 ${
              filterTab === 'current' ? 'text-white font-bold' : 'text-label-2 hover:text-label-2'
            }`}
            id="filter-tab-current"
          >
            {filterTab === 'current' && (
              <motion.div
                layoutId="accountsActiveFilterBg"
                className="absolute inset-0 bg-fill-2 rounded-xl -z-10"
                transition={{ type: 'spring', stiffness: 450, damping: 25 }}
              />
            )}
            当前
          </button>
          <button
            onClick={() => setFilterTab('warning')}
            className={`px-5 py-2.5 rounded-xl transition-all relative cursor-pointer z-10 flex items-center gap-1.5 ${
              filterTab === 'warning' ? 'text-white font-bold' : 'text-label-2 hover:text-label-2'
            }`}
            id="filter-tab-warning"
          >
            {filterTab === 'warning' && (
              <motion.div
                layoutId="accountsActiveFilterBg"
                className="absolute inset-0 bg-fill-2 rounded-xl -z-10"
                transition={{ type: 'spring', stiffness: 450, damping: 25 }}
              />
            )}
            需要处理
            {handlingCount > 0 && (
              <span className="px-1.5 py-0.5 bg-danger text-white rounded-full text-[9px] font-bold">
                {handlingCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Empty state */}
      {filteredAccounts.length === 0 && (
        <div className="glass-card rounded-2xl px-8 py-16 flex flex-col items-center text-center" id="accounts-empty-state">
          <div className="w-14 h-14 rounded-xl bg-fill-2 flex items-center justify-center text-label-2 mb-4">
            <AtSign className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-bold text-white">{accounts.length === 0 ? '还没有账号' : '没有匹配的账号'}</h3>
          <p className="mt-2 max-w-xs text-xs leading-5 text-label-2">
            {accounts.length === 0 ? '通过 OAuth 授权添加你的第一个 Codex 账号。' : '换个关键词，或切换筛选条件再试试。'}
          </p>
          {accounts.length === 0 && (
            <button
              onClick={() => {
                setReauthorizeId(null);
                setFormError('');
                setShowAddModal(true);
              }}
              className="mt-6 flex items-center gap-1.5 px-5 py-3 rounded-xl bg-accent/12 hover:bg-accent/20 border border-accent/20 text-accent hover:text-accent-hi text-xs font-bold transition-all cursor-pointer"
              id="accounts-empty-add"
            >
              <Plus className="w-4 h-4" />
              添加账号
            </button>
          )}
        </div>
      )}

      {/* Cards Double Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch" id="accounts-cards-grid">
        <AnimatePresence initial={false}>
        {filteredAccounts.map((account) => {
          const isCardRefreshing = refreshingIds.has(account.id);
          const fiveHourSummary = quotaWindowSummary('fiveHour', account);
          const weeklySummary = quotaWindowSummary('weekly', account);
          const fiveHourPct = quotaSummaryPercent(fiveHourSummary.text);
          const weeklyPct = quotaSummaryPercent(weeklySummary.text);
          const quotaNotice = account.warning
            || (account.weeklyBlocksFiveHour ? '周额度已用尽，5 小时额度暂不可用。' : null)
            || ((account.status === 'WARNING' || account.status === 'EXPIRED' || account.status === 'LOW_QUOTA')
              ? '额度状态需要关注。'
              : null);
          const switchBlocked = !canSwitchAccount(account);
          const refreshBlocked = !canRefreshQuota(account);
          const needsReauth = account.status === 'SUSPENDED' && !!onReauthorizeAccount;
          const officialAligned = !oauthMode || (
            authState?.status === 'aligned' &&
            authState.currentAccountId === account.id
          );

          const color5h = quotaBarColor(fiveHourPct);
          const colorWeekly = quotaBarColor(weeklyPct);

          return (
            <motion.div
              layout
              key={account.id}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 350, damping: 28 }}
              className="glass-card rounded-2xl p-6 flex flex-col relative overflow-hidden group h-full"
              id={`account-manage-card-${account.id}`}
            >
              {/* Highlight glass background on hover */}
              <div className="absolute inset-0 bg-white/[0.01] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

              {/* Card Title Area */}
              <div className="flex items-start justify-between mb-5" id={`account-m-header-${account.id}`}>
                <div className="flex items-center gap-3.5" id={`account-m-user-${account.id}`}>
                  <div className={`w-11 h-11 rounded-full flex items-center justify-center ${avatarGradient(account.id)} font-semibold text-base`}>
                    {(account.name.charAt(0) || '?').toUpperCase()}
                  </div>

                  <div className="flex flex-col text-left select-all" id={`account-m-titles-${account.id}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-label text-sm tracking-wide font-sans truncate max-w-[140px] sm:max-w-none select-text">
                        {account.email}
                      </span>
                      {account.isCurrent && (
                        <span className="px-2 py-0.5 bg-accent/15 text-accent text-[10px] font-semibold rounded-md" id="current-account-badge">
                          当前
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1" id={`account-m-badges-${account.id}`}>
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-label-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[account.status] || 'bg-fill-3'}`} />
                        {STATUS_TEXT[account.status] || account.status}
                      </span>
                      <span className="text-[11px] text-label-3">{planLabel(account.plan)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {quotaNotice && (
                <p
                  className={`mb-5 text-[12px] leading-5 ${account.status === 'BANNED' ? 'text-danger' : 'text-warn'}`}
                  id={`warning-banner-${account.id}`}
                >
                  {quotaNotice}
                </p>
              )}

              {/* Token Validity Slider/Progress Info */}
              <div className="space-y-5 flex-1" id={`account-m-details-${account.id}`}>
                {/* TOKEN VALIDITY Row */}
                <div className="space-y-1.5" id={`token-validity-row-${account.id}`}>
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="text-[12px] font-medium text-label-3">Token 有效期</span>
                    <span className="text-label-2 font-semibold">{account.tokenValidity}</span>
                  </div>
                  <div className="h-[3px] bg-[#3a3a3c] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#8e8e93]"
                      style={{ width: `${Math.round(account.tokenValidityPct ?? 0)}%` }}
                    />
                  </div>
                </div>

                {/* Sub Quotas Progress Boxes Grid */}
                <div className="grid grid-cols-2 gap-4 select-none" id={`quotas-boxes-grid-${account.id}`}>
                  {/* 5H QUOTA (kept visible even while upstream omits the window) */}
                  <div className="bg-fill rounded-xl p-4 text-left" id={`quota-box-5h-${account.id}`}>
                    <span className="text-[12px] font-medium text-label-3">5 小时额度</span>
                    <span className={`block mt-1.5 tracking-tight ${
                      fiveHourPct === null ? 'text-[13px] leading-5 font-medium text-label-3' : 'text-[22px] font-semibold tabular-nums text-label'
                    }`}>{fiveHourPct !== null ? `${fiveHourPct}%` : fiveHourSummary.text}</span>
                    {fiveHourPct !== null ? (
                    <div className="h-1 bg-[#3a3a3c] rounded-full overflow-hidden mt-3">
                      <div className={`h-full rounded-full ${color5h}`} style={{ width: `${fiveHourPct}%` }} />
                    </div>
                    ) : null}
                    <span className="text-[10px] text-label-3 mt-2 block font-medium">
                      {fiveHourPct !== null ? `重置: ${account.resetInFiveHour}` : ''}
                    </span>
                  </div>

                  {/* WEEKLY QUOTA */}
                  <div className="bg-fill rounded-xl p-4 text-left" id={`quota-box-weekly-${account.id}`}>
                    <span className="text-[12px] font-medium text-label-3">周额度</span>
                    <span className={`block mt-1.5 tracking-tight ${
                      weeklyPct === null ? 'text-[13px] leading-5 font-medium text-label-3' : 'text-[22px] font-semibold tabular-nums text-label'
                    }`}>
                      {weeklyPct !== null ? `${weeklyPct}%` : weeklySummary.text}
                    </span>
                    {weeklyPct !== null ? (
                    <div className="h-1 bg-[#3a3a3c] rounded-full overflow-hidden mt-3">
                      <div className={`h-full rounded-full ${colorWeekly}`} style={{ width: `${weeklyPct}%` }} />
                    </div>
                    ) : null}
                    <span className="text-[10px] text-label-3 mt-2 block font-medium">
                      {weeklyPct !== null ? `重置: ${account.resetInWeekly}` : ''}
                    </span>
                  </div>
                </div>
              </div>

              {/* Action buttons footer */}
              <div className="flex items-center justify-between gap-2.5 mt-6 pt-4 border-t border-sep" id={`account-actions-${account.id}`}>
                {needsReauth ? (
                  <motion.button
                    onClick={() => startReauthorize(account.id)}
                    disabled={!!oauthStatus?.pending}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                    className="flex-1 py-3 px-2 bg-warn/12 hover:bg-warn/20 rounded-[10px] text-warn text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    id={`action-reauthorize-${account.id}`}
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    重新授权
                  </motion.button>
                ) : (
                  <motion.button
                    onClick={() => handleSingleRefresh(account.id, account.name)}
                    disabled={isCardRefreshing || refreshBlocked}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                    className="flex-1 py-3 px-2 bg-fill hover:bg-fill-2 rounded-[10px] text-label-2 hover:text-label transition-all text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    title={refreshBlocked
                      ? (account.status === 'BANNED' ? '账号已封号，无法刷新额度' : '该账号需要重新授权后才能刷新额度')
                      : '刷新此账号'}
                    id={`action-refresh-${account.id}`}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isCardRefreshing ? 'animate-spin text-accent' : ''}`} />
                    {isCardRefreshing ? '刷新中...' : '刷新'}
                  </motion.button>
                )}

                {needsReauth ? (
                  <motion.button
                    onClick={() => handleSingleRefresh(account.id, account.name)}
                    disabled={isCardRefreshing || refreshBlocked}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                    className="py-3 px-3 bg-fill hover:bg-fill-2 rounded-[10px] text-label-2 hover:text-label transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    title={refreshBlocked
                      ? (account.status === 'BANNED' ? '账号已封号，无法刷新额度' : '该账号需要重新授权后才能刷新额度')
                      : '刷新此账号'}
                    id={`action-refresh-${account.id}`}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isCardRefreshing ? 'animate-spin text-accent' : ''}`} />
                  </motion.button>
                ) : account.isCurrent ? (
                  <motion.button
                    onClick={() => {
                      if (officialAligned) return
                      void handleSwitchAccount(account.id)
                    }}
                    disabled={officialAligned || switchBlocked || switchingId !== null || deletingId === account.id || !!oauthStatus?.pending}
                    aria-busy={switchingId === account.id}
                    title={
                      oauthStatus?.pending
                        ? '已有授权正在进行，请先完成或取消'
                        : account.status === 'BANNED'
                        ? '账号已封号，无法切换'
                        : account.status === 'SUSPENDED'
                        ? '该账号需要重新授权后才能切换'
                        : officialAligned
                          ? '官方已是此账号'
                          : '将此账号写入官方 Codex 并登录'
                    }
                    whileHover={officialAligned ? {} : { scale: 1.02 }}
                    whileTap={officialAligned ? {} : { scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                    className={`flex-1 py-3 px-2 bg-accent/15 rounded-[10px] text-accent transition-all text-xs font-semibold flex items-center justify-center gap-1.5 ${
                      officialAligned
                        ? 'cursor-not-allowed'
                        : 'hover:bg-accent/25 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40'
                    }`}
                    id={`action-current-${account.id}`}
                  >
                    <Star className={`w-3.5 h-3.5 fill-accent ${switchingId === account.id ? 'animate-pulse' : ''}`} />
                    {switchingId === account.id
                      ? '登录中...'
                      : officialAligned
                        ? '当前'
                        : '重新登录 Codex'}
                  </motion.button>
                ) : (
                  <motion.button
                    onClick={() => void handleSwitchAccount(account.id)}
                    disabled={switchBlocked || switchingId !== null || deletingId === account.id || !!oauthStatus?.pending}
                    aria-busy={switchingId === account.id}
                    title={
                      oauthStatus?.pending
                        ? '已有授权正在进行，请先完成或取消'
                        : account.status === 'BANNED'
                          ? '账号已封号，无法切换'
                          : account.status === 'SUSPENDED'
                          ? '该账号需要重新授权后才能切换'
                          : '切换到此账号'
                    }
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                    className="flex-1 py-3 px-2 bg-fill hover:bg-accent/20 hover:text-accent rounded-[10px] text-label-2 transition-all text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    id={`action-switch-${account.id}`}
                  >
                    <ArrowLeftRight className={`w-3.5 h-3.5 ${switchingId === account.id ? 'animate-pulse' : ''}`} />
                    {switchingId === account.id ? '切换中...' : '切换'}
                  </motion.button>
                )}

                {!account.isCurrent ? (
                <div className="relative" id={`account-more-wrapper-${account.id}`}>
                  <motion.button
                    onClick={(event) => {
                      event.stopPropagation();
                      setMoreMenuId(moreMenuId === account.id ? null : account.id);
                    }}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 15 }}
                    className="py-3 px-3 bg-fill hover:bg-fill-2 rounded-[10px] text-label-2 hover:text-label transition-all cursor-pointer"
                    title="更多操作"
                    id={`action-more-${account.id}`}
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </motion.button>

                  <AnimatePresence>
                    {moreMenuId === account.id && (
                      <motion.div
                        onClick={(event) => event.stopPropagation()}
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 10 }}
                        className="absolute right-0 bottom-full mb-2 w-44 bg-surface-2 border border-sep rounded-xl p-2 shadow-xl z-20 select-none text-label-2"
                        id={`account-more-dropdown-${account.id}`}
                      >
                        {needsReauth ? (
                          <button
                            type="button"
                            onClick={() => {
                              if (account.isCurrent && officialAligned) return;
                              setMoreMenuId(null);
                              void handleSwitchAccount(account.id);
                            }}
                            disabled={officialAligned || switchBlocked || switchingId !== null || deletingId === account.id || !!oauthStatus?.pending}
                            title={
                              oauthStatus?.pending
                                ? '已有授权正在进行，请先完成或取消'
                                : account.status === 'BANNED'
                                  ? '账号已封号，无法切换'
                                  : '该账号需要重新授权后才能切换'
                            }
                            className="w-full px-3 py-2 hover:bg-fill rounded-xl text-left text-xs flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            id={`account-menu-switch-${account.id}`}
                          >
                            {account.isCurrent ? <Star className="w-3.5 h-3.5" /> : <ArrowLeftRight className="w-3.5 h-3.5" />}
                            {account.isCurrent ? (officialAligned ? '当前' : '重新登录 Codex') : '切换'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            if (account.isCurrent) {
                              onAddLog('无法删除当前正在使用的账号。', 'error');
                              return;
                            }
                            setMoreMenuId(null);
                            void handleDeleteAccount(account.id);
                          }}
                          disabled={account.isCurrent || deletingId !== null || switchingId !== null}
                          className="w-full px-3 py-2 hover:bg-fill rounded-xl text-left text-xs text-danger hover:text-danger flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          id={`action-delete-${account.id}`}
                        >
                          <Trash2 className={`w-3.5 h-3.5 ${deletingId === account.id ? 'animate-pulse' : ''}`} />
                          {account.isCurrent ? '当前账号不可删除' : '删除账号'}
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                ) : null}
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
            className="app-dialog-overlay bg-black/55 z-50"
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
              className="bg-surface-2 border border-sep rounded-2xl p-8 w-full max-w-lg shadow-2xl relative text-label select-none"
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
                className="absolute top-5 right-5 p-2 hover:bg-fill-2 rounded-xl text-label-2 hover:text-white transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                id="btn-close-modal"
              >
                <X className="w-4 h-4" />
              </button>

              <h3 className="text-xl font-bold tracking-tight mb-2 font-sans">
                {reauthorizeId ? '重新授权账号' : '添加账号'}
              </h3>
              <p className="text-xs text-label-2 mb-6 font-sans">
                {oauthMode
                  ? (reauthorizeId
                    ? '将打开登录授权页面。请用这个账号登录，完成后会自动回来。'
                    : '将打开登录授权页面，邮箱、套餐与凭证会在授权完成后自动读取。')
                  : '为 Codex 账号管理器配置一个新的接入凭证和配额检测对象。'}
              </p>

              <form onSubmit={handleAddSubmit} className="space-y-5" id="add-account-form">
                {!oauthMode && (
                  <>
                    <div className="space-y-2">
                      <label className="text-[13px] font-medium text-label-2 block ml-1">
                        电子邮箱
                      </label>
                      <div className="relative">
                        <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-label-3">
                          <Mail className="w-4 h-4" />
                        </span>
                        <input
                          type="text"
                          value={newEmail}
                          onChange={(e) => setNewEmail(e.target.value)}
                          placeholder="user@example.com"
                          className="w-full pl-11 pr-4 py-3 bg-fill border border-sep rounded-xl text-white placeholder-label-3 focus:outline-none focus:ring-2 focus:ring-accent/60 transition-all font-sans text-xs"
                          id="input-add-email"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[13px] font-medium text-label-2 block ml-1">
                        展示名称
                      </label>
                      <div className="relative">
                        <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-label-3">
                          <User className="w-4 h-4" />
                        </span>
                        <input
                          type="text"
                          value={newName}
                          onChange={(e) => setNewName(e.target.value)}
                          placeholder="My Operations Node"
                          className="w-full pl-11 pr-4 py-3 bg-fill border border-sep rounded-xl text-white placeholder-label-3 focus:outline-none focus:ring-2 focus:ring-accent/60 transition-all font-sans text-xs"
                          id="input-add-name"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-[13px] font-medium text-label-2 block ml-1">
                          套餐
                        </label>
                        <select
                          value={newPlan}
                          onChange={(e) => setNewPlan(e.target.value as any)}
                          className="w-full px-4 py-3 bg-fill rounded-[10px] text-label-2 focus:outline-none focus:ring-2 focus:ring-accent/60 transition-all text-xs"
                          id="input-add-plan"
                        >
                          <option value="Plus">Plus</option>
                          <option value="Pro">Pro</option>
                          <option value="Go">Go</option>
                          <option value="Standard">Standard</option>
                          <option value="Enterprise">Enterprise</option>
                        </select>
                      </div>

                      <div className="space-y-2">
                        <label className="text-[13px] font-medium text-label-2 block ml-1">
                          轮转优先级
                        </label>
                        <select
                          value={newPriority}
                          onChange={(e) => setNewPriority(e.target.value as any)}
                          className="w-full px-4 py-3 bg-fill rounded-[10px] text-label-2 focus:outline-none focus:ring-2 focus:ring-accent/60 transition-all text-xs"
                          id="input-add-priority"
                        >
                          <option value="Ultra">Ultra</option>
                          <option value="High">High</option>
                          <option value="Normal">Normal</option>
                          <option value="Low">Low</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}

                {formError && (
                  <p className="text-xs text-danger font-semibold bg-danger/12 p-3 rounded-[10px] text-center break-words">
                    {formError}
                  </p>
                )}

                {isAdding && oauthMode && (
                  <div className="space-y-3 rounded-xl border border-sep bg-fill p-4">
                    <p className="text-xs text-label-2">
                      请在浏览器完成授权，完成后会自动回来。如果浏览器没有自动跳回，请粘贴完整的回调网址。
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={manualCallbackUrl}
                        onChange={(event) => setManualCallbackUrl(event.target.value)}
                        placeholder="http://localhost:1455/auth/callback?code=..."
                        className="min-w-0 flex-1 px-3 py-2 bg-fill border border-sep rounded-xl text-xs text-label"
                        id="oauth-manual-callback-input"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (isSubmittingCallback || !manualCallbackUrl || !onCompleteOAuthManually) return;
                          setFormError('');
                          setIsSubmittingCallback(true);
                          Promise.resolve(onCompleteOAuthManually(manualCallbackUrl))
                            .catch(error => setFormError(toUserMessage(error instanceof Error ? error.message : String(error))))
                            .finally(() => setIsSubmittingCallback(false));
                        }}
                        disabled={!manualCallbackUrl || !onCompleteOAuthManually || isSubmittingCallback}
                        className="p-2.5 rounded-xl bg-accent/12 border border-accent/20 text-accent disabled:opacity-40"
                        title="提交回调网址"
                        id="oauth-manual-callback-submit"
                      >
                        <Link className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}

                <div className={`flex gap-3 ${oauthMode && !isAdding && !formError ? '' : 'pt-4 border-t border-sep'}`}>
                  <button
                    type="button"
                    onClick={() => {
                      if (isAdding) {
                        void cancelPendingOAuth();
                        return;
                      }
                      setShowAddModal(false);
                      setReauthorizeId(null);
                    }}
                    disabled={isCancellingOAuth}
                    className="flex-1 py-3 bg-fill hover:bg-fill-2 text-white rounded-xl text-xs font-semibold cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isCancellingOAuth ? '正在取消...' : isAdding ? '取消授权' : '取消'}
                  </button>
                  <button
                    type="submit"
                    disabled={isAdding}
                    className="flex-1 py-3 bg-accent/12 hover:bg-accent/20 border border-accent/20 text-accent hover:text-accent-hi rounded-xl text-xs font-bold transition-all cursor-pointer"
                  >
                    {isAdding ? '等待浏览器授权...' : oauthMode ? '打开登录授权' : '添加账号'}
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

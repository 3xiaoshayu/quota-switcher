import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Users, 
  Award, 
  RefreshCw, 
  Plus, 
  Search, 
  User, 
  Briefcase, 
  AlertTriangle, 
  ArrowLeftRight, 
  Trash2, 
  Check, 
  Star,
  X,
  Mail,
  Shield,
  Clock
} from 'lucide-react';
import { AccountQuota } from '../types';

interface AccountsProps {
  accounts: AccountQuota[];
  onAddAccount: (acc: Omit<AccountQuota, 'id'>) => void | Promise<void>;
  onDeleteAccount: (id: string) => void | Promise<void>;
  onSwitchCurrentAccount: (id: string) => void | Promise<void>;
  onRefreshAccount: (id: string) => void | Promise<void>;
  onAddLog: (msg: string, type: 'success' | 'info' | 'warning' | 'error') => void;
  onReloadAccounts?: () => void | Promise<void>;
  oauthMode?: boolean;
}

export default function AccountsView({
  accounts,
  onAddAccount,
  onDeleteAccount,
  onSwitchCurrentAccount,
  onRefreshAccount,
  onAddLog,
  onReloadAccounts,
  oauthMode = false,
}: AccountsProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'current' | 'warning'>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [isReloading, setIsReloading] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  // New account form state
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPlan, setNewPlan] = useState<'Pro Plan' | 'Standard' | 'Enterprise'>('Pro Plan');
  const [newPriority, setNewPriority] = useState<AccountQuota['priority']>('Normal');
  const [formError, setFormError] = useState('');

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

  const handleReloadAccounts = async () => {
    setIsReloading(true);
    onAddLog('Re-reading local configurations from node instances...', 'info');
    try {
      await onReloadAccounts?.();
      onAddLog('Local account configurations reloaded.', 'success');
    } catch (error) {
      onAddLog(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setIsReloading(false);
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
    if (filterTab === 'warning') return acc.status === 'WARNING' || acc.status === 'EXPIRED' || acc.status === 'SUSPENDED';
    
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
      await onAddAccount({
        name: newName || 'OAuth account',
        email: newEmail || 'oauth@pending.local',
        status: 'ACTIVE',
        fiveHourQuotaUsed: 0,
        fiveHourQuotaTotal: 100,
        weeklyQuotaUsed: 0,
        weeklyQuotaTotal: 100,
        priority: newPriority,
        plan: newPlan,
        tokenValidity: 'Pending OAuth',
        resetInFiveHour: 'Waiting',
        resetInWeekly: 'Waiting',
      });

      onAddLog(oauthMode ? 'OAuth account flow completed.' : `Created new account: ${newEmail} (${newPlan})`, 'success');
      setNewEmail('');
      setNewName('');
      setNewPlan('Pro Plan');
      setNewPriority('Normal');
      setFormError('');
      setShowAddModal(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAdding(false);
    }
  };

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
              总账号: {accounts.length}
            </span>
            <span className="text-slate-400">|</span>
            <span className="flex items-center gap-1.5 text-amber-300 font-bold">
              <Award className="w-3.5 h-3.5 text-amber-400" />
              当前套餐: 企业旗舰版
            </span>
          </div>
        </div>

        {/* Action button triggers */}
        <div className="flex items-center gap-3 shrink-0" id="accounts-actions-group">
          <motion.button
            onClick={handleReloadAccounts}
            disabled={isReloading}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            className="px-5 py-3 rounded-2xl bg-white/10 hover:bg-white/15 border border-white/10 text-white text-xs font-semibold transition-all cursor-pointer shadow-lg"
            id="btn-re-read-accounts"
          >
            重新读取本地账号
          </motion.button>
          <motion.button
            onClick={() => setShowAddModal(true)}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            className="flex items-center gap-1.5 px-5 py-3 rounded-2xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 text-blue-300 hover:text-blue-200 text-xs font-bold transition-all cursor-pointer shadow-lg"
            id="btn-add-account-modal-trigger"
          >
            <Plus className="w-4 h-4" />
            添加账号
          </motion.button>
        </div>
      </div>

      {/* Filters & Search Control Bar */}
      <div 
        className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8 shadow-md"
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
            {accounts.filter(acc => acc.status === 'WARNING' || acc.status === 'EXPIRED').length > 0 && (
              <span className="px-1.5 py-0.5 bg-rose-500 text-white rounded-full text-[9px] font-bold">
                {accounts.filter(acc => acc.status === 'WARNING' || acc.status === 'EXPIRED').length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Cards Double Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" id="accounts-cards-grid">
        {filteredAccounts.map((account) => {
          const isCardRefreshing = refreshingId === account.id;
          const fiveHourPct = Math.round((account.fiveHourQuotaUsed / account.fiveHourQuotaTotal) * 100);
          const weeklyPct = account.weeklyQuotaTotal > 0 ? Math.round((account.weeklyQuotaUsed / account.weeklyQuotaTotal) * 100) : null;
          const hasWarningBanner = account.status === 'WARNING' || account.status === 'EXPIRED';

          // Progress colors
          const color5h = fiveHourPct > 90 
            ? 'bg-gradient-to-r from-rose-500/45 via-rose-400/55 to-rose-500/45 shadow-[0_0_8px_rgba(244,63,94,0.1)]' 
            : fiveHourPct > 75 
              ? 'bg-gradient-to-r from-amber-500/45 via-yellow-400/55 to-amber-500/45 shadow-[0_0_8px_rgba(251,191,36,0.1)]' 
              : 'bg-gradient-to-r from-blue-500/45 via-cyan-400/55 to-blue-400/45 shadow-[0_0_8px_rgba(56,189,248,0.15)]';
          
          const colorWeekly = weeklyPct && weeklyPct > 90 
            ? 'bg-gradient-to-r from-rose-600/45 via-rose-500/55 to-rose-600/45 shadow-[0_0_8px_rgba(225,29,72,0.1)]' 
            : 'bg-gradient-to-r from-blue-500/45 via-indigo-400/55 to-cyan-500/45 shadow-[0_0_8px_rgba(99,102,241,0.15)]';

          return (
            <motion.div
              layout
              key={account.id}
              whileHover={{ y: -4, borderColor: 'rgba(255,255,255,0.12)' }}
              transition={{ type: 'spring', stiffness: 350, damping: 25 }}
              className="backdrop-blur-xl bg-slate-900/35 border border-white/5 rounded-3xl p-6 flex flex-col shadow-2xl relative overflow-hidden transition-all duration-300 group"
              id={`account-manage-card-${account.id}`}
            >
              {/* Highlight glass background on hover */}
              <div className="absolute inset-0 bg-white/[0.01] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

              {/* Card Title Area */}
              <div className="flex items-start justify-between mb-5" id={`account-m-header-${account.id}`}>
                <div className="flex items-center gap-3.5" id={`account-m-user-${account.id}`}>
                  {account.plan === 'Standard' ? (
                    <div className="w-11 h-11 rounded-2xl bg-slate-500/10 border border-slate-500/20 flex items-center justify-center text-slate-400">
                      <Briefcase className="w-5 h-5" />
                    </div>
                  ) : (
                    <div className="w-11 h-11 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                      <User className="w-5 h-5" />
                    </div>
                  )}

                  <div className="flex flex-col text-left select-all" id={`account-m-titles-${account.id}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-100 text-sm tracking-wide font-sans truncate max-w-[140px] sm:max-w-none">
                        {account.email}
                      </span>
                      {account.isCurrent && (
                        <span className="px-2.5 py-0.5 bg-blue-500/20 border border-blue-500/30 text-blue-300 text-[9px] font-bold rounded-full uppercase tracking-wider" id="current-account-badge">
                          Current
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5" id={`account-m-badges-${account.id}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        account.status === 'ACTIVE' ? 'bg-emerald-400' : account.status === 'WARNING' ? 'bg-amber-400' : 'bg-rose-400'
                      }`} />
                      <span className="text-[10px] text-slate-400 font-semibold">{account.status}</span>
                      <span className="text-slate-600">•</span>
                      <span className="text-[10px] text-blue-400 font-bold uppercase tracking-wider">{account.plan}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Red Warning Banner if needed */}
              {hasWarningBanner && (
                <div className="mb-5 p-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-2 text-xs text-rose-300" id={`warning-banner-${account.id}`}>
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span className="font-medium">Quota nearing limit / 配额接近上限</span>
                </div>
              )}

              {/* Token Validity Slider/Progress Info */}
              <div className="space-y-5 flex-1" id={`account-m-details-${account.id}`}>
                {/* TOKEN VALIDITY Row */}
                <div className="space-y-1.5" id={`token-validity-row-${account.id}`}>
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="text-slate-400 uppercase tracking-wider text-[10px] font-mono">TOKEN VALIDITY</span>
                    <span className="text-slate-300 font-semibold">{account.tokenValidity}</span>
                  </div>
                  <div className="h-[3px] bg-slate-950/40 border border-white/[0.03] shadow-[inset_0_1px_1px_rgba(0,0,0,0.5)] rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-blue-500/40 via-cyan-400/50 to-indigo-500/40 rounded-full w-4/5" />
                  </div>
                </div>

                {/* Sub Quotas Progress Boxes Grid */}
                <div className="grid grid-cols-2 gap-4 select-none" id={`quotas-boxes-grid-${account.id}`}>
                  {/* 5H QUOTA */}
                  <div className="bg-slate-950/20 border border-white/5 rounded-2xl p-4 text-left" id={`quota-box-5h-${account.id}`}>
                    <span className="text-[10px] font-bold text-slate-500 tracking-wider uppercase font-mono">5H QUOTA</span>
                    <span className={`text-2xl font-bold block mt-1.5 tracking-tight font-mono ${
                      fiveHourPct > 90 ? 'text-rose-400' : 'text-slate-100'
                    }`}>{fiveHourPct}%</span>
                    <div className="h-[3px] bg-slate-950/40 border border-white/[0.03] shadow-[inset_0_1px_1px_rgba(0,0,0,0.5)] rounded-full overflow-hidden mt-3">
                      <div className={`h-full rounded-full ${color5h}`} style={{ width: `${fiveHourPct}%` }} />
                    </div>
                    <span className="text-[10px] text-slate-500 mt-2 block font-medium">Reset in {account.resetInFiveHour}</span>
                  </div>

                  {/* WEEKLY QUOTA */}
                  <div className="bg-slate-950/20 border border-white/5 rounded-2xl p-4 text-left" id={`quota-box-weekly-${account.id}`}>
                    <span className="text-[10px] font-bold text-slate-500 tracking-wider uppercase font-mono">WEEKLY</span>
                    <span className="text-2xl font-bold text-slate-100 block mt-1.5 tracking-tight font-mono">
                      {weeklyPct !== null ? `${weeklyPct}%` : '--'}
                    </span>
                    <div className="h-[3px] bg-slate-950/40 border border-white/[0.03] shadow-[inset_0_1px_1px_rgba(0,0,0,0.5)] rounded-full overflow-hidden mt-3">
                      <div className={`h-full rounded-full ${colorWeekly}`} style={{ width: `${weeklyPct || 0}%` }} />
                    </div>
                    <span className="text-[10px] text-slate-500 mt-2 block font-medium">
                      {weeklyPct !== null ? `Reset in ${account.resetInWeekly}` : 'No history'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Action buttons footer */}
              <div className="flex items-center justify-between gap-2.5 mt-6 pt-4 border-t border-white/5" id={`account-actions-${account.id}`}>
                {/* 1. Refresh */}
                <motion.button
                  onClick={() => handleSingleRefresh(account.id, account.name)}
                  disabled={isCardRefreshing}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.95 }}
                  transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                  className="flex-1 py-3 px-2 bg-white/5 hover:bg-white/10 rounded-xl text-slate-300 hover:text-white transition-all text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  title="刷新此账号"
                  id={`action-refresh-${account.id}`}
                >
            <RefreshCw className={`w-3.5 h-3.5 ${isCardRefreshing ? 'animate-spin text-blue-400' : ''}`} />
                  Refresh
                </motion.button>

                {/* 2. Switch/Check (Star/Switch) */}
                {account.isCurrent ? (
                  <motion.button
                    className="flex-1 py-3 px-2 bg-blue-500/15 border border-blue-500/30 rounded-xl text-blue-300 transition-all text-xs font-bold flex items-center justify-center gap-1.5 cursor-not-allowed"
                    disabled
                    id={`action-current-${account.id}`}
                  >
                    <Star className="w-3.5 h-3.5 fill-blue-300" />
                    Current
                  </motion.button>
                ) : (
                  <motion.button
                    onClick={() => {
                      onSwitchCurrentAccount(account.id);
                      onAddLog(`Switched active context to account: ${account.email}`, 'success');
                    }}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 20 }}
                    className="flex-1 py-3 px-2 bg-white/5 hover:bg-blue-500/15 hover:text-blue-300 hover:border-blue-500/35 border border-transparent rounded-xl text-slate-300 transition-all text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                    id={`action-switch-${account.id}`}
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                    Switch
                  </motion.button>
                )}

                {/* 3. Delete / Check */}
                <motion.button
                  onClick={() => {
                    if (account.isCurrent) {
                      onAddLog('Cannot delete the active current account.', 'error');
                      return;
                    }
                    onDeleteAccount(account.id);
                    onAddLog(`Deleted account ${account.email} from manager configuration.`, 'warning');
                  }}
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
                  <Trash2 className="w-3.5 h-3.5" />
                </motion.button>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Add Account Modal Overlay */}
      <AnimatePresence>
        {showAddModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="backdrop-blur-2xl bg-slate-900/90 border border-white/10 rounded-3xl p-8 w-full max-w-lg shadow-2xl relative text-white select-none"
              id="add-account-modal"
            >
              <button
                onClick={() => setShowAddModal(false)}
                className="absolute top-5 right-5 p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-all cursor-pointer"
                id="btn-close-modal"
              >
                <X className="w-4 h-4" />
              </button>

              <h3 className="text-xl font-bold tracking-tight mb-2 font-sans">添加配置账号</h3>
              <p className="text-xs text-slate-400 mb-6 font-sans">
                {oauthMode ? '将打开 OpenAI OAuth 授权页面，邮箱、套餐与凭证会在授权完成后自动读取。' : '为 Codex 账号管理器配置一个新的接入凭证和配额检测对象。'}
              </p>

              <form onSubmit={handleAddSubmit} className="space-y-5" id="add-account-form">
                {/* Email input */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-300 tracking-wider uppercase font-mono block ml-1">
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
                  <label className="text-xs font-bold text-slate-300 tracking-wider uppercase font-mono block ml-1">
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
                    <label className="text-xs font-bold text-slate-300 tracking-wider uppercase font-mono block ml-1">
                      选择方案 / 套餐 (Plan)
                    </label>
                    <select
                      value={newPlan}
                      onChange={(e) => setNewPlan(e.target.value as any)}
                      disabled={oauthMode}
                      className="w-full px-4 py-3 bg-slate-950 border border-white/10 rounded-2xl text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all text-xs"
                      id="input-add-plan"
                    >
                      <option value="Pro Plan">Pro Plan</option>
                      <option value="Standard">Standard</option>
                      <option value="Enterprise">Enterprise</option>
                    </select>
                  </div>

                  {/* Priority Select */}
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-300 tracking-wider uppercase font-mono block ml-1">
                      轮转优先级 (Priority)
                    </label>
                    <select
                      value={newPriority}
                      onChange={(e) => setNewPriority(e.target.value as any)}
                      disabled={oauthMode}
                      className="w-full px-4 py-3 bg-slate-950 border border-white/10 rounded-2xl text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all text-xs"
                      id="input-add-priority"
                    >
                      <option value="Ultra">Ultra</option>
                      <option value="High">High</option>
                      <option value="Normal">Normal</option>
                      <option value="Low">Low</option>
                    </select>
                  </div>
                </div>

                {formError && (
                  <p className="text-xs text-rose-400 font-semibold bg-rose-500/10 border border-rose-500/20 p-3 rounded-2xl text-center">
                    {formError}
                  </p>
                )}

                <div className="flex gap-3 pt-4 border-t border-white/5">
                  <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className="flex-1 py-3 bg-white/5 hover:bg-white/10 text-white rounded-2xl text-xs font-semibold cursor-pointer transition-all"
                  >
                    取消
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
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

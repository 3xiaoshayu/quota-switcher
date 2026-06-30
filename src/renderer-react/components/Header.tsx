import { RefreshCw, Bell, User, LogOut } from 'lucide-react';
import { motion } from 'motion/react';

interface HeaderProps {
  activeTab: 'accounts' | 'quotas' | 'autoswitch' | 'settings';
  setActiveTab: (tab: 'accounts' | 'quotas' | 'autoswitch' | 'settings') => void;
  currentUserEmail: string;
  onLogout: () => void;
  onRefreshAll: () => void;
  isRefreshing: boolean;
  unreadNotificationsCount: number;
  onToggleNotifications: () => void;
}

export default function Header({
  activeTab,
  setActiveTab,
  currentUserEmail,
  onLogout,
  onRefreshAll,
  isRefreshing,
  unreadNotificationsCount,
  onToggleNotifications,
}: HeaderProps) {
  const tabs = [
    { id: 'accounts', label: 'Accounts' },
    { id: 'quotas', label: 'Quotas' },
    { id: 'autoswitch', label: 'Auto-Switch' },
    { id: 'settings', label: 'Settings' },
  ] as const;

  return (
    <header 
      className="h-16 border-b border-white/5 backdrop-blur-md bg-slate-950/15 flex items-center justify-between px-8 select-none shrink-0 text-white font-sans"
      id="app-header"
    >
      {/* Brand Logo and Title */}
      <div className="flex items-center gap-2" id="header-logo-group">
        <h1 className="text-lg font-bold tracking-tight text-white font-sans">
          Codex 账号
        </h1>
      </div>

      {/* Center Tab Underlines - Match exactly with the image */}
      <div className="flex items-center gap-6" id="header-nav-tabs">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <motion.button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 450, damping: 25 }}
              className={`text-sm font-medium tracking-wide transition-all py-1.5 px-1 relative cursor-pointer ${
                isActive ? 'text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
              id={`header-tab-${tab.id}`}
            >
              {tab.label}
              {isActive && (
                <motion.div
                  layoutId="headerActiveUnderline"
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-full"
                  transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                />
              )}
            </motion.button>
          );
        })}
      </div>

      {/* Right Utility Actions */}
      <div className="flex items-center gap-4" id="header-utility-actions">
        {/* User Status Badge */}
        <div 
          className="flex items-center gap-1.5 px-3 py-1 bg-white/5 backdrop-blur-md border border-white/5 rounded-full text-xs text-slate-300 font-medium font-sans"
          id="header-user-status"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="opacity-90">User Status: Online</span>
        </div>

        {/* Global Refresh Trigger */}
        <motion.button
          onClick={onRefreshAll}
          disabled={isRefreshing}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.9 }}
          transition={{ type: 'spring', stiffness: 500, damping: 15 }}
          className={`p-2 hover:bg-white/10 rounded-xl text-slate-300 hover:text-white transition-all cursor-pointer relative ${
            isRefreshing ? 'opacity-50' : ''
          }`}
          title="重新加载所有配额"
          id="header-btn-refresh-all"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-blue-400' : ''}`} />
        </motion.button>

        {/* Notifications Bell */}
        <motion.button
          onClick={onToggleNotifications}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.9 }}
          transition={{ type: 'spring', stiffness: 500, damping: 15 }}
          className="p-2 hover:bg-white/10 rounded-xl text-slate-300 hover:text-white transition-all cursor-pointer relative"
          title="系统通知"
          id="header-btn-notifications"
        >
          <Bell className="w-4 h-4" />
          {unreadNotificationsCount > 0 && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-rose-500 rounded-full ring-2 ring-slate-950 animate-bounce" />
          )}
        </motion.button>

        {/* User profile details & Logout */}
        <div className="h-6 w-[1px] bg-white/10" id="header-divider" />

        <div className="flex items-center gap-3" id="header-user-profile-widget">
          <div 
            className="flex items-center gap-2 max-w-40" 
            title={`已登录账号：${currentUserEmail}`}
          >
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-600 to-cyan-500 flex items-center justify-center text-white font-bold text-xs shadow-md border border-white/10">
              <User className="w-3.5 h-3.5" />
            </div>
            <span className="text-xs font-medium text-slate-200 truncate hidden sm:inline max-w-[100px]">
              {currentUserEmail.split('@')[0]}
            </span>
          </div>

          <motion.button
            onClick={onLogout}
            whileHover={{ scale: 1.08, rotate: -5 }}
            whileTap={{ scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 500, damping: 15 }}
            className="p-2 hover:bg-rose-500/10 hover:text-rose-400 rounded-xl text-slate-400 transition-all cursor-pointer"
            title="退出登录"
            id="header-btn-logout"
          >
            <LogOut className="w-4 h-4" />
          </motion.button>
        </div>
      </div>
    </header>
  );
}

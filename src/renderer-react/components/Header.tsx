import { Bell, LogOut, Minus, Square, X } from 'lucide-react';
import { motion } from 'motion/react';
import { avatarGradient, desktopApi, hasDesktopBridge } from '../api/desktop';

interface HeaderProps {
  currentUserEmail: string;
  onLogout: () => void;
  unreadNotificationsCount: number;
  onToggleNotifications: () => void;
}

const windowControlsAvailable = hasDesktopBridge();

export default function Header({
  currentUserEmail,
  onLogout,
  unreadNotificationsCount,
  onToggleNotifications,
}: HeaderProps) {
  return (
    <header 
      className="app-drag h-16 border-b border-white/5 backdrop-blur-md bg-slate-950/15 flex items-center justify-end px-6 select-none shrink-0 text-white font-sans"
      id="app-header"
    >
      {/* Right Utility Actions */}
      <div className="app-no-drag flex items-center gap-4" id="header-utility-actions">
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
            <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-rose-500 rounded-full ring-2 ring-slate-950" />
          )}
        </motion.button>

        {/* User profile details & Logout */}
        <div className="h-6 w-[1px] bg-white/10" id="header-divider" />

        <div className="flex items-center gap-3" id="header-user-profile-widget">
          <div 
            className="flex items-center gap-2 max-w-40" 
            title={`已登录账号：${currentUserEmail}`}
          >
            <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${avatarGradient(currentUserEmail)} flex items-center justify-center text-white font-bold text-xs shadow-md border border-white/10`}>
              {(currentUserEmail.charAt(0) || '?').toUpperCase()}
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

        {/* Window controls */}
        {windowControlsAvailable && (
          <>
            <div className="h-6 w-[1px] bg-white/10" id="header-window-divider" />
            <div className="flex items-center gap-1" id="header-window-controls">
              <button
                onClick={() => void desktopApi.minimizeWindow()}
                className="p-2 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white transition-all cursor-pointer"
                title="最小化"
                id="window-btn-minimize"
              >
                <Minus className="w-4 h-4" />
              </button>
              <button
                onClick={() => void desktopApi.toggleMaximizeWindow()}
                className="p-2 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white transition-all cursor-pointer"
                title="最大化 / 还原"
                id="window-btn-maximize"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => void desktopApi.closeWindow()}
                className="p-2 hover:bg-rose-500/90 hover:text-white rounded-lg text-slate-400 transition-all cursor-pointer"
                title="关闭"
                id="window-btn-close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

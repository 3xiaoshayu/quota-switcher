import { Bell, LogOut, Minus, Square, X } from 'lucide-react';
import { avatarGradient, desktopApi, hasDesktopBridge } from '../api/desktop';

interface HeaderProps {
  currentUserEmail: string;
  onLogout?: () => void;
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
      className="app-drag h-13 min-h-[52px] border-b border-sep flex items-center justify-end px-4 select-none shrink-0 text-label font-sans"
      id="app-header"
    >
      {/* Right Utility Actions */}
      <div className="app-no-drag flex items-center gap-2" id="header-utility-actions">
        {/* Notifications Bell */}
        <button
          onClick={onToggleNotifications}
          className="p-2 hover:bg-fill-2 rounded-lg text-label-2 hover:text-label transition-colors cursor-pointer relative"
          title="系统通知"
          id="header-btn-notifications"
        >
          <Bell className="w-4 h-4" />
          {unreadNotificationsCount > 0 && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-danger rounded-full ring-2 ring-base" />
          )}
        </button>

        <div className="h-5 w-px bg-sep mx-1" id="header-divider" />

        <div className="flex items-center gap-2.5" id="header-user-profile-widget">
          <div
            className="flex items-center gap-2 max-w-40"
            title={`已登录账号：${currentUserEmail}`}
          >
            <div className={`w-7 h-7 rounded-full ${avatarGradient(currentUserEmail)} flex items-center justify-center font-semibold text-xs`}>
              {(currentUserEmail.charAt(0) || '?').toUpperCase()}
            </div>
            <span className="text-[13px] font-medium text-label-2 truncate hidden sm:inline max-w-[110px]">
              {currentUserEmail.split('@')[0]}
            </span>
          </div>

          {onLogout ? (
          <button
            onClick={onLogout}
            className="p-2 hover:bg-danger/12 hover:text-danger rounded-lg text-label-2 transition-colors cursor-pointer"
            title="锁定界面"
            aria-label="锁定界面"
            id="header-btn-logout"
          >
            <LogOut className="w-4 h-4" />
          </button>
          ) : null}
        </div>

        {/* Window controls */}
        {windowControlsAvailable && (
          <>
            <div className="h-5 w-px bg-sep mx-1" id="header-window-divider" />
            <div className="flex items-center gap-0.5" id="header-window-controls">
              <button
                onClick={() => void desktopApi.minimizeWindow()}
                className="p-2 hover:bg-fill-2 rounded-lg text-label-2 hover:text-label transition-colors cursor-pointer"
                title="最小化"
                id="window-btn-minimize"
              >
                <Minus className="w-4 h-4" />
              </button>
              <button
                onClick={() => void desktopApi.toggleMaximizeWindow()}
                className="p-2 hover:bg-fill-2 rounded-lg text-label-2 hover:text-label transition-colors cursor-pointer"
                title="最大化 / 还原"
                id="window-btn-maximize"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => void desktopApi.closeWindow()}
                className="p-2 hover:bg-danger hover:text-white rounded-lg text-label-2 transition-colors cursor-pointer"
                title="关闭到托盘"
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

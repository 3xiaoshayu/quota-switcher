import { AtSign, Gauge, Shuffle, Settings, RefreshCw, HelpCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { DaemonState } from '../types';
import appIcon from '../assets/app-icon.png';

interface SidebarProps {
  activeTab: 'accounts' | 'quotas' | 'autoswitch' | 'settings';
  setActiveTab: (tab: 'accounts' | 'quotas' | 'autoswitch' | 'settings') => void;
  daemonState: DaemonState;
  onShowSupport: () => void;
  onShowUpdates: () => void;
}

export default function Sidebar({
  activeTab,
  setActiveTab,
  daemonState,
  onShowSupport,
  onShowUpdates,
}: SidebarProps) {
  const menuItems = [
    { id: 'accounts', label: '账号管理', icon: AtSign },
    { id: 'quotas', label: '配额总览', icon: Gauge },
    { id: 'autoswitch', label: '自动切号', icon: Shuffle },
    { id: 'settings', label: '系统设置', icon: Settings },
  ] as const;

  return (
    <aside
      className="w-60 bg-white/[0.03] border-r border-sep flex flex-col h-full text-label-2 font-sans shrink-0 overflow-y-auto"
      id="app-sidebar"
    >
      {/* Top Profile / Daemon Area */}
      <div className="app-drag px-5 pt-6 pb-5" id="sidebar-profile-header">
        <div className="flex items-center gap-3" id="sidebar-manager-profile">
          <img
            src={appIcon}
            alt=""
            className="w-10 h-10 rounded-[10px] object-cover shrink-0"
            id="sidebar-avatar-wrapper"
          />
          <div className="flex flex-col select-none" id="sidebar-profile-text">
            <span className="font-semibold text-label text-[13px]">Codex Manager</span>
            <span className="flex items-center gap-1.5 text-[11px] text-label-3 mt-0.5">
              <span className={`w-1.5 h-1.5 rounded-full ${
                daemonState.status === 'Running'
                  ? (daemonState.pausedReason ? 'bg-warn' : 'bg-ok')
                  : 'bg-danger'
              }`} />
              {daemonState.status === 'Running'
                ? (daemonState.pausedReason ? 'Daemon 已暂停' : 'Daemon 运行中')
                : 'Daemon 已停止'}
            </span>
          </div>
        </div>
      </div>

      {/* Navigation List */}
      <nav className="flex-1 px-3 py-2 space-y-0.5" id="sidebar-nav-container">
        {menuItems.map((item) => {
          const isActive = activeTab === item.id;
          const Icon = item.icon;

          return (
            <motion.button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              whileTap={{ scale: 0.98 }}
              className={`w-full flex items-center gap-3 px-3 py-[9px] rounded-lg text-left transition-colors relative cursor-pointer ${
                isActive
                  ? 'bg-fill-2 text-label'
                  : 'text-label-2 hover:bg-fill hover:text-label'
              }`}
              id={`sidebar-nav-${item.id}`}
            >
              <Icon className={`w-[17px] h-[17px] ${isActive ? 'text-accent' : 'text-label-3'}`} />
              <span className="text-[13px] font-medium">
                {item.label}
              </span>
            </motion.button>
          );
        })}
      </nav>

      {/* Footer System Status Info */}
      <div className="px-3 py-3 space-y-0.5 border-t border-sep" id="sidebar-footer-links">
        <button
          onClick={onShowUpdates}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-[12px] text-label-2 hover:text-label hover:bg-fill transition-colors cursor-pointer"
          id="sidebar-footer-btn-updates"
        >
          <RefreshCw className="w-3.5 h-3.5 text-label-3" />
          <span className="font-medium">软件更新</span>
        </button>

        <button
          onClick={onShowSupport}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-[12px] text-label-2 hover:text-label hover:bg-fill transition-colors cursor-pointer"
          id="sidebar-footer-btn-support"
        >
          <HelpCircle className="w-3.5 h-3.5 text-label-3" />
          <span className="font-medium">客户服务</span>
        </button>
      </div>
    </aside>
  );
}

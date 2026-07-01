import { Users, Gauge, Shuffle, Settings, RefreshCw, HelpCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { DaemonState } from '../types';

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
    { id: 'accounts', label: 'ACCOUNTS', cnLabel: '账号管理', icon: Users },
    { id: 'quotas', label: 'QUOTAS', cnLabel: '配额总览', icon: Gauge },
    { id: 'autoswitch', label: 'AUTO-SWITCH', cnLabel: '自动切号', icon: Shuffle },
    { id: 'settings', label: 'SETTINGS', cnLabel: '系统设置', icon: Settings },
  ] as const;

  return (
    <aside 
      className="w-64 backdrop-blur-2xl bg-slate-950/20 border-r border-white/5 flex flex-col h-full text-slate-300 font-sans shrink-0 overflow-y-auto"
      id="app-sidebar"
    >
      {/* Top Profile / Daemon Area */}
      <div className="p-6 border-b border-white/5" id="sidebar-profile-header">
        <div className="flex items-center gap-3" id="sidebar-manager-profile">
          <div className="relative" id="sidebar-avatar-wrapper">
            <div className="w-11 h-11 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 font-bold text-lg shadow-inner">
              C
            </div>
            {/* Status dot */}
            <span className={`absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-slate-950 flex items-center justify-center ${
              daemonState.status === 'Running' ? 'bg-emerald-500' : 'bg-red-500'
            }`} />
          </div>
          <div className="flex flex-col select-none" id="sidebar-profile-text">
            <span className="font-bold text-slate-100 tracking-wide text-sm font-sans">Codex Manager</span>
            <div className="flex items-center gap-1 mt-0.5" id="sidebar-daemon-status-pill">
              <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                daemonState.status === 'Running' ? 'bg-emerald-400' : 'bg-rose-400'
              }`} />
              <span className="text-[10px] text-slate-400 uppercase tracking-widest font-mono font-semibold">
                {daemonState.status === 'Running' ? 'DAEMON RUNNING' : 'DAEMON STOPPED'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation List */}
      <nav className="flex-1 px-4 py-6 space-y-2.5" id="sidebar-nav-container">
        {menuItems.map((item) => {
          const isActive = activeTab === item.id;
          const Icon = item.icon;

          return (
            <motion.button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              whileHover={{ scale: 1.02, x: 4 }}
              whileTap={{ scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 400, damping: 25 }}
              className={`w-full flex items-center gap-3.5 px-4 py-3.5 rounded-2xl text-left transition-all relative group cursor-pointer ${
                isActive 
                  ? 'text-white font-medium bg-white/10 shadow-lg border border-white/10' 
                  : 'hover:bg-white/5 text-slate-400 hover:text-slate-200'
              }`}
              id={`sidebar-nav-${item.id}`}
            >
              <Icon className={`w-4 h-4 transition-transform group-hover:scale-110 duration-200 ${
                isActive ? 'text-blue-400' : 'text-slate-400 group-hover:text-slate-300'
              }`} />
              <div className="flex flex-col text-left" id={`sidebar-nav-${item.id}-text`}>
                <span className="text-[10px] tracking-wider font-mono uppercase font-bold text-slate-400 group-hover:text-slate-200">
                  {item.label}
                </span>
                <span className="text-xs font-medium text-slate-300 mt-0.5">
                  {item.cnLabel}
                </span>
              </div>

              {isActive && (
                <motion.div 
                  layoutId="sidebarActivePill"
                  className="absolute left-1.5 w-1 h-8 rounded-full bg-gradient-to-b from-blue-500 to-cyan-400"
                  transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                />
              )}
            </motion.button>
          );
        })}
      </nav>

      {/* Footer System Status Info */}
      <div className="p-4 space-y-2 border-t border-white/5" id="sidebar-footer-links">
        <motion.button
          onClick={onShowUpdates}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-left text-xs text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-all cursor-pointer"
          id="sidebar-footer-btn-updates"
        >
          <RefreshCw className="w-3.5 h-3.5 text-slate-400 animate-spin-slow" />
          <span className="font-medium tracking-wide">UPDATES / 软件更新</span>
        </motion.button>

        <motion.button
          onClick={onShowSupport}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-left text-xs text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-all cursor-pointer"
          id="sidebar-footer-btn-support"
        >
          <HelpCircle className="w-3.5 h-3.5 text-slate-400" />
          <span className="font-medium tracking-wide">SUPPORT / 客户服务</span>
        </motion.button>
      </div>
    </aside>
  );
}

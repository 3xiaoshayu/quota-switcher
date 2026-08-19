import { useEffect, useRef, useState } from 'react';
import { AtSign, Check, ChevronDown, Gauge, Shuffle, Settings, RefreshCw, HelpCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { DaemonState, ProductKind } from '../types';
import {
  PRODUCTS,
  PRODUCT_ICON_DOCK_LIMIT,
  PRODUCT_PICKER_SEARCH_THRESHOLD,
  productById,
} from '../data/products';
import appIcon from '../assets/app-icon.png';
import iconCodex from '../assets/products/codex.png';
import iconCursor from '../assets/products/cursor.png';
import iconAntigravity from '../assets/products/antigravity.png';

const PRODUCT_ICONS: Record<ProductKind, string> = {
  codex: iconCodex,
  cursor: iconCursor,
  antigravity: iconAntigravity,
};

function ProductIcon({ id, className }: { id: ProductKind; className?: string }) {
  return (
    <img
      src={PRODUCT_ICONS[id]}
      alt=""
      draggable={false}
      className={`block object-cover ${className || ''}`}
    />
  );
}

function ProductSwitch({
  product,
  onProductChange,
}: {
  product: ProductKind;
  onProductChange: (product: ProductKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const overflow = PRODUCTS.length > PRODUCT_ICON_DOCK_LIMIT;
  const dockItems = overflow ? PRODUCTS.slice(0, PRODUCT_ICON_DOCK_LIMIT - 1) : PRODUCTS;
  const overflowItems = overflow ? PRODUCTS.slice(PRODUCT_ICON_DOCK_LIMIT - 1) : [];
  const showSearch = PRODUCTS.length > PRODUCT_PICKER_SEARCH_THRESHOLD;
  const needle = query.trim().toLowerCase();
  const menuItems = needle
    ? overflowItems.filter((item) => item.label.toLowerCase().includes(needle))
    : overflowItems;

  useEffect(() => {
    if (!open) {
      setQuery('');
      return undefined;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative px-3 pb-3" id="sidebar-product-switch" ref={rootRef}>
      <div className="flex items-start gap-0.5" id="sidebar-product-dock">
        {dockItems.map((item) => {
          const selected = product === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onProductChange(item.id);
                setOpen(false);
              }}
              className={`flex-1 min-w-0 flex flex-col items-center gap-1.5 px-1 pt-1.5 pb-1.5 rounded-2xl outline-none cursor-pointer transition-colors ${
                selected ? 'bg-fill-2' : 'hover:bg-fill'
              }`}
              id={`sidebar-product-${item.id}`}
            >
              <span
                className={`rounded-[12px] p-[2px] ${
                  selected ? 'shadow-[0_0_0_1.5px_rgba(255,255,255,0.28)]' : 'shadow-[0_0_0_1px_rgba(255,255,255,0.06)]'
                }`}
              >
                <ProductIcon id={item.id} className="w-9 h-9 rounded-[10px]" />
              </span>
              <span
                className={`text-[10px] font-semibold leading-none truncate max-w-full ${
                  selected ? 'text-label' : 'text-label-3'
                }`}
              >
                {item.label}
              </span>
            </button>
          );
        })}
        {overflow ? (
          <button
            type="button"
            aria-expanded={open}
            aria-haspopup="listbox"
            onClick={() => setOpen((currentOpen) => !currentOpen)}
            className={`flex-1 min-w-0 flex flex-col items-center gap-1.5 px-1 pt-1.5 pb-1.5 rounded-2xl outline-none cursor-pointer transition-colors ${
              open || overflowItems.some((item) => item.id === product) ? 'bg-fill-2' : 'hover:bg-fill'
            }`}
            id="sidebar-product-more"
          >
            <span className="w-9 h-9 rounded-[10px] bg-fill-2 border border-sep flex items-center justify-center text-label-2">
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
            </span>
            <span className="text-[10px] font-semibold leading-none text-label-3">更多</span>
          </button>
        ) : null}
      </div>

      {overflow ? (
        <div
          className={`absolute z-30 left-3 right-3 top-full mt-1.5 p-1 rounded-xl border border-sep bg-surface-2 shadow-xl ${
            open ? '' : 'hidden'
          }`}
          id="sidebar-product-menu"
          role="listbox"
        >
          {showSearch ? (
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 Agent"
              className="w-full mb-1 px-2.5 py-1.5 rounded-lg bg-fill border border-sep text-[12px] text-label placeholder:text-label-3 outline-none"
              id="sidebar-product-search"
            />
          ) : null}
          <div className="max-h-56 overflow-y-auto">
            {menuItems.map((item) => {
              const selected = product === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onProductChange(item.id);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors cursor-pointer outline-none ${
                    selected ? 'bg-fill-2 text-label' : 'text-label-2 hover:bg-fill hover:text-label'
                  }`}
                  id={`sidebar-product-${item.id}`}
                >
                  <ProductIcon id={item.id} className="w-6 h-6 rounded-[7px] shrink-0" />
                  <span className="truncate flex-1 text-left">{item.label}</span>
                  {selected ? <Check className="w-3.5 h-3.5 text-accent shrink-0" /> : null}
                </button>
              );
            })}
            {menuItems.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-label-3" id="sidebar-product-empty">
                没有匹配的 Agent
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface SidebarProps {
  activeTab: 'accounts' | 'quotas' | 'autoswitch' | 'settings';
  setActiveTab: (tab: 'accounts' | 'quotas' | 'autoswitch' | 'settings') => void;
  product: ProductKind;
  onProductChange: (product: ProductKind) => void;
  daemonState: DaemonState;
  onShowSupport: () => void;
  onShowUpdates: () => void;
}

export default function Sidebar({
  activeTab,
  setActiveTab,
  product,
  onProductChange,
  daemonState,
  onShowSupport,
  onShowUpdates,
}: SidebarProps) {
  const menuItems = [
    { id: 'accounts', label: '账号管理', icon: AtSign },
    { id: 'quotas', label: '配额总览', icon: Gauge },
    ...(productById(product).features.autoSwitch ? [{ id: 'autoswitch' as const, label: '自动切号', icon: Shuffle }] : []),
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
            <span className="font-semibold text-label text-[13px]">Account Manager</span>
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

      <ProductSwitch product={product} onProductChange={onProductChange} />


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
          <span className="font-medium">帮助</span>
        </button>
      </div>
    </aside>
  );
}

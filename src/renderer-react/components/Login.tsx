import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Mail, Shield, ShieldCheck, User, ArrowRight, Activity, X } from 'lucide-react';
import { desktopApi, hasDesktopBridge } from '../api/desktop';
import appIcon from '../assets/app-icon.png';

interface LoginProps {
  onLogin: (email: string) => void;
  userEmail: string;
  appVersion?: string;
  showDemoShortcuts?: boolean;
}

const windowControlsAvailable = hasDesktopBridge();

export default function Login({ onLogin, userEmail, appVersion = '0.1.0', showDemoShortcuts = false }: LoginProps) {
  const [email, setEmail] = useState(userEmail || '');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError('请输入电子邮箱');
      return;
    }
    setError('');
    setIsLoading(true);

    setTimeout(() => {
      setIsLoading(false);
      onLogin(email);
    }, 1000);
  };

  const handleQuickLogin = (roleEmail: string) => {
    setIsLoading(true);
    setTimeout(() => {
      setIsLoading(false);
      onLogin(roleEmail);
    }, 800);
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center relative p-4 font-sans select-none overflow-hidden bg-base"
      id="login-page-container"
    >
      {/* Faint top light, matching the dashboard backdrop */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(110% 60% at 50% -8%, rgba(255,255,255,0.05), transparent 62%)' }}
      />

      {/* Frameless-window drag strip and close control */}
      <div className="app-drag fixed top-0 left-0 right-0 h-12" id="login-drag-strip" />
      {windowControlsAvailable && (
        <button
          onClick={() => void desktopApi.closeWindow()}
          className="app-no-drag fixed top-3 right-3 p-2 rounded-lg text-label-3 hover:bg-danger hover:text-white transition-all cursor-pointer z-10"
          title="关闭到托盘"
          id="login-window-close"
        >
          <X className="w-4 h-4" />
        </button>
      )}

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="glass-card w-full max-w-md rounded-2xl p-8 text-label relative overflow-hidden"
        id="login-card"
      >
        <div className="text-center mb-8" id="login-header-group">
          <img
            src={appIcon}
            alt=""
            className="w-14 h-14 rounded-2xl object-cover mb-4 mx-auto"
            id="login-icon-box"
          />
          <h1 className="text-[26px] font-semibold tracking-tight text-label" id="login-title">
            Codex 账号
          </h1>
          <p className="text-[13px] text-label-2 mt-2" id="login-subtitle">
            多账号额度监控与安全切换
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" id="login-form">
          <div className="space-y-2" id="email-field-group">
            <label className="text-[13px] font-medium text-label-2 block ml-1">
              电子邮箱 / 账户名
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-label-3">
                <Mail className="w-4 h-4" />
              </span>
              <input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="请输入邮箱地址"
                className="w-full pl-11 pr-4 py-3 bg-fill rounded-[10px] text-label placeholder-label-3 focus:outline-none focus:ring-2 focus:ring-accent/60 transition-all font-sans text-sm"
                id="login-email-input"
              />
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-[10px] bg-fill px-4 py-3" id="login-dpapi-note">
            <ShieldCheck className="w-4 h-4 text-ok shrink-0 mt-0.5" />
            <span className="text-xs text-label-2 leading-relaxed">
              本地凭证由 Windows DPAPI 加密保护，仅当前 Windows 用户可访问。
            </span>
          </div>

          {error && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className="p-3 bg-danger/12 rounded-[10px] text-xs text-danger text-center"
              id="login-error-container"
            >
              {error}
            </motion.div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-3 bg-accent hover:bg-accent-hi disabled:opacity-50 text-white font-medium rounded-[10px] flex items-center justify-center gap-2 transition-all cursor-pointer text-sm mt-2 active:scale-[0.99]"
            id="login-submit-button"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <Activity className="w-4 h-4 animate-spin" />
                正在读取本地账号...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                进入控制中心
                <ArrowRight className="w-4 h-4" />
              </span>
            )}
          </button>
        </form>

        {showDemoShortcuts ? (
          <>
            <div className="relative my-6 flex items-center justify-center" id="login-divider-row">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-sep"></div>
              </div>
              <span className="relative px-3 bg-surface text-xs text-label-3 font-medium">
                浏览器界面预览
              </span>
            </div>

            {/* Preview-only shortcuts are never rendered by the packaged desktop app. */}
            <div className="grid grid-cols-2 gap-3" id="quick-login-grid">
              <button
                onClick={() => handleQuickLogin(userEmail || 'preview-user@codex.local')}
                className="py-2.5 px-3 bg-fill hover:bg-fill-2 rounded-[10px] text-xs text-label-2 transition-all cursor-pointer text-center truncate flex items-center justify-center gap-1.5"
                id="quick-login-user-btn"
              >
                <User className="w-3.5 h-3.5 text-accent shrink-0" />
                普通预览
              </button>
              <button
                onClick={() => handleQuickLogin('ops-preview@codex.local')}
                className="py-2.5 px-3 bg-fill hover:bg-fill-2 rounded-[10px] text-xs text-label-2 transition-all cursor-pointer text-center truncate flex items-center justify-center gap-1.5"
                id="quick-login-admin-btn"
              >
                <Shield className="w-3.5 h-3.5 text-accent shrink-0" />
                管理预览
              </button>
            </div>
          </>
        ) : (
          <div className="mt-6 rounded-[10px] bg-fill px-4 py-3 text-xs text-label-2 flex items-start gap-3" id="login-desktop-bridge-note">
            <Shield className="w-4 h-4 text-accent shrink-0 mt-0.5" />
            <span>进入后将从本机 Codex 凭证与账号库读取真实账号数据。</span>
          </div>
        )}

        <div className="mt-8 text-center" id="login-footer-credits">
          <p className="text-[11px] text-label-3">
            Codex Account Manager {appVersion.startsWith('v') ? appVersion : `v${appVersion}`}
          </p>
        </div>
      </motion.div>
    </div>
  );
}

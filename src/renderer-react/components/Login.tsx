import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Key, Mail, Shield, User, ArrowRight, Activity, Cpu } from 'lucide-react';
import loginBackground from '../assets/background-login.jpg';

interface LoginProps {
  onLogin: (email: string) => void;
  userEmail: string;
  appVersion?: string;
  showDemoShortcuts?: boolean;
}

export default function Login({ onLogin, userEmail, appVersion = '0.1.0-beta.11', showDemoShortcuts = false }: LoginProps) {
  const [email, setEmail] = useState(userEmail || '');
  const [password] = useState('Windows DPAPI protected');
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
      className="min-h-screen flex items-center justify-center bg-cover bg-center relative p-4 font-sans select-none overflow-hidden"
      style={{ 
        backgroundImage: `linear-gradient(to bottom, rgba(15, 23, 42, 0.45), rgba(15, 23, 42, 0.75)), url('${loginBackground}')`
      }}
      id="login-page-container"
    >
      {/* Decorative Floating ambient lights */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-cyan-400/10 rounded-full blur-3xl pointer-events-none" />

      <motion.div 
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
        className="w-full max-w-md backdrop-blur-xl bg-slate-900/40 border border-white/10 rounded-3xl p-8 shadow-2xl text-white relative overflow-hidden"
        id="login-card"
      >
        {/* Glowing border top */}
        <div className="absolute top-0 left-0 right-0 h-[1.5px] bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />

        <div className="text-center mb-8" id="login-header-group">
          <div className="inline-flex items-center justify-center p-3.5 bg-gradient-to-br from-blue-500/20 to-cyan-400/20 rounded-2xl border border-white/10 mb-4 shadow-lg shadow-cyan-500/5" id="login-icon-box">
            <Cpu className="w-8 h-8 text-cyan-400 animate-pulse" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-300 bg-clip-text text-transparent font-sans" id="login-title">
            Codex 账号
          </h1>
          <p className="text-sm text-slate-300 mt-2 font-light" id="login-subtitle">
            安全、高能的多账户配额及自动切换轮转管理终端
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5" id="login-form">
          <div className="space-y-2" id="email-field-group">
            <label className="text-xs font-semibold text-slate-300 tracking-wider uppercase block ml-1">
              电子邮箱 / 账户名
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-400">
                <Mail className="w-4 h-4" />
              </span>
              <input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="请输入邮箱地址"
                className="w-full pl-11 pr-4 py-3 bg-slate-950/40 border border-white/10 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-400/50 transition-all font-sans text-sm"
                id="login-email-input"
              />
            </div>
          </div>

          <div className="space-y-2" id="password-field-group">
            <label className="text-xs font-semibold text-slate-300 tracking-wider uppercase block ml-1">
              本地凭证保护
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-400">
                <Key className="w-4 h-4" />
              </span>
              <input
                type="text"
                value={password}
                readOnly
                placeholder="Windows DPAPI"
                className="w-full pl-11 pr-4 py-3 bg-slate-950/40 border border-white/10 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-400/50 transition-all font-mono text-sm"
                id="login-password-input"
              />
            </div>
          </div>

          {error && (
            <motion.div 
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className="p-3.5 bg-red-500/15 border border-red-500/25 rounded-2xl text-xs text-red-300 text-center"
              id="login-error-container"
            >
              {error}
            </motion.div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-3.5 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 disabled:opacity-50 text-blue-300 hover:text-blue-200 hover:scale-[1.01] active:scale-[0.99] font-medium rounded-2xl flex items-center justify-center gap-2 transition-all cursor-pointer text-sm mt-2"
            id="login-submit-button"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <Activity className="w-4 h-4 animate-spin text-cyan-400" />
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
            <div className="relative my-7 flex items-center justify-center" id="login-divider-row">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/5"></div>
              </div>
              <span className="relative px-3 bg-slate-900/0 text-xs text-slate-400 font-medium">
                浏览器界面预览
              </span>
            </div>

            {/* Preview-only shortcuts are never rendered by the packaged desktop app. */}
            <div className="grid grid-cols-2 gap-3" id="quick-login-grid">
              <button
                onClick={() => handleQuickLogin(userEmail || 'preview-user@codex.local')}
                className="py-2.5 px-3 backdrop-blur-md bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs text-slate-200 transition-all cursor-pointer text-center truncate flex items-center justify-center gap-1.5"
                id="quick-login-user-btn"
              >
                <User className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                普通预览
              </button>
              <button
                onClick={() => handleQuickLogin('ops-preview@codex.local')}
                className="py-2.5 px-3 backdrop-blur-md bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs text-slate-200 transition-all cursor-pointer text-center truncate flex items-center justify-center gap-1.5"
                id="quick-login-admin-btn"
              >
                <Shield className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                管理预览
              </button>
            </div>
          </>
        ) : (
          <div className="mt-7 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-slate-300 flex items-start gap-3" id="login-desktop-bridge-note">
            <Shield className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <span>进入后将从本机 Codex 凭证与账号库读取真实账号数据。</span>
          </div>
        )}

        <div className="mt-8 text-center" id="login-footer-credits">
          <p className="text-[10px] text-slate-500 font-mono tracking-widest">
            CODEX SECURITY PROTOCOL {appVersion.startsWith('v') ? appVersion : `v${appVersion}`}
          </p>
        </div>
      </motion.div>
    </div>
  );
}

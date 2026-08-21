import { ShieldAlert, X } from 'lucide-react'
import { DesktopAuthState } from '../types'

interface AuthStatusBannerProps {
  authState: DesktopAuthState
  isResolving: boolean
  currentEmail?: string | null
  needsReauthCount?: number
  onReload: () => void
  onAdopt: () => void
  onReapply: () => void
  onDismiss: () => void
}

function copyForStatus(authState: DesktopAuthState, needsReauthCount: number): { title: string; body: string } {
  const reauthHint = needsReauthCount > 0 && authState.status !== 'unknown'
    ? `另有 ${needsReauthCount} 个账号需重新授权。`
    : ''
  if (authState.status === 'unknown') {
    return {
      title: '无法确认官方登录状态',
      body: '自动切号已暂停。可重新加载后再试。',
    }
  }
  if (authState.status === 'missing_official_auth') {
    return {
      title: '官方 Codex 已退出',
      body: `额度刷新仍会继续，自动切号已暂停。${reauthHint ? ` ${reauthHint}` : ''}`,
    }
  }
  if (authState.status === 'unsupported_official_auth') {
    return {
      title: '官方登录无法由本管理器接管',
      body: `额度刷新仍会继续，自动切号已暂停。${reauthHint ? ` ${reauthHint}` : ''}`,
    }
  }
  if (authState.status === 'unmanaged_official_auth') {
    return {
      title: '官方 Codex 已登录，尚未纳入管理',
      body: `自动切号已暂停。可采用官方账号，或稍后处理。${reauthHint ? ` ${reauthHint}` : ''}`,
    }
  }
  return {
    title: '官方 Codex 登录了另一个账号',
    body: `自动切号已暂停。可采用官方账号，或保持管理器当前账号。${reauthHint ? ` ${reauthHint}` : ''}`,
  }
}

export default function AuthStatusBanner({
  authState,
  isResolving,
  currentEmail = null,
  needsReauthCount = 0,
  onReload,
  onAdopt,
  onReapply,
  onDismiss,
}: AuthStatusBannerProps) {
  const copy = copyForStatus(authState, needsReauthCount)
  const showAdopt = authState.status === 'conflict' || authState.status === 'unmanaged_official_auth'
  const showReapply = showAdopt && !!authState.currentAccountId
  const showReload = authState.status === 'unknown'

  return (
    <div
      className="rounded-xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 flex items-center gap-3"
      id="auth-status-banner"
      role="status"
    >
      <ShieldAlert className="w-4 h-4 text-warn shrink-0" />
      <p className="min-w-0 flex-1 text-left text-[13px] leading-5" id="auth-status-banner-title">
        <span className="font-bold text-label">{copy.title}</span>
        <span className="text-label-2"> · {copy.body}</span>
      </p>
      {currentEmail && (
        <span
          className="hidden lg:inline max-w-[240px] truncate rounded-lg bg-warn/10 px-2 py-1 text-[11px] text-label-2"
          title={currentEmail}
          id="auth-status-banner-current"
        >
          当前 {currentEmail}
        </span>
      )}
      {authState.officialIdentity?.email && authState.officialIdentity.email !== currentEmail && (
        <span
          className="hidden xl:inline max-w-[200px] truncate rounded-lg bg-warn/10 px-2 py-1 text-[11px] text-label-2"
          title={authState.officialIdentity.email}
        >
          官方 {authState.officialIdentity.email}
        </span>
      )}
      {showReload && (
        <button
          type="button"
          onClick={onReload}
          disabled={isResolving}
          className="shrink-0 rounded-lg border border-accent/20 bg-accent/12 px-2.5 py-1.5 text-[11px] font-bold text-accent hover:bg-accent/20 disabled:opacity-50 cursor-pointer"
          id="auth-banner-reload"
        >
          重新加载
        </button>
      )}
      {showAdopt && (
        <button
          type="button"
          onClick={onAdopt}
          disabled={isResolving}
          className="shrink-0 rounded-lg border border-accent/20 bg-accent/12 px-2.5 py-1.5 text-[11px] font-bold text-accent hover:bg-accent/20 disabled:opacity-50 cursor-pointer"
          id="auth-banner-adopt"
        >
          {isResolving ? '处理中...' : '采用官方账号'}
        </button>
      )}
      {showReapply && (
        <button
          type="button"
          onClick={onReapply}
          disabled={isResolving}
          className="shrink-0 rounded-lg border border-warn/20 bg-warn/12 px-2.5 py-1.5 text-[11px] font-bold text-warn hover:bg-warn/15 disabled:opacity-50 cursor-pointer"
          id="auth-banner-reapply"
        >
          {isResolving ? '处理中...' : '写回管理账号'}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="p-1.5 shrink-0 rounded-lg text-label-2 hover:bg-fill-2 hover:text-label cursor-pointer"
        title="稍后处理"
        id="auth-banner-dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

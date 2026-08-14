const FALLBACK = '操作失败，请稍后重试'

const RULES: Array<{ test: RegExp; to: string }> = [
  { test: /requires reauthorization before it can be switched/i, to: '该账号需要重新授权后才能写入官方 Codex' },
  { test: /requires reauthorization before tokens can be refreshed/i, to: '该账号需要重新授权后才能刷新 Token' },
  { test: /requires reauthorization before quotas can be refreshed/i, to: '该账号需要重新授权后才能刷新额度' },
  { test: /requires reauthorization before/i, to: '该账号需要重新授权后才能继续操作' },
  { test: /has no refresh token and must be reauthorized/i, to: '该账号没有刷新令牌，请重新授权' },
  { test: /Official Codex authentication is missing/i, to: '官方 Codex 当前没有登录' },
  { test: /signed in with an agent identity/i, to: '官方 Codex 当前是 Agent 身份，本管理器无法接管' },
  { test: /not an OAuth account/i, to: '官方 Codex 当前登录格式不是可管理的账号' },
  { test: /is present but is not managed yet/i, to: '官方 Codex 已登录，但尚未纳入本管理器' },
  { test: /signed into a different account outside this manager/i, to: '官方 Codex 在管理器外登录了另一个账号' },
  { test: /authentication state could not be verified/i, to: '无法确认官方登录状态，自动同步已暂停' },
  { test: /Official Codex authentication changed/i, to: '官方 Codex 登录状态已变更' },
  { test: /Automatic quota sync is paused/i, to: '请先处理官方登录后再自动同步额度' },
  { test: /Quota authorization could not be repaired/i, to: '额度授权无法修复，刷新令牌已失效，请重新授权' },
  { test: /refresh_token_invalidated|invalid_refresh_token|invalid_grant/i, to: '刷新令牌已失效，请重新授权' },
  { test: /Token 已过期且刷新失败/i, to: 'Token 已过期且刷新失败，请重新授权' },
  { test: /target account is incomplete/i, to: '该账号资料不完整，无法切换' },
  { test: /did not exit/i, to: '官方 Codex 未能退出，请稍后重试' },
  { test: /crash recovery window/i, to: '官方 Codex 打开了崩溃恢复窗口，未能正常启动' },
  { test: /did not start within the expected time/i, to: '官方 Codex 未能在预期时间内启动' },
  { test: /Could not enumerate official Codex processes/i, to: '无法读取官方 Codex 进程' },
  { test: /No supported official Codex OAuth login was found/i, to: '没有找到可管理的官方 Codex 登录' },
  { test: /managed current account is not available/i, to: '管理器当前账号不可用' },
  { test: /Managed current account could not be read/i, to: '无法读取管理器当前账号' },
  { test: /Account does not exist/i, to: '账号不存在' },
  { test: /already has an operation in progress/i, to: '该账号已有操作正在进行，请稍候重试' },
  { test: /Desktop bridge is not available/i, to: '桌面服务未连接，请通过应用窗口打开' },
  { test: /OAuth token exchange failed/i, to: '换取登录令牌失败' },
  { test: /did not contain an access token/i, to: '授权响应缺少访问令牌' },
  { test: /identity token could not be parsed/i, to: '无法解析登录身份' },
  { test: /authorization is already in progress/i, to: '已有授权正在进行' },
  { test: /Waiting for browser authorization/i, to: '请在浏览器完成授权' },
  { test: /OAuth authorization timed out/i, to: '授权超时，请重新点一次' },
  { test: /pending OAuth authorization expired/i, to: '授权已过期，请重新点一次' },
  { test: /pending OAuth authorization could not be restored/i, to: '未完成的授权无法恢复，请重新点一次' },
  { test: /OAuth authorization was cancelled/i, to: '授权已取消' },
  { test: /OAuth callback port .+ is unavailable/i, to: '授权回调端口被占用，请关闭后重试' },
  { test: /No OAuth authorization is pending/i, to: '当前没有等待完成的授权' },
  { test: /Enter the complete OAuth callback URL/i, to: '请输入完整的授权回调地址' },
  { test: /missing code or has an invalid state/i, to: '回调地址缺少授权码或状态不正确' },
  { test: /Token refresh failed/i, to: 'Token 刷新失败' },
  { test: /^auth_conflict$/i, to: '官方登录不一致' },
  { test: /^stopped$/i, to: '已停止' },
  { test: /^disabled$/i, to: '全局开关已关闭，不会切号' },
]

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

export function toUserMessage(raw: unknown): string {
  const text = String(raw || '').trim()
  if (!text) return FALLBACK
  for (const rule of RULES) {
    if (rule.test.test(text)) return rule.to
  }
  if (hasChinese(text)) return text
  return FALLBACK
}

export function logTypeLabel(type: string): string {
  if (type === 'success') return '成功'
  if (type === 'warning') return '警告'
  if (type === 'error') return '错误'
  return '信息'
}

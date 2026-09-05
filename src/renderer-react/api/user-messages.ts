const FALLBACK = '操作失败，请稍后重试'

// Copy chosen by the stable error code the engine or main process attached.
// This is consulted before any message matching, so wording changes in the
// engine cannot silently turn a specific message into the fallback. Every
// code the engine produces must have an entry (test/error-codes.test.js).
export const CODE_MESSAGES: Readonly<Record<string, string>> = {
  account_banned: '账号已封号，无法继续使用。',
  account_not_found: '账号不存在',
  antigravity_app_path_not_found: '没有找到官方 Antigravity IDE，请先安装后再切号',
  antigravity_cloudcode_timeout: '这次没查清 Antigravity 额度，请稍后重试',
  antigravity_oauth_client_missing: '没有找到官方 Antigravity 的授权配置，网页授权暂时不可用。',
  antigravity_process_enumeration_failed: '无法读取官方 Antigravity IDE 进程',
  antigravity_process_still_running: '官方 Antigravity IDE 没能退出，请手动关掉后再切',
  antigravity_session_missing: '这次没查清 Antigravity 额度，请稍后重试',
  antigravity_switch_verify_failed: '官方登录写入后核对失败，没有切到目标账号',
  antigravity_vscdb_busy: '官方 Antigravity IDE 还在占用登录库，请关掉后再切',
  antigravity_vscdb_open_failed: '官方 Antigravity IDE 登录库无法打开',
  auth_conflict: '官方登录了另一个账号',
  codex_process_enumeration_failed: '无法读取官方 Codex 进程',
  codex_switch_verify_failed: '官方登录写入后核对失败，没有切到目标账号',
  credential_decrypt_failed: '账号凭据无法解密，请重新授权这个账号',
  cursor_app_path_not_found: '没有找到官方 Cursor，请先安装后再切号',
  cursor_process_enumeration_failed: '无法读取官方 Cursor 进程',
  cursor_process_still_running: '官方 Cursor 没能退出，请手动关掉后再切',
  cursor_session_missing: '这次没查清 Cursor 额度，请稍后重试',
  cursor_switch_verify_failed: '官方登录写入后核对失败，没有切到目标账号',
  cursor_vscdb_busy: '官方 Cursor 还在占用登录库，请关掉后再切',
  cursor_vscdb_open_failed: '官方 Cursor 登录库无法打开',
  engine_worker_unknown_op: '后台服务不支持这个操作，请更新软件',
  invalid_usage_json: '这次没查清额度，请稍后重试',
  missing_refresh_token: '该账号没有刷新令牌，请重新授权',
  oauth_cancelled: '授权已取消',
  oauth_denied: '你在浏览器里拒绝了授权',
  oauth_port_unavailable: '授权回调端口被占用，请关闭后重试',
  oauth_state_mismatch: '这次授权和当前等待的对不上，请关闭页面后重新点一次网页授权',
  oauth_timeout: '授权超时，请重新点一次',
  probe_failed: '额度暂时没刷到，登录还在。请稍后再试。',
  proxy_gateway: '代理没有转发成功，请检查代理后重试',
  quota_retry_pending: '额度刷新稍后会自动重试',
  reauthorization_required: '该账号需要重新授权后才能继续操作',
  response_decode_failed: '额度暂时没刷到，登录还在。请稍后再试。',
  response_too_large: '额度暂时没刷到，登录还在。请稍后再试。',
  should_logout: '登录已失效，请重新授权',
  token_refresh_failed: '令牌刷新失败',
  unsupported_url: '这个链接不能在外部打开',
  untrusted_sender: '请求来源不受信任，已拒绝',
}

type CodedError = { code?: unknown; message?: unknown }

export function errorCode(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const code = (raw as CodedError).code
  return typeof code === 'string' && code ? code : null
}

const RULES: Array<{ test: RegExp; to: string }> = [
  { test: /is banned and cannot refresh quotas/i, to: '账号已封号，无法刷新额度' },
  { test: /is banned and cannot be switched/i, to: '账号已封号，无法切换' },
  { test: /is banned and token refresh is skipped/i, to: '账号已封号，不再刷新令牌' },
  { test: /requires reauthorization before it can be switched/i, to: '该账号需要重新授权后才能切换' },
  { test: /requires reauthorization before tokens can be refreshed/i, to: '该账号需要重新授权后才能刷新令牌' },
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
  { test: /^auth_conflict$/i, to: '官方登录了另一个账号' },
  { test: /^conflict$/i, to: '官方登录了另一个账号' },
  { test: /^unknown$/i, to: '无法确认官方登录状态，自动同步已暂停' },
  { test: /^missing_official_auth$/i, to: '官方 Codex 已退出' },
  { test: /^unsupported_official_auth$/i, to: '官方登录无法由本管理器接管' },
  { test: /^unmanaged_official_auth$/i, to: '官方 Codex 已登录，尚未纳入管理' },
  { test: /Quota authorization could not be repaired.{0,120}HTTP\s+5\d\d/i, to: '服务暂时不可用，请稍后刷新额度' },
  { test: /Quota authorization could not be repaired/i, to: '额度授权无法修复，刷新令牌已失效，请重新授权' },
  { test: /refresh_token_invalidated|invalid_refresh_token|invalid_grant/i, to: '刷新令牌已失效，请重新授权' },
  { test: /(?:Token 已过期且刷新失败|令牌已过期且刷新失败).{0,120}HTTP\s+5\d\d/i, to: '服务暂时不可用，请稍后刷新额度' },
  { test: /Token 已过期且刷新失败|令牌已过期且刷新失败/i, to: '令牌已过期且刷新失败，请重新授权' },
  { test: /target account is incomplete/i, to: '该账号资料不完整，无法切换' },
  { test: /Official Antigravity(?: IDE)? did not exit|antigravity_process_still_running/i, to: '官方 Antigravity IDE 没能退出，请手动关掉后再切' },
  { test: /did not exit/i, to: '官方 Codex 未能退出，请稍后重试' },
  { test: /crash recovery window/i, to: '官方 Codex 打开了崩溃恢复窗口，未能正常启动' },
  { test: /did not start within the expected time/i, to: '官方 Codex 未能在预期时间内启动' },
  { test: /官方登录写入后核对失败|codex_switch_verify_failed/i, to: '官方登录写入后核对失败，没有切到目标账号' },
  { test: /登录库写入后核对失败|系统凭据写入后核对失败|antigravity_switch_verify_failed/i, to: '官方登录写入后核对失败，没有切到目标账号' },
  { test: /Official Cursor was not found|cursor_app_path_not_found/i, to: '没有找到官方 Cursor，请先安装后再切号' },
  { test: /Official Antigravity IDE was not found|antigravity_app_path_not_found/i, to: '没有找到官方 Antigravity IDE，请先安装后再切号' },
  { test: /Official Cursor did not exit|cursor_process_still_running/i, to: '官方 Cursor 没能退出，请手动关掉后再切' },
  { test: /官方 Antigravity(?: IDE)? 还在占用登录库|antigravity_vscdb_busy/i, to: '官方 Antigravity IDE 还在占用登录库，请关掉后再切' },
  { test: /还在占用登录库|cursor_vscdb_busy/i, to: '官方 Cursor 还在占用登录库，请关掉后再切' },
  { test: /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i, to: '登录库正被占用，请关掉后再试' },
  { test: /官方 Antigravity(?: IDE)? 登录库无法打开|antigravity_vscdb_open_failed/i, to: '官方 Antigravity IDE 登录库无法打开' },
  { test: /登录库无法打开|cursor_vscdb_open_failed/i, to: '官方 Cursor 登录库无法打开' },
  { test: /Could not enumerate official Cursor processes/i, to: '无法读取官方 Cursor 进程' },
  { test: /Could not enumerate official Antigravity(?: IDE)? processes|antigravity_process_enumeration_failed/i, to: '无法读取官方 Antigravity IDE 进程' },
  { test: /Cursor refresh token/i, to: 'Cursor 刷新令牌已失效，请重新授权' },
  { test: /Cursor 会话已过期/i, to: 'Cursor 登录已失效，请重新授权' },
  { test: /Cursor session cookie|Cursor usage request failed|Cursor usage response was not JSON|cursor_session_missing|invalid_usage_json/i, to: '这次没查清 Cursor 额度，请稍后重试' },
  { test: /Antigravity usage request failed|Antigravity usage response was not JSON|antigravity_session_missing/i, to: '这次没查清 Antigravity 额度，请稍后重试' },
  { test: /Could not read the official Antigravity OAuth client|Official Antigravity OAuth client was not found|antigravity_oauth_client_missing/i, to: '没有找到官方 Antigravity 的授权配置，网页授权暂时不可用。' },
  { test: /Google 登录已失效/i, to: 'Google 登录已失效，请重新授权' },
  { test: /未找到本地 Cursor|not found local Cursor|found":false/i, to: '本机没有已登录的 Cursor' },
  { test: /本机没有已登录的 Antigravity|not found local Antigravity/i, to: '本机没有已登录的 Antigravity IDE' },
  { test: /cannot be switched into official Codex/i, to: 'Cursor 账号不能写进官方 Codex' },
  { test: /cannot be written to official Codex/i, to: 'Cursor 账号不能写进官方 Codex' },
  { test: /not an Antigravity account/i, to: '该账号不是 Antigravity 账号，无法切换' },
  { test: /not a Cursor account/i, to: '该账号不是 Cursor 账号，无法切换' },
  { test: /Official Antigravity 2\.0 login cannot be written/i, to: '官方 Antigravity 登录写不进去' },
  { test: /Could not enumerate official Codex processes/i, to: '无法读取官方 Codex 进程' },
  { test: /No supported official Codex OAuth login was found/i, to: '本机没有已登录的 Codex' },
  { test: /managed current account is not available/i, to: '管理器当前账号不可用' },
  { test: /Managed current account could not be read/i, to: '无法读取管理器当前账号' },
  { test: /Account does not exist/i, to: '账号不存在' },
  { test: /Switch to another account before deleting/i, to: '请先切到其他账号，再删除当前账号' },
  { test: /refresh_token needs re-authorization/i, to: '刷新令牌已失效，请重新授权' },
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
  { test: /OAuth callback was missing a code/i, to: '回调缺少授权码，请关闭页面后重新点一次网页授权' },
  { test: /OAuth callback state did not match/i, to: '这次授权和当前等待的对不上，请关闭页面后重新点一次网页授权' },
  { test: /(token refresh failed|quota authorization could not be repaired).{0,160}account_disabled/i, to: '刷新令牌已失效，请重新授权' },
  { test: /HTTP 40[13]\b.*\baccount_disabled\b|\baccount_disabled\b.*HTTP 40[13]\b/i, to: '账号已封号，无法继续使用。' },
  { test: /\baccount_disabled\b/i, to: '刷新令牌已失效，请重新授权' },
  { test: /Token refresh failed.{0,120}HTTP\s+5\d\d/i, to: '服务暂时不可用，请稍后刷新额度' },
  { test: /Token refresh failed/i, to: '令牌刷新失败' },
  { test: /Authentication state is busy|Read authentication state timed out/i, to: '正在确认官方登录，稍后会自动刷新' },
  { test: /quota refresh is waiting for retry|quota_retry_pending/i, to: '额度刷新稍后会自动重试' },
  { test: /account_deactivated|account_deleted|workspace_deactivated|deactivated_workspace|deactivated_user/i, to: '账号已封号，无法继续使用。' },
  { test: /^HTTP \d+/i, to: '服务暂时不可用，请稍后刷新额度' },
  { test: /^current_not_found$/i, to: '没有当前账号' },
  { test: /^stopped$/i, to: '已停止' },
  { test: /^Daemon error$/i, to: '后台检查失败，请稍后重试' },
  { test: /EISDIR|illegal operation on a directory/i, to: '登录文件暂时读不到，请稍后重试' },
  { test: /EPERM|EACCES|operation not permitted/i, to: '正在确认官方登录，稍后会自动刷新' },
]

const NETWORK_FAILURE = '额度暂时没刷到，登录还在。请稍后再试。'

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

export function isQuotaNetworkFailure(text: string): boolean {
  return /网络请求失败/.test(text)
    || /ERR_CONNECTION|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL|ENETDOWN|EHOSTDOWN|EPIPE|UND_ERR|net::ERR_/i.test(text)
    || /engine_worker_down|Engine worker timed out|Engine worker is not running|Engine worker exited/i.test(text)
    || /Electron network failed|Node network failed|network unavailable/i.test(text)
    || /Invalid string length|response_too_large|响应过大|响应解压失败|请求超时/i.test(text)
    || /Unexpected token|unexpected_non_json|响应不是 JSON|响应无 access_token/i.test(text)
}

export function isQuotaTemporaryFailure(text: string): boolean {
  return isQuotaNetworkFailure(text)
    || /HTTP\s+5\d\d/.test(text)
    || /HTTP\s+429/.test(text)
    || /rate.?limit/i.test(text)
    || /这次没查清|invalid_usage_json|was not JSON|响应不是 JSON|响应无 access_token/i.test(text)
    || /服务暂时不可用/.test(text)
}

// These codes cover several situations whose messages say which one it is
// ("before it can be switched" vs "before quotas can be refreshed"); keep the
// more specific message copy when it exists and is still about the same thing.
const MESSAGE_REFINED_CODES: Readonly<Record<string, RegExp>> = {
  reauthorization_required: /重新授权/,
  account_banned: /封号/,
}

function messageText(raw: unknown): string {
  if (raw && typeof raw === 'object') {
    const message = (raw as CodedError).message
    return String(message ?? '').trim()
  }
  return String(raw ?? '').trim()
}

function translateText(text: string): string | null {
  if (!text) return null
  if (isQuotaNetworkFailure(text)) return NETWORK_FAILURE
  for (const rule of RULES) {
    if (rule.test.test(text)) return rule.to
  }
  if (hasChinese(text) && !/Electron:|Node:|net::|ETIMEDOUT|ERR_CONNECTION/i.test(text)) {
    return text
  }
  return null
}

// Accepts an Error (ideally a DesktopError carrying `code`), a bare code
// string, or a raw message. Codes win over message text.
export function toUserMessage(raw: unknown): string {
  const code = errorCode(raw)
  const text = messageText(raw)
  if (code && CODE_MESSAGES[code]) {
    const sameTopic = MESSAGE_REFINED_CODES[code]
    if (sameTopic) {
      const refined = translateText(text)
      if (refined && sameTopic.test(refined)) return refined
    }
    return CODE_MESSAGES[code]
  }
  if (!text) return FALLBACK
  if (!code && CODE_MESSAGES[text]) return CODE_MESSAGES[text]
  return translateText(text) ?? FALLBACK
}

export function toCursorUserMessage(raw: unknown): string {
  const text = toUserMessage(raw)
  if (text.includes('已封号')) return 'Cursor 登录已失效，请重新授权'
  if (text.includes('没查清') && !text.includes('Cursor')) return '这次没查清 Cursor 额度，请稍后重试'
  return text
}

export function toAntigravityUserMessage(raw: unknown): string {
  const text = toUserMessage(raw)
  if (text.includes('已封号')) return 'Google 登录已失效，请重新授权'
  if (text.includes('没查清')) return '这次没查清 Antigravity 额度，请稍后重试'
  return text
}

export function logTypeLabel(type: string): string {
  if (type === 'success') return '成功'
  if (type === 'warning') return '警告'
  if (type === 'error') return '错误'
  return '信息'
}

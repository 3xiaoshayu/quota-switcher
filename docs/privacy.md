# 隐私说明

[English](privacy.en.md)

账号只存在这台电脑上。这个项目没有自己的服务器，不收集使用数据，也不做跨设备同步。

## 本机存什么

| 位置 | 里面是什么 |
| --- | --- |
| `%USERPROFILE%\.codex-switch\accounts.json` | Codex 账号列表和当前号 |
| `%USERPROFILE%\.codex-switch\cursor-accounts.json` | Cursor 账号列表和当前号 |
| `%USERPROFILE%\.codex-switch\antigravity-accounts.json` | Antigravity 账号列表和当前号 |
| `%USERPROFILE%\.codex-switch\auto-switch.json` | 自动切号的线和范围 |
| `%USERPROFILE%\.codex-switch\accounts\*.json` | Codex 账号资料，登录凭证用 Windows 加密 |
| `%USERPROFILE%\.codex-switch\cursor-accounts\*.json` | Cursor 账号资料，登录凭证用 Windows 加密 |
| `%USERPROFILE%\.codex-switch\antigravity-accounts\*.json` | Antigravity 账号资料，登录凭证用 Windows 加密 |
| `%USERPROFILE%\.codex-switch\codex_oauth_pending.json` | 正在进行的 Codex 网页授权，完成后会删 |
| `%USERPROFILE%\.codex-switch\cursor_oauth_pending.json` | 正在进行的 Cursor 网页授权，完成后会删 |
| `%USERPROFILE%\.codex-switch\antigravity_oauth_pending.json` | 正在进行的 Antigravity 网页授权，完成后会删 |
| `%USERPROFILE%\.codex-switch\logs\app-YYYY-MM-DD.log` | 三天内的运行日志，会抹掉凭证和邮箱 |
| `%USERPROFILE%\.codex\auth.json` | 官方 Codex 正在用的登录 |
| `%USERPROFILE%\.codex\auth.json.bak` | 上一次 Codex 登录的备份 |
| `%USERPROFILE%\.codex\codex_auth_projection.json` | 管理器记下的当前 Codex |
| `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | 切 Cursor 时写入的官方登录库 |
| `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` | 切 Antigravity 时写入的官方登录库 |

安装包里不带账号和凭证。仓库首页截图已打码邮箱。

## 登录怎么保护

保存下来的登录，用 Windows 当前用户的加密。换一个 Windows 用户，或换一台电脑，一般解不开。

防不住这些情况：

- 同一 Windows 用户下的木马
- 能管这台电脑的管理员
- 你自己发出去的截图、日志或文件
- 上游账号或 Windows 登录已经被别人拿了

官方 Codex 的 `auth.json`、官方 Cursor / Antigravity 的 `state.vscdb` 必须能被官方软件读到，请当成敏感文件。

日志会抹掉 token、回调、邮箱。发出去之前再看一眼。

## 会访问哪些网站

只有你点了功能，或后台在续登录、刷额度时才会联网。界面背景图打在安装包里，运行时不会去下图。

| 去哪 | 做什么 |
| --- | --- |
| `auth.openai.com` | Codex 登录和续登录 |
| `chatgpt.com` | Codex 额度和账号资料 |
| `cursor.com` | Cursor 登录和用量 |
| `api2.cursor.sh` | Cursor 续登录和账号资料 |
| `accounts.google.com` | Antigravity 网页授权 |
| `oauth2.googleapis.com` | Antigravity 换票和续登录 |
| `www.googleapis.com` | Antigravity 读取 Google 账号邮箱 |
| `cloudcode-pa.googleapis.com` | Antigravity 额度 |
| `github.com` 及 Release 地址 | 下载更新 |

账号列表和 token 不会发到本项目的服务器。OpenAI、Cursor、Google、GitHub 和你的网络提供方仍可能按各自规则记日志。

Google 第三方登录存在风控讨论。第一期只把本机已登录的官方 **Antigravity IDE** 管起来，默认不当成可以广推的稳妥方案。额度没查清或需要重新授权时，不会按 Codex 的「已封号」来处理。

本机如果开着 HTTP / SOCKS 代理，额度刷新会跟着走。代理密码不会写进日志。

## 后台会做什么

开着的时候，它可能刷新过期额度、续一下快到期的登录，并按你设的线判断要不要换 Codex。用的都是存在本机的登录。

自动切号默认关着，而且只换 Codex。它不会给你加额度，也绕不过上游限制。

## 切号会动哪些文件

切 Codex：

- 先让官方 Codex 正常退出，超时再结束还在的进程
- 备份 `auth.json.bak`
- 清掉 Codex `config.toml` 里的自定义接口地址
- 把选中的号写进 `auth.json`
- 再拉起微软商店版 Codex

切 Cursor：

- 先让官方 Cursor 退出
- 只改 `state.vscdb` 里的登录键，不整文件覆盖
- 官方还在占用登录库时不会写入
- 再打开官方 Cursor

切 Antigravity：

- 先让官方 Antigravity IDE 退出
- 只改 `state.vscdb` 里的 OAuth token 那一条
- 官方还在占用登录库时不会写入
- 再打开官方 Antigravity IDE
- 第一期不管旧版 `Antigravity.exe`，也不多开实例

官方 Codex 在管理器外面换了号，写入和自动切号会停，等你选「采用官方账号」或「写回管理账号」。

切号前把手头的活做完。切 Cursor 或 Antigravity 会关掉对应的官方窗口，没保存的编辑可能丢。

## 卸载以后

卸掉应用不会自动删账号。不要了，再自己删 `%USERPROFILE%\.codex-switch`。

删了就回不来。不要顺便删 `%USERPROFILE%\.codex`、`%APPDATA%\Cursor` 或 `%APPDATA%\Antigravity IDE`，那是官方软件自己的数据。

## 来报问题时

这些不要附在 Issue 里：

- `.codex-switch`
- `.codex\auth.json` 和它的备份
- Cursor / Antigravity 的 `state.vscdb` 以及旁边的 WAL / SHM
- 授权回调地址
- 带请求头的完整日志

截图请打码邮箱。不要附 token 或账号文件。凭据泄露请走
[私下报告](https://github.com/3xiaoshayu/codex-account-manager/security/advisories/new)。

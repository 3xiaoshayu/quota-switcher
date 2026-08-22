# 安全说明

[English](SECURITY.en.md)

这个应用会保存登录，也会改本机官方 Codex / Cursor / Antigravity 的登录。安全报告会优先看。

## 哪些版本还管

| 版本 | 是否修补 |
| --- | --- |
| 最新正式版 | 管 |
| 更早的版本 | 不管 |

## 怎么报告

走
[GitHub 私下报告](https://github.com/3xiaoshayu/codex-account-manager/security/advisories/new)。

这些不要开公开 Issue：

- 能拿出来用的 token
- 授权回调或校验有漏洞
- 能乱读文件或跑命令
- 更新渠道不安全
- 加密迁移失败
- 切号可能毁掉别人的本机数据

写上版本、Windows 版本、怎么复现、会怎样。不要寄真实 token 或完整账号文件。

能确认的报告会尽快回，修好之前私下谈。愿意署名的，可以写进致谢。

## 这些文件很敏感

- `%USERPROFILE%\.codex-switch`：加密后的账号和配置
- `%USERPROFILE%\.codex\auth.json`：官方 Codex 正在用的登录
- `%USERPROFILE%\.codex\auth.json.bak`：上一份 Codex 登录
- `%APPDATA%\Cursor\User\globalStorage\state.vscdb`：官方 Cursor 登录
- `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb`：官方 Antigravity 登录

不要把这些目录或文件附到 Issue。截图请打码邮箱。日志里的回调、token、授权头请先抹掉。

## 边界

- 管理器里保存的登录，用 Windows 加密
- 官方 Codex 的 `auth.json` 必须能被 Codex 读到
- 官方 Cursor 的 `state.vscdb` 必须能被 Cursor 读到
- 同一 Windows 用户下的程序，或管理员，加密也挡不住
- 上游 OpenAI、Cursor、GitHub、Electron、Windows 各自的安全，不在本项目控制里
- 没签名的安装包可能被 SmartScreen 拦，请对 SHA-256

本机数据和联网访问见[隐私说明](docs/privacy.md)。

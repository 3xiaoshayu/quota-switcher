# 支持

[English](SUPPORT.en.md)

当前完整版是 **2.0.6**。Issue 仍收能复现的缺陷。

## 使用和报错

能复现的问题、本机账号 / 额度 / 切号上的真实缺口，请用仓库里的表格：

- [缺陷反馈](https://github.com/3xiaoshayu/codex-account-manager/issues/new?template=bug_report.yml)
- [功能建议](https://github.com/3xiaoshayu/codex-account-manager/issues/new?template=feature_request.yml)

开 Issue 之前：

1. 先更新到 2.0.6
2. 看过[故障排查](docs/troubleshooting.md)
3. 说清楚是 Codex、Cursor，还是两个都有
4. 问题跟切号或导入有关时，确认对应的官方客户端已经装着
5. 不要附 token、账号文件或授权回调。截图请打码邮箱

这是社区项目，能看就看，不保证回复时间。讨论时请看[行为约定](CODE_OF_CONDUCT.md)。

## 安全

怀疑凭证泄露或安全漏洞，不要开公开 Issue。看 [SECURITY.md](SECURITY.md)，走
[私下报告](https://github.com/3xiaoshayu/codex-account-manager/security/advisories/new)。

## 这些不要上传

- `%USERPROFILE%\.codex-switch`
- `%USERPROFILE%\.codex\auth.json` 或 `auth.json.bak`
- `%APPDATA%\Cursor\User\globalStorage\state.vscdb` 以及旁边的 WAL / SHM
- 授权回调地址
- 访问令牌、刷新令牌
- 带授权头的日志

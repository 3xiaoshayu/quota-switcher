<div align="center">

# Quota Switcher

在 Windows 上查看并切换 Codex、Cursor 与 Antigravity 账号。
额度、登录状态与凭证只保存在本机，并使用当前 Windows 用户加密。

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
[![CI](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/code-MIT-2f855a)](LICENSE)

[下载安装包](https://github.com/3xiaoshayu/codex-account-manager/releases) ·
[故障排查](docs/troubleshooting.md) ·
[隐私说明](docs/privacy.md) ·
[English](README.en.md)

</div>

![Cursor 账号与额度，侧栏可切换到 Codex 或 Antigravity](docs/images/account-dashboard.png)

> [!IMPORTANT]
> 安装包尚未代码签名，Windows 可能提示“未知发布者”。请只从本仓库
> [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases) 下载，并用同一条 Release 中的 `SHA256SUMS.txt` 核对 SHA-256。

## 功能

- **三个产品，一个窗口。** 侧栏在 Codex、Cursor、Antigravity 之间切换。每个账号一张卡片，剩余额度与套餐状态可直接阅读。
- **写入官方客户端。** 切换时更新本机官方登录，而不是另开一套云端会话。
- **Codex 可在后台自动切换。** 额度低于你设定的阈值时按规则换号；关闭窗口后仍继续运行。Cursor 与 Antigravity 支持查看和手动切换，不提供自动切换。
- **本机优先。** 账号库使用 Windows DPAPI 加密。没有遥测，也没有项目方云服务。
- **托盘与桌面额度镜。** 关闭到托盘，桌面上放置额度浮窗，并可检查登录有效期。

切换会先结束对应的官方进程。请先保存工作再切号。本软件不能提高任何官方额度。

Antigravity 目前对接官方 **Antigravity IDE**（导入本机登录、Google 网页授权、切换、刷新额度、浮窗）。不管理旧版 `Antigravity.exe`。额度未查清时，不会显示为封号。

## 与 Cockpit Tools

社区里常被对照的是 [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools)。那是覆盖很多 AI IDE 的通用驾驶舱。Quota Switcher 走另一条路径：把 **Windows 上 Codex、Cursor、Antigravity 的本机账号库、额度与切号** 做成完整产品。相对通用驾驶舱，下面这些是我们专门做深的部分。

**Windows 本机保险柜。** 账号与 token 使用当前 Windows 用户的 DPAPI（Electron `safeStorage`）加密；换 Windows 用户或换电脑，一般解不开。界面只接收账号元数据，token 不会解密进渲染进程。没有遥测，也没有项目方云服务。

**Codex 切号按事务提交。** 切换前先快照官方登录、管理器投影和账号索引；后面任一步失败则整段回滚，而不是先写完 `auth.json` 再设法补救。官方登录与管理器记录不一致时，窗口提供「采用官方账号」或「写回管理账号」，不会静默覆盖。

**Cursor / Antigravity 原地写入官方登录库。** 切号时在 `state.vscdb` 上使用 WAL 与 `BEGIN IMMEDIATE` 原地更新，不再把大型数据库整文件拷来拷去。Cursor 切号会恢复目标账号的资料、团队会话和用量身份，并清掉上一个号留下的团队缓存，避免 Pro 账号停在别人的团队里。

**额度请求不走 Chromium 会话。** 出站 HTTP 由 Node 直连，并按代理签名保持 keep-alive，主窗口不容易因此卡成「未响应」。三家额度按 5 路并发刷新；窗口和桌面额度镜使用快照加补丁更新，而不是每次整页重拉。批量刷新会跳过已经需要重新授权或已封号的账号，避免把注定失败的请求推进队列。

**关窗以后 Codex 仍可自动切换。** 后台按你设定的阈值换号，不依赖窗口一直开着。同一个窗口同时管理 Codex、Cursor 与 Antigravity IDE 的账号卡片、配额总览与桌面额度镜。

## 界面

顶图为 Cursor 账号页。关闭按钮将窗口收到托盘，不会退出。

<table>
  <tr>
    <td align="center"><sub><b>Codex 账号</b></sub></td>
    <td align="center"><sub><b>配额总览</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/codex-accounts.png" alt="Codex 账号" /></td>
    <td><img src="docs/images/quota-overview.png" alt="Cursor 配额总览" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Codex 自动切号</b></sub></td>
    <td align="center"><sub><b>桌面额度镜</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/auto-switch.png" alt="Codex 自动切号" /></td>
    <td><img src="docs/images/float-lens.png" alt="桌面额度镜" /></td>
  </tr>
</table>

## 安装

Windows 10 / 11（x64）。管理 Codex 需要微软商店中的官方 Codex，管理 Cursor 需要官方 Cursor，管理 Antigravity 需要官方 Antigravity IDE。可以只使用其中一部分。

1. 打开 [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases)，下载 `Quota-Switcher-Setup-<版本>-x64.exe`
2. 安装并打开
3. 在侧栏选择产品，使用「导入本机已登录」或「打开网页授权」
4. 返回窗口后即可看到账号卡片与额度

ZIP 解压后也可运行，数据仍写入用户目录。从 `1.0.x` 升级到 2.0 需要安装一次 Setup，桌面快捷方式才会改名为 Quota Switcher；之后的 `2.0.x` 可在应用内检查更新。

```powershell
Get-FileHash ".\Quota-Switcher-Setup-<版本>-x64.exe" -Algorithm SHA256
```

将结果与同一条 Release 中的 `SHA256SUMS.txt` 对照。

## 数据位置

| 位置 | 用途 |
| --- | --- |
| `%USERPROFILE%\.codex-switch` | 本应用的账号库、配置与日志 |
| `%USERPROFILE%\.codex\auth.json` | 切换 Codex 时写入；写入前备份为 `auth.json.bak` |
| `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | 切换 Cursor 时写入官方登录库 |
| `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` | 切换 Antigravity 时写入官方登录库 |

出站请求仅发往 OpenAI / ChatGPT、Cursor、Google 与 GitHub。若他人已控制这台电脑，Windows 加密无法提供额外保护。详见[隐私说明](docs/privacy.md)。

官方 Codex 登录与本应用记录不一致时，窗口提供「采用官方账号」或「写回管理账号」。

## 从源码运行

需要 Node.js 22 或更高版本（CI 使用 24 LTS）：

```powershell
git clone https://github.com/3xiaoshayu/codex-account-manager.git
cd codex-account-manager
npm ci
npm test
npm start
```

打包：`npm run build:dir` 或 `npm run build:windows`。实现说明见 [架构](docs/architecture.md)。

## 文档

[隐私](docs/privacy.md) ·
[故障排查](docs/troubleshooting.md) ·
[支持](SUPPORT.md) ·
[安全](SECURITY.md) ·
[行为约定](CODE_OF_CONDUCT.md) ·
[版本记录](CHANGELOG.md)

贡献与发布：[架构](docs/architecture.md) ·
[贡献](CONTRIBUTING.md) ·
[发布](docs/releasing.md)

## 说明

这是独立的社区项目，与 OpenAI、Anysphere / Cursor、Google 没有隶属或背书关系。OpenAI、Codex、ChatGPT、Cursor、Antigravity 是各自权利人的商标。

请只管理你拥有或已被明确授权使用的账号。当前仅支持 Windows x64。自动切号仅适用于 Codex。Antigravity 仅对接官方 IDE。安装包尚未代码签名。

代码采用 [MIT License](LICENSE)。图标与安装向导图见 [ASSET_LICENSE.md](ASSET_LICENSE.md)。

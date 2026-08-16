<div align="center">

# Codex Account Manager

多个 Codex 和 Cursor 账号，一个窗口里照看。额度、身份和切号都在本地完成。

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?include_prereleases&sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
[![CI](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/code-MIT-2f855a)](LICENSE)

[下载 0.1.0-beta.25](https://github.com/3xiaoshayu/codex-account-manager/releases/tag/v0.1.0-beta.25) ·
[故障排查](docs/troubleshooting.md) ·
[隐私说明](docs/privacy.md) ·
[English](README.en.md)

</div>

![侧栏可在 Codex 和 Cursor 之间切换](docs/images/account-dashboard.png)

> [!IMPORTANT]
> 预发布安装包尚未代码签名。Windows 可能提示“未知发布者”。请只从本仓库
> [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases) 下载，并核对 SHA-256。

## 这是什么

侧栏切换 **Codex** / **Cursor**。每个账号一张卡片，额度一眼能看完；要换号时，由它去处理登录态和官方客户端。账号和 token 只留在这台电脑上。

它不会提高额度上限。自动切号只在你保存的 Codex 账号里选一个还能用的。Cursor 可以看额度、续登录、手动切号，暂不自动换号。

## 现在能做

**Codex** — 5 小时 / 周额度，导入本机登录或打开网页授权，写入微软商店版 Codex。额度不够时，本地 Daemon 按你设的阈值换号；关掉主窗口也不会停。

**Cursor** — 套餐、Auto、API，导入本机登录或打开网页授权，写入官方 Cursor。官方当前登录会被标成当前账号。

**共用** — 关窗进托盘，桌面额度镜，令牌检查，Windows DPAPI 加密。没有遥测，也没有自建云。

切 Codex 会先结束正在运行的官方 Codex。切 Cursor 会先关掉官方 Cursor 再写登录库。换号前请等手头的任务跑完。

## 界面

<table>
  <tr>
    <td align="center"><sub><b>Codex 账号</b></sub></td>
    <td align="center"><sub><b>Cursor 配额</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/codex-accounts.png" alt="Codex 账号" /></td>
    <td><img src="docs/images/quota-overview.png" alt="Cursor 配额总览" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Codex 自动切号</b></sub></td>
    <td align="center"><sub><b>系统设置</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/auto-switch.png" alt="Codex 自动切号" /></td>
    <td><img src="docs/images/settings.png" alt="系统设置" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>登录</b></sub></td>
    <td align="center"><sub><b>桌面额度镜</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/login.png" alt="登录" /></td>
    <td><img src="docs/images/float-lens.png" alt="桌面额度镜" /></td>
  </tr>
</table>

主图是 Cursor 账号页。点叉会收到托盘。

## 安装

Windows 10 / 11（x64）。Codex 功能需要微软商店里的官方 Codex，Cursor 功能需要本机已安装官方 Cursor。可以只用其中一个。

1. 从 [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases) 下载 `Codex-Account-Manager-Setup-<版本>-x64.exe`
2. 安装并打开
3. 在侧栏选 Codex 或 Cursor，导入本机已登录的官方客户端，或打开网页授权
4. 回到应用即可看到卡片和额度

ZIP 解压也能用，数据仍写在用户目录。Beta 请手动更新。

```powershell
Get-FileHash ".\Codex-Account-Manager-Setup-<版本>-x64.exe" -Algorithm SHA256
```

和同一条 Release 里的 `SHA256SUMS.txt` 对照。

## 数据放在哪

| 位置 | 用途 |
| --- | --- |
| `%USERPROFILE%\.codex-switch` | 管理器自己的账号、配置和日志 |
| `%USERPROFILE%\.codex\auth.json` | 切 Codex 时写入，先备份为 `auth.json.bak` |
| `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | 切 Cursor 时写入官方登录库 |

网络请求只发给 OpenAI / ChatGPT、Cursor 和 GitHub。DPAPI 防不住已经控制了当前 Windows 会话的人，细节见[隐私说明](docs/privacy.md)。

官方 Codex 登录和管理器不一致时，窗口里会提示：采用官方那个号，或写回管理器选定的号。

## 从源码运行

Node.js 22 或更高（CI 使用 24 LTS）：

```powershell
git clone https://github.com/3xiaoshayu/codex-account-manager.git
cd codex-account-manager
npm ci
npm test
npm start
```

打包：`npm run build:dir` 或 `npm run build:windows`。

## 文档

[架构](docs/architecture.md) ·
[隐私](docs/privacy.md) ·
[故障排查](docs/troubleshooting.md) ·
[贡献](CONTRIBUTING.md) ·
[安全](SECURITY.md) ·
[发布](docs/releasing.md) ·
[版本记录](CHANGELOG.md) ·
[支持](SUPPORT.md)

## 说明

独立社区项目，与 OpenAI、Anysphere / Cursor 没有隶属或背书关系。OpenAI、Codex、ChatGPT、Cursor 是各自权利人的商标。

请只管理你拥有或被明确授权使用的账号。目前仅支持 Windows x64。预发布阶段，存储格式和额度解析都可能调整。

代码使用 [MIT License](LICENSE)。图标与安装向导图见 [ASSET_LICENSE.md](ASSET_LICENSE.md)。

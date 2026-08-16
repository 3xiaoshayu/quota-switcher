<div align="center">

# Codex Account Manager

多个 Codex 和 Cursor 账号，一个窗口里照看。

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?include_prereleases&sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
[![CI](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/code-MIT-2f855a)](LICENSE)

[下载安装包](https://github.com/3xiaoshayu/codex-account-manager/releases) ·
[故障排查](docs/troubleshooting.md) ·
[隐私说明](docs/privacy.md) ·
[English](README.en.md)

</div>

![Cursor 账号页，侧栏可切回 Codex](docs/images/account-dashboard.png)

> [!IMPORTANT]
> 安装包还没签名，Windows 可能提示“未知发布者”。请只从本仓库
> [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases) 下载，并核对 SHA-256。

## 这是什么

侧栏切换 **Codex** / **Cursor**。每个账号一张卡片，剩多少额度一眼能看完。要换号时，由它去改官方客户端的登录。账号只存在这台电脑上。

它不会给你加额度。自动切号只换 Codex。Cursor 可以看、可以切，但不会自动换。

## 能做什么

**Codex** — 看 5 小时和周额度。可以「导入本机已登录的 Codex」，也可以「打开网页授权」。换号会写进微软商店版 Codex。额度不够时，后台按你设的线换号；关掉窗口也不会停。

**Cursor** — 看套餐、Auto 和 API。可以「导入本机已登录的 Cursor」，或「打开网页授权」，写进官方 Cursor。本机当前登录的那个号，会标成当前账号。

**都有** — 关窗口进托盘，桌面上放额度镜，也能检查登录还剩多久。没有遥测，没有我们的云。

换号会先关掉对应的官方软件。手头的活先做完再切。

## 界面

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

顶上大图是 Cursor 账号页。点叉是收到托盘，不是退出。

## 安装

Windows 10 / 11（x64）。管 Codex 需要微软商店里的官方 Codex，管 Cursor 需要本机装着官方 Cursor。可以只用其中一个。

1. 打开 [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases)，下载 `Codex-Account-Manager-Setup-<版本>-x64.exe`
2. 安装并打开
3. 侧栏选 Codex 或 Cursor，点「导入本机已登录的 Codex」或「导入本机已登录的 Cursor」，也可以「打开网页授权」
4. 回来就能看到卡片和额度

ZIP 解压也能用，数据还是写在用户目录。Beta 请自己更新。

```powershell
Get-FileHash ".\Codex-Account-Manager-Setup-<版本>-x64.exe" -Algorithm SHA256
```

和同一条 Release 里的 `SHA256SUMS.txt` 对一下。

## 数据放在哪

| 位置 | 用途 |
| --- | --- |
| `%USERPROFILE%\.codex-switch` | 管理器自己的账号、配置和日志 |
| `%USERPROFILE%\.codex\auth.json` | 切 Codex 时写入，先备份成 `auth.json.bak` |
| `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | 切 Cursor 时写入官方登录库 |

只会访问 OpenAI / ChatGPT、Cursor 和 GitHub。别人已经能操作你这台电脑时，Windows 加密也帮不上忙，细节在[隐私说明](docs/privacy.md)。

官方 Codex 登录和管理器对不上时，窗口里是「采用官方账号」或「写回管理账号」。

## 从源码运行

Node.js 22 或更高（CI 用 24 LTS）：

```powershell
git clone https://github.com/3xiaoshayu/codex-account-manager.git
cd codex-account-manager
npm ci
npm test
npm start
```

打包：`npm run build:dir` 或 `npm run build:windows`。

## 文档

[隐私](docs/privacy.md) ·
[故障排查](docs/troubleshooting.md) ·
[支持](SUPPORT.md) ·
[安全](SECURITY.md) ·
[行为约定](CODE_OF_CONDUCT.md) ·
[版本记录](CHANGELOG.md)

给改代码的人：[架构](docs/architecture.md) ·
[贡献](CONTRIBUTING.md) ·
[发布](docs/releasing.md)

## 说明

这是独立的社区项目，和 OpenAI、Anysphere / Cursor 没有隶属或背书关系。OpenAI、Codex、ChatGPT、Cursor 是各自权利人的商标。

请只管理你自己的号，或明确被授权使用的号。现在只做 Windows x64。预发布阶段，存储格式和额度读法都可能改。

代码是 [MIT License](LICENSE)。图标和安装向导图见 [ASSET_LICENSE.md](ASSET_LICENSE.md)。

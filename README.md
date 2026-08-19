<div align="center">

# Codex Account Manager

多个 Codex、Cursor 和 Antigravity 账号，一个窗口里照看。

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
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

**1.0.0 第一正式版。** 侧栏切换 **Codex** / **Cursor** / **Antigravity**。每个账号一张卡片，剩多少额度一眼能看完。要换号时，由它去改官方客户端的登录。账号只存在这台电脑上，用 Windows 当前用户加密，不会上传。

它不会给你加额度。自动切号只换 Codex。Cursor 和 Antigravity 可以看、可以切，但不会自动换。

Antigravity 第一期只接官方 **Antigravity IDE**：导入本机、网页授权、切号、刷额度、浮窗。不管旧版 `Antigravity.exe`，也不多开实例。Google 第三方登录有风控讨论，额度没查清时不会写成「已封号」。

## 能做什么

**Codex** — 看 5 小时和周额度。可以「导入本机已登录的 Codex」，也可以「打开网页授权」。换号会写进微软商店版 Codex。额度不够时，后台按你设的线换号；关掉窗口也不会停。

**Cursor** — 看套餐、Auto 和 API。可以「导入本机已登录的 Cursor」，或「打开网页授权」，写进官方 Cursor。本机当前登录的那个号，会标成当前账号。

**Antigravity** — 看套餐/积分和主要模型剩余。可以「导入本机已登录的 Antigravity」，或走 Google 网页授权，写进官方 Antigravity IDE。

**都有** — 关窗口进托盘，桌面上放额度镜，也能检查登录还剩多久。没有遥测，没有我们的云。

换号会先关掉对应的官方软件。手头的活先做完再切。

## 为什么值得用

社区里常被提到的参考是 [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools)。那是 Tauri + Rust 做的，做得认真。我们不是要取代它，而是把 **Windows 本机保险柜、切号事务、三家账号** 做扎实。

| 点 | Codex Account Manager |
| --- | --- |
| Codex 切号 | 先快照官方登录、管理器投影和账号索引；后面任一步失败就整段回滚，不是先写完 `auth.json` 再想办法补救 |
| Windows 凭证 | 当前用户 DPAPI（Electron `safeStorage`），换 Windows 用户或换电脑一般解不开 |
| 官方登录冲突 | 窗口里「采用官方账号」或「写回管理账号」，不偷偷覆盖 |
| 批量刷新 | 跳过已经要重登或已封号的号，不把注定失败的请求推进队列 |
| 联网 | Node 直连，按代理签名 keep-alive；额度请求不走 Chromium 会话，主窗口不容易卡成「未响应」 |
| 列表 | 界面只拿元数据，token 不解到渲染进程 |
| 额度 | 三家都按 5 路并发刷新；窗口和浮窗用快照 + 补丁，不整页重拉 |
| Cursor / Antigravity | 原地改官方 `state.vscdb`（WAL + `BEGIN IMMEDIATE`），大库不再整文件拷来拷去 |
| 产品范围 | 一个窗口管 Codex、Cursor、Antigravity IDE；Codex 可关窗后台自动切号 |

对方仍更合适的地方，我们也不藏：

- Rust / Tauri 运行时更轻，安装包也更小
- WSL、定时唤醒、多开官方客户端：我们有意不做
- 本仓库安装包还没签名，Windows 可能拦一下；请对 SHA-256

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

Windows 10 / 11（x64）。管 Codex 需要微软商店里的官方 Codex，管 Cursor 需要本机装着官方 Cursor，管 Antigravity 需要本机装着官方 Antigravity IDE。可以只用其中几个。

1. 打开 [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases)，下载 `Codex-Account-Manager-Setup-<版本>-x64.exe`
2. 安装并打开
3. 侧栏选 Codex、Cursor 或 Antigravity，点对应的「导入本机已登录」，也可以「打开网页授权」
4. 回来就能看到卡片和额度

ZIP 解压也能用，数据还是写在用户目录。从 `0.1.0-beta.*` 升到 1.0.0 需要手动装一次；装好正式版之后，后续 `1.0.x` 可以在应用里检查更新。

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
| `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` | 切 Antigravity 时写入官方登录库 |

只会访问 OpenAI / ChatGPT、Cursor、Google 和 GitHub。别人已经能操作你这台电脑时，Windows 加密也帮不上忙，细节在[隐私说明](docs/privacy.md)。

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

这是独立的社区项目，和 OpenAI、Anysphere / Cursor、Google 没有隶属或背书关系。OpenAI、Codex、ChatGPT、Cursor、Antigravity 是各自权利人的商标。

请只管理你自己的号，或明确被授权使用的号。现在只做 Windows x64。自动切号只换 Codex。Antigravity 只接官方 IDE。安装包尚未代码签名。

代码是 [MIT License](LICENSE)。图标和安装向导图见 [ASSET_LICENSE.md](ASSET_LICENSE.md)。

<div align="center">

# Codex Account Manager

多个 Codex 和 Cursor 账号，一个窗口里照看。额度、身份和切号都在本地完成。

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?include_prereleases&sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
[![CI](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/code-MIT-2f855a)](LICENSE)

[下载安装包](https://github.com/3xiaoshayu/codex-account-manager/releases) ·
[故障排查](docs/troubleshooting.md) ·
[隐私说明](docs/privacy.md) ·
[English](README.en.md)

</div>

![Codex Account Manager 账号管理界面](docs/images/account-dashboard.png)

> [!IMPORTANT]
> 当前是预发布版本，安装包尚未代码签名。Windows 可能提示“未知发布者”。请只从本仓库
> [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases) 下载，并核对 SHA-256。

## 这是什么

Codex 和 Cursor 都多号之后，看剩余额度和换身份会变成一件琐事。这个应用把两个
产品收进同一个 Windows 窗口：侧栏切换 Codex / Cursor，每个账号一张卡片，额度
一眼能看完；要换号时，由它去处理登录态和官方客户端。

它不会改任何账号的额度上限。自动切号只在你保存的 **Codex** 账号里选一个还能用
的。Cursor 可以看额度、续登录、手动切号，暂不参与自动切号。

## 能做什么

- **两个产品** — 侧栏在 Codex 和 Cursor 之间切换。账号、配额和桌面额度镜跟着当前产品走。
- **账号卡片** — Codex 显示 5 小时 / 周额度；Cursor 显示套餐、Auto 和 API。可以搜索、筛选，也可以添加、刷新、切换、重新授权或删除。顶栏显示当前邮箱，点击即可复制。
- **配额总览** — 所有账号的用量放在一页。读不到额度时显示为未知或「暂无此项」，不会写成 0。
- **自动切号** — 本地 Daemon 按你设的阈值换到下一个可用 Codex 账号。关掉主窗口也不会停。Cursor 暂不参与。
- **关窗进托盘** — 点叉是收到托盘。左键托盘图标可再打开窗口；要退出，用托盘菜单里的「退出」。
- **桌面额度镜** — 桌面上的小环表。Codex 是 5 小时套周额度，Cursor 是 Auto 和 API 一对圆。可以翻页预览、置顶、刷新，也可以从这里切号。
- **只留在本机** — 账号和 token 存在这台电脑上，token 用 Windows DPAPI 加密。没有遥测，也没有自建云。

切 Codex 会先结束正在运行的官方 Codex 再拉起来。切 Cursor 会先关掉官方 Cursor
再写登录库。换号前请等手头的任务跑完。

## 界面

<table>
  <tr>
    <td align="center"><sub><b>配额总览</b></sub></td>
    <td align="center"><sub><b>自动切号</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/quota-overview.png" alt="配额总览" /></td>
    <td><img src="docs/images/auto-switch.png" alt="自动切号" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>系统设置</b></sub></td>
    <td align="center"><sub><b>登录</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/settings.png" alt="系统设置" /></td>
    <td><img src="docs/images/login.png" alt="登录" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>桌面额度镜</b></sub></td>
    <td align="center"><sub><b>托盘菜单</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/float-lens.png" alt="桌面额度镜" /></td>
    <td><img src="docs/images/tray-menu.png" alt="托盘菜单" /></td>
  </tr>
</table>

截图里的邮箱已做遮盖，避免把真实账号写进仓库。

## 安装

需要 Windows 10 / 11（x64）。Codex 功能需要微软商店里的官方 Codex；Cursor 功能
需要本机已安装官方 Cursor。可以只用其中一个产品。

1. 从 [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases) 下载 `Codex-Account-Manager-Setup-<版本>-x64.exe`
2. 安装并打开
3. 在侧栏选 Codex 或 Cursor，添加账号或导入本机已登录的官方客户端
4. 回到应用即可看到卡片和额度

ZIP 解压也能用，数据仍写在用户目录里，一般更推荐安装包。Beta 阶段请手动更新。

校验安装包时，用 Release 附带的 `SHA256SUMS.txt`：

```powershell
Get-FileHash ".\Codex-Account-Manager-Setup-<版本>-x64.exe" -Algorithm SHA256
```

## 数据放在哪

- 应用数据：`%USERPROFILE%\.codex-switch`
- Codex 切号写入：`%USERPROFILE%\.codex\auth.json`（先备份为 `auth.json.bak`）
- Cursor 切号写入：`%APPDATA%\Cursor\User\globalStorage\state.vscdb`
- 网络请求发给 OpenAI / ChatGPT（Codex 登录、刷新、读额度）、Cursor（登录、刷新、读用量）和 GitHub（检查更新）

DPAPI 防不住已经控制了当前 Windows 会话的人。更完整的说明见[隐私说明](docs/privacy.md)。

如果官方 Codex 登录的号和管理器当前号不一致，窗口里会出一条提示，可以选用官方那个号，或写回管理器选定的号。官方 Cursor 登录会被标成当前 Cursor 账号。

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

这是独立的社区项目，与 OpenAI、Anysphere / Cursor 没有隶属或背书关系。OpenAI、
Codex、ChatGPT、Cursor 是各自权利人的商标。

请只管理你拥有或被明确授权使用的账号。生产环境的 API 负载请走官方 Platform API。

目前仅支持 Windows x64。预发布阶段，存储格式和额度解析都可能调整。

代码使用 [MIT License](LICENSE)。图标与安装向导图见 [ASSET_LICENSE.md](ASSET_LICENSE.md)。

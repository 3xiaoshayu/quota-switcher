<div align="center">

# Codex Account Manager

Windows 上的 Codex 多账号管理器：额度一目了然，切号一键完成，关窗进托盘，桌面还能放一块额度镜。数据全部留在本机。

[![Release](https://img.shields.io/github/v/release/3xiaoshayu/codex-account-manager?include_prereleases&sort=semver&label=release)](https://github.com/3xiaoshayu/codex-account-manager/releases)
[![CI](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/3xiaoshayu/codex-account-manager/actions/workflows/ci.yml)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/code-MIT-2f855a)](LICENSE)

[下载](https://github.com/3xiaoshayu/codex-account-manager/releases) ·
[故障排查](docs/troubleshooting.md) ·
[隐私说明](docs/privacy.md) ·
[English](README.en.md)

</div>

![Codex Account Manager 账号卡片界面，使用虚构演示账号](docs/images/account-dashboard.png)

> [!IMPORTANT]
> 目前是预发布版本，安装包还没有做代码签名，Windows SmartScreen 可能提示
> "未知发布者"。请只从本仓库的 Releases 页面下载，并核对 SHA-256。

## 这是什么

手上有几个 Codex 账号的人大概都熟悉这套流程：想知道哪个号还有额度，得挨个登录看；
要换号，得手动改登录文件，改完还得重启 Codex。号一多，这些琐事就很磨人。

这个工具把这些事收拾干净了。它不会、也不能改任何账号的额度；自动切号只是在你自己
保存的账号之间做选择。

## 功能说明

**账号管理。** 每个账号一张卡片，上面直接摆着 5 小时额度、周额度、重置时间和 Token
还剩多久。可以按邮箱或套餐搜索，也可以筛「全部 / 当前 / 需要操作」。点「添加账号」
会走浏览器 OAuth；卡片上可以刷新额度、一键切到这个号、重新授权，或删掉不用的号。
切号时会先关掉正在跑的 Codex，备份并替换 `auth.json`，再拉起官方客户端。

**配额总览。** 所有账号的剩余情况摊在一页里。额度条按剩余大致分色：大约 55% 以上为
绿，25% 以上为黄，再低为红。读不到额度时界面会写成「未知」，不会拿 0 来充数。

**自动切号。** 本地守护进程按你设的 5 小时 / 周额度阈值，换到下一个还能用的号。范围
可以是全部账号，也可以只勾一部分。「立即检查」在全局开关关掉时只检查、不换号。
关掉主窗口不会停掉守护进程。

**关窗进托盘。** 点标题栏的叉是藏到托盘，不是退出。左键托盘图标或右键「打开窗口」
可以再打开主窗口。真正退出只能用托盘右键里的「退出」。

**桌面额度镜。** 桌面上一块独立的小仪表：竖着两圈环，中间数字是更紧的那档额度。
可以左右翻页看别的号（预览时圆环是虚线），可以钉在最前、手动刷新，也可以直接
「切到此账号」。入口在托盘「打开桌面额度」，以及设置页的「桌面额度」。

**系统设置。** 开关守护进程、改检查间隔、重新检测微软商店版 Codex、批量检查令牌
还能否用、打开桌面额度、查看更新通道。Beta 阶段更新是手动的，「打开发布页」会跳到
GitHub Releases。

**登录与加密。** 进入后从本机账号库读取数据。OAuth token 用 Windows DPAPI 加密，
只有当前这个 Windows 用户能解开。没有遥测，没有广告，也没有自建云服务。

**安装向导。** 安装包的侧栏和页眉用的是本软件自己的图，不是 NSIS 默认皮肤。

**和官方登录冲突。** 如果官方 Codex 当前登录的号，和管理器里选定的号不是同一个，
主窗口会出一条横幅。可以选择采用官方那个号，或把管理器选定的号写回去。切换前请先
把手头的 Codex 任务跑完。

## 界面一览

<table>
  <tr>
    <td align="center"><sub><b>配额总览</b></sub></td>
    <td align="center"><sub><b>自动切号</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/quota-overview.png" alt="配额总览界面，展示全部账号的额度概况" /></td>
    <td><img src="docs/images/auto-switch.png" alt="自动切号界面，展示阈值与生效范围配置" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>系统设置</b></sub></td>
    <td align="center"><sub><b>登录界面</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/settings.png" alt="系统设置界面，展示守护进程、桌面额度和更新通道" /></td>
    <td><img src="docs/images/login.png" alt="登录界面，展示 DPAPI 本地加密说明" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>桌面额度镜</b></sub></td>
    <td align="center"><sub><b>托盘菜单</b></sub></td>
  </tr>
  <tr>
    <td><img src="docs/images/float-lens.png" alt="桌面额度镜，左侧当前账号，右侧预览其他账号" /></td>
    <td><img src="docs/images/tray-menu.png" alt="系统托盘右键菜单：打开窗口、打开桌面额度、退出" /></td>
  </tr>
</table>

截图均为虚构演示数据。

## 安装

需要 Windows 10 / 11（x64），以及 Microsoft Store 里的官方 Codex 应用。

1. 打开 [Releases](https://github.com/3xiaoshayu/codex-account-manager/releases)，下载最新的 `Codex-Account-Manager-Setup-<版本>-x64.exe`
2. 安装并启动
3. 点「添加账号」，浏览器里完成 OAuth 登录
4. 回到应用，账号卡片和额度就出来了

ZIP 包解压即用，但数据仍然存在用户目录里，并不是真正的便携版，一般用安装包就好。
Beta 阶段需要手动更新，正式版会支持后台自动更新。

### 校验安装包

每个 Release 都附带 `SHA256SUMS.txt`。PowerShell 里跑：

```powershell
Get-FileHash ".\Codex-Account-Manager-Setup-<版本>-x64.exe" -Algorithm SHA256
```

输出和 `SHA256SUMS.txt` 里对应的那行一致就没问题。

## 数据放在哪，隐私怎么处理

- 管理器自己的数据在 `%USERPROFILE%\.codex-switch`
- OAuth token 用 Windows DPAPI 加密，只有当前这个 Windows 用户能解开
- 切号时写入 `%USERPROFILE%\.codex\auth.json`，写之前先备份一份 `auth.json.bak`
- 没有遥测，没有广告，没有任何自建云服务——账号列表和 token 不会离开你的电脑
- 网络请求只发给 OpenAI / ChatGPT（OAuth 登录、刷新 token、读额度）和 GitHub（检查更新）

要提醒的是，DPAPI 防不住已经控制了你 Windows 会话的恶意软件或管理员。完整的数据
清单、网络行为和卸载说明见[隐私说明](docs/privacy.md)。

> [!WARNING]
> 切换账号会先关掉正在运行的 Codex 进程再重启。切换前记得等手头的任务跑完。

## 工作原理

流程不复杂：OAuth 登录后，账号元数据和加密后的 token 落在本地；读额度用的是各账号
自己的凭证；切号时先备份、再原子替换 Codex 的 `auth.json`，然后拉起官方客户端；
自动切号守护进程在本地按你设的阈值走同一条切换路径。主窗口收到托盘后，守护进程
和桌面额度镜都还可以继续用。

额度数据来自 ChatGPT 的后端接口，上游说改就改。读不到的时候界面会明确显示错误，
不会把「没数据」伪装成「零额度」。

模块边界和数据流的细节见[架构说明](docs/architecture.md)。

## 从源码跑

需要 Node.js 22 或更高（CI 和发布构建用 24 LTS）：

```powershell
git clone https://github.com/3xiaoshayu/codex-account-manager.git
cd codex-account-manager
npm ci
npm test
npm start
```

打包用 `npm run build:dir`（免安装目录）或 `npm run build:windows`（NSIS 安装包 + ZIP）。

electron-builder 的辅助包下载超时的话，先设个镜像再跑：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run build:windows
```

## 更多文档

[架构说明](docs/architecture.md) ·
[隐私说明](docs/privacy.md) ·
[故障排查](docs/troubleshooting.md) ·
[贡献指南](CONTRIBUTING.md) ·
[安全策略](SECURITY.md) ·
[发布流程](docs/releasing.md) ·
[版本记录](CHANGELOG.md) ·
[支持渠道](SUPPORT.md)

## 几句要紧的话

这是个独立的社区项目，和 OpenAI 没有任何隶属、授权或背书关系。OpenAI、Codex、
ChatGPT 是各自权利人的商标。

请只管理你自己的、或明确授权给你的账号，并遵守相应的服务条款和组织政策。生产或
商业 API 负载请走 OpenAI Platform API，别指望靠切号解决。

目前只支持 Windows x64 和 Microsoft Store 官方 Codex。预发布阶段，本地存储格式、
接口解析和自动切号策略都可能调整。提交 issue 前建议先翻一下[故障排查](docs/troubleshooting.md)。

## 许可证

代码用 [MIT License](LICENSE)。应用图标和安装向导图见
[ASSET_LICENSE.md](ASSET_LICENSE.md)；第三方组件许可见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

截图里的邮箱、额度、日期都是编出来的演示数据。

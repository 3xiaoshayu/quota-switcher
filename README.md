# Codex Account Manager

面向 Windows 的本地 Codex 多账号管理工具，提供账号切换、配额查看、Token 刷新、自动切号和重置额度管理。

> 本项目是独立的社区工具，与 OpenAI 没有隶属、授权或背书关系。Codex 和 OpenAI 是其各自权利人的商标。

## 系统要求

- Windows 10/11 x64
- 已安装官方 Microsoft Store 版 Codex
- 首次添加账号时可访问 OpenAI OAuth 与 ChatGPT 官方接口

## 安装

正式公开后，从 GitHub Releases 下载 `Codex Account Manager-Setup-<version>-x64.exe`。测试阶段仓库为私有仓库，安装包仅提供给受邀测试者。

首版暂未进行 Windows 代码签名，Windows SmartScreen 可能显示“未知发布者”。请只从本仓库 Release 下载，并使用随 Release 提供的 `SHA256SUMS.txt` 校验文件。

Beta 版本使用手动更新。项目公开并发布 stable 版本后，应用会自动下载更新并提示重启安装。

## 数据与隐私

- 账号索引和配置保存在 `%USERPROFILE%\.codex-switch`。
- OAuth Token 使用 Windows DPAPI 加密，只能由同一 Windows 登录用户解密。
- 当前 Codex 登录状态写入 `%USERPROFILE%\.codex\auth.json`；切号前会保留 `auth.json.bak`。
- 数据不会上传到项目自建服务器。OAuth 登录、Token 刷新、配额查询和版本检查会访问对应官方服务。
- 切换账号时会关闭正在运行的 `Codex.exe` 和 `node_repl.exe`，写入新认证状态后重新启动 Codex。

## 本地开发

```powershell
npm ci
npm run audit:ui
npm start
```

构建未安装目录：

```powershell
npm run build:dir
```

生成 Release 安装包：

```powershell
npm run build:windows
```

当前 `resources/icon.ico` 是临时应用图标，正式发布前可以直接替换为品牌图标。

如果本地构建在下载 electron-builder 辅助包时超时，可临时使用镜像后重试：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run build:windows
```

## 许可证

源码使用 [MIT License](LICENSE)。富士山背景图片采用单独许可，见 [ASSET_LICENSE.md](ASSET_LICENSE.md)。

English documentation: [README.en.md](README.en.md)

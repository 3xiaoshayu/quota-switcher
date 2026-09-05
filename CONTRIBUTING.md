# 参与贡献

[English](CONTRIBUTING.en.md)

功能已定稿。欢迎严重缺陷、文档和翻译。大改界面或再加一家产品，请先开 Issue，不要直接开 PR。

请保持本机优先，也别把登录数据弄乱。

## 开 PR 之前

- 先搜过 Issue 和 PR
- 改动收窄，说清改善了哪一步
- 存储格式、登录、切号、新的联网地址、新的产品页、大改界面，先开 Issue
- 不要附 token、回调地址、账号文件或原始日志

安全问题走
[私下报告](https://github.com/3xiaoshayu/quota-switcher/security/advisories/new)，
不要开公开 Issue。

## 本地怎么跑

需要：

- Windows 10 或 11 x64
- Node.js 22 或更高
- 测 Codex 时，本机有微软商店官方 Codex
- 测 Cursor 时，本机有官方 Cursor

```powershell
git clone https://github.com/3xiaoshayu/quota-switcher.git
cd quota-switcher
npm ci
npm test
npm start
```

`npm test` 会跑引擎行为、TypeScript、语法、界面契约、文档链接和发布元数据。`npm run test:e2e` 会真的把程序起起来（用一次性数据目录，不碰你本机的账号和官方登录库），通过 DevTools 协议点一遍侧栏、三个页面和弹窗。

## 约定

- 顺着现有的 CommonJS 和普通 JavaScript 写
- 渲染进程不要直接碰 Node 和本机文件
- 新操作要同时改界面、preload 和主进程，三者对上
- 改登录数据用结构化接口，不要拿字符串去补
- 写文件保持原子替换和备份
- 日志里不要出现 token、授权头、回调或完整账号
- 测试夹具不要带 token；公开截图可以带邮箱
- 读不到的额度写成未知，不要写成 0
- Codex 和 Cursor 的存储、登录、切号分开，不要互相扫
- Cursor 不要用 Codex 的封号状态。切号只能由用户手动触发，不要给任何产品加后台自动换号
- 少加依赖，加上就要说为什么

## 提交前

```powershell
npm test
npm run test:e2e
npm run build:dir
```

改了界面，再看一眼：

- 宽窗口和窄窗口
- 焦点、悬停、按下、禁用、忙碌、成功、失败
- 当前号、要处理的号、登录失效、额度未知
- 侧栏的 Codex 和 Cursor
- 没有横着溢出，按钮没被裁掉

真切号、真删号，只用专门的测试账号。

## Pull request

写上：

- 用户能看见什么变化
- 为什么要改
- 跑过哪些命令、点过哪些地方
- 看得见的界面变化附截图
- 动了本机数据时，怎么迁、怎么退

提交即同意按本项目的 MIT 许可分发。没有再分发权利的代码和素材，请不要送来。

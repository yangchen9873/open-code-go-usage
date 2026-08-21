# OpenCode Go Usage

在浏览器工具栏一键查看 **OpenCode Go** 的 Token 用量与重置时间。支持自动刷新，并随系统主题切换浅色 / 深色外观。

## 功能

| 功能 | 说明 |
| --- | --- |
| 用量一览 | 滚动 / 每周 / 每月用量百分比与重置倒计时 |
| 用量预警 | 用量 ≥ 60% 标黄、≥ 80% 标红，提前提醒 |
| 手动刷新 | 点击刷新按钮即时获取最新用量 |
| 智能识别 | 从当前页面自动识别工作区，并一键跳回用量页 |

## 安装

1. 打开浏览器扩展管理页：Chrome 为 `chrome://extensions`，Edge 为 `edge://extensions`。
2. 开启“开发人员模式”。
3. 选择“加载解压缩的扩展”，并选择本项目目录。
4. 登录 OpenCode，打开对应工作区用量页后再打开扩展。

## 工作原理

扩展从当前 OpenCode 页面 URL 读取工作区 ID，并使用浏览器中 `opencode.ai` 域的 `auth` Cookie 发起请求；不会将 Cookie 写入扩展存储。扩展采用 provider 注册表结构，已内置 OpenCode Go，后续可扩展更多服务而无需重做弹窗界面。

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `manifest.json` | 扩展清单（权限与图标） |
| `popup.html` | 弹窗结构 |
| `popup.js` | 弹窗逻辑与 provider 注册表 |
| `popup.css` | 样式（含深色模式） |
| `assets/` | 应用图标 |

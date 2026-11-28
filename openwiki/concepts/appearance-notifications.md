---
type: 核心概念
title: 桌面外观与通知
description: 工作台主题、语言和运行结束提示音的设置及桌面偏好存储边界。
tags: [appearance, theme, notifications, desktop, preferences]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-27T05:51:26.216Z
sources:
  - id: openwiki-source-389c64e26f7d18c52f5bcff9
    resource: repo://desktop/host/trusted-ipc.mts
  - id: openwiki-source-a4c768bab613f4e1e1dd049a
    resource: repo://desktop/host/ui-language-ipc.mts
  - id: openwiki-source-74c79a124eb087d15ef3c31e
    resource: repo://desktop/host/ui-notifications-ipc.mts
  - id: openwiki-source-ea99e5335bfa8489ff5beead
    resource: repo://desktop/host/ui-notifications.mts
  - id: openwiki-source-f5d649c5294c67489d37bb34
    resource: repo://desktop/host/ui-theme-ipc.mts
  - id: openwiki-source-b867167e6593a6d98e193edf
    resource: repo://frontend/src/notifications/index.ts
  - id: openwiki-source-d776d395c95aae26374aad20
    resource: repo://shared/desktop-ui-notifications.ts
  - id: openwiki-source-e7254b3684bea7aed40583a0
    resource: repo://shared/desktop-ui-theme.ts
generated: { by: "claude-code", at: "2026-11-27T05:51:26.216Z" }
---

# 桌面外观与通知

工作台提供外观、语言和通知偏好。主题枚举包括 `obsidian`、`classic`、`parchment`、`nordic`、`rose` 和 `midnight`，默认 `obsidian`；共享 schema 校验主题，桌面窗口背景与前端主题对应。界面启动时先同步应用本地备份，再异步获取持久偏好，减少启动时视觉跳变。

## 提示音和窗口

通知设置可选择 codex、chime、marimba、bubble 或 ping 提示音，分别控制完成音、失败音、完成时聚焦窗口及音量。音量范围是 0–100。完成与失败、意外中断使用不同的提示逻辑，设置页可试听。具体播放受浏览器音频能力及用户设置影响。

桌面主进程将通知偏好保存在 profile 的 `ui-notifications.json`：先写临时文件，再重命名替换；读失败使用默认值。preload 只提供偏好读取、保存和聚焦窗口等窄接口，renderer 维护本地备份；不要把 renderer 中的备份误认为唯一写者。语言、主题和通知各有自己的桌面偏好与校验契约；它们共用 `bindTrustedPreferenceIpc`，由宿主校验调用来自当前受信任窗口，并在解绑时移除对应处理器。相关测试为 `tests/ui-notifications.test.ts`、`tests/ui-theme.test.ts` 与桌面 IPC 测试。

工作区布局与位置另有独立持久化，见[工作台导航](./workspace-navigation.md)和[数据持久化](../architecture/database-storage.md)。

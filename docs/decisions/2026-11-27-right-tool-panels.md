# 右侧工具沿用终端的分栏行为

## 问题与范围

终端页首的分栏图标与 Git、浏览器的 × 执行的不是同一种操作；三个工具的顶部入口也会关闭实例或退出面板路由。Git 和终端可以占满工作区，浏览器却按另外的窗口阈值移到会话正文。Git、终端和浏览器还分别使用本地尺寸或布局偏好，浏览器分隔条会使用较窄的范围。

## 依据与取舍

- 查阅 [React Activity](https://react.dev/reference/react/Activity)：隐藏会保留 DOM 与组件状态，清理效果并于显示时重连。终端已有这条隐藏路径，可扩展到全部面板，不用缓存额外的 Git/网页状态。
- 对照 [microsoft/vscode `main`，workbench/browser/layout.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/layout.ts) 的 `setPanelHidden`、`toggleMaximizedPanel`：布局统一拥有显隐与最大化，恢复时取上次停靠尺寸；视图容器不负责决定尺寸。采用共同布局控制，保留 atelier 的会话路由与现有业务行为，不引入 VS Code 容器或依赖。
- 核对锁定的 Electron `45.4.1` 类型和 [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)：原生网页由 main 持有，由 renderer 提供槽位坐标。停靠和全屏保持同一个槽位 DOM，共用已有 ResizeObserver；收起时使用现有 `layout(null)`，不新开窗口、不销毁网页、不动授权及进程边界。

## 规则

1. Git、浏览器、终端标题栏统一使用「工作区全屏／恢复停靠」和「收起」图标。收起不退路由、不重建面板，顶部同一入口或「切换右侧面板」快捷键恢复；关闭单个文件、网页或终端标签仍是独立的业务操作。Git 忙时继续阻止收起和切换工具。
2. 三个工具使用终端原有的 1120 px 停靠阈值。更窄时打开后自动占满工作区，窗口变宽后恢复之前的布局选择。手动全屏不改变 OS 窗口状态；收起和恢复不改上次停靠宽度。
3. 由工作区提供同一个分隔条和右栏宽度偏好：终端原有的 450–1440 px 范围，并按可用空间保护至少 420 px 的会话区。窗口临时变窄不持久化缩窄后的宽度。保留原布局偏好的存储键和结构，读取旧的 240–449 px 右栏宽度时按 450 px 显示；不迁移数据库，也不自动回写。全新布局沿用终端的 640 px 默认宽度。

## 验证和回退

用 Chromium 回归验证快捷入口、键盘分隔条、宽度极限、窄窗、焦点与原生桥请求；再以隔离项目、数据根和 Electron profile 验证三面板、实际拖拽、真实 shell 与 WebContentsView 槽位/标签保留。执行常规检查、测试和构建。回退撤销本次布局与界面代码；如果使用新版设置了大于 760 px 的右栏宽度，降级前可先在设置中保存兼容尺寸（450–760 px），否则旧版会忽略该布局偏好并使用默认值。业务数据不受影响。

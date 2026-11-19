# P4 原生浏览器的控制与提供方

状态为提案。以 [桌面整体设计](../../openspec/roadmaps/build-atelier-desktop/design.md#决策-3--控制权网页状态与审批有单一归属) 为准。

当前浏览器操作、工作台窗口和 IPC 装配共用桌面入口。每个项目只有一个网页视图，工具适配层通过 Playwright CLI 路径和工具名前缀决定原生路由。这个识别规则增加了修改工具配置和切换 Web 入口时的耦合。

参考 [Proma BrowserController](https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/browser-controller.ts) 对可见标签和 Agent 标签的分别管理、取消控制与视图销毁，以及 [pi-desktop browser contract](https://github.com/DLYZZT/pi-desktop/blob/ec7ecc14005f8a47ab214a7bc901a77549f404a7/src/contract/browser.ts) 的状态与错误类型。Electron 原生网页继续使用 [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) 和项目隔离的持久会话。

选择由宿主装配的原生浏览器控制器。控制器管理项目标签、控制代次和文档引用，运行时继续决定每次工具调用的权限。IPC 只传校验过的项目、目标、运行、请求及操作数据。普通桌面导航在可见标签操作，自动化沿用其明确的工作标签。接管时冻结观察和写入，交还后重新感知。取消后，已经派发而没有确认的操作在轨迹里保留结果待确认状态。

桌面浏览器与普通 MCP 通过显式能力选择。现有 Playwright 配置可在读取或迁入时按具体配置标识映射一次，执行阶段依据显式提供方。Web 路径继续经过既有 Playwright 适配器。目标提供方离线时显示可恢复错误。

验收用本机网页和隔离 profile 覆盖多标签、跨项目隔离、导航、较慢页面、接管与重新观察、截图保存。故障注入观察超时和迟到回复。回退沿用 P3 的数据副本并关闭新版宿主。

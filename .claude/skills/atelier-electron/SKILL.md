---
name: atelier-electron
description: 在 atelier 设计、实现或评审 Electron 桌面功能时使用。覆盖主进程和子进程生命周期、preload/contextBridge、IPC、WebContentsView 原生网页、BrowserSlot 布局、人工登录接管、项目分区、原生文件选择与交付物导出，以及桌面打包、迁移、恢复和真机验收。
---

# atelier Electron 开发

读取仓库根 `CLAUDE.md`、当前路线图阶段和 `package.json` 中锁定的 Electron 版本。用本地 `node_modules/electron/electron.d.ts` 核实依赖的 API，再打开相关官方页。用户要确认方案时，先交付架构取舍、数据影响与可测试结果。

## 1. 给改动指定负责人

列出发起操作的一方、最终裁决的一方、持有状态的一方和释放资源的时刻。窗口、系统原生对话框、网页实例由 main 管。可信 renderer 展示状态。preload 提供逐操作的窄接口。运行时保管项目记录、模型连接、审批和不可变成果。隔离工具、数据库、解码和长耗时工作留在适合的子进程。输入和输出先写成可检查的契约，明确取消和超时后由谁收尾。

## 2. 审查 IPC 与外部网页

- 对每个特权调用检查 sender、主 frame、可信 origin、请求结构、项目归属、目标标签和调用时的授权。订阅在组件卸载时移除。由 main 在成功后发布可信状态。
- 外部网站使用自己的 `WebContentsView` 和所属项目的 session partition。使用 sandbox、context isolation、web security 和 Chromium 的证书验证；Node 和应用的 preload 接口只在其所属边界内可用。校验导航、重定向、弹窗、权限请求、下载和文件选择的独立入口。
- 人工控制时输入直接进入网站，暂停 Agent 的全部页面读写及截图。在途动作先收尾，交还时使旧的元素引用与队列失效；下一条指令重新观察。用户登录后的网页内容一旦进入模型上下文，就适用该项目的数据使用策略。

## 3. 做出真实可操作的桌面交互

`WebContentsView` 有原生层级。选定标签、renderer 布局、窗口缩放、弹窗显示、窗口隐藏及销毁都要同步到正确的视图。区分移除视图和释放 `webContents`。销毁路径应能重复调用，并清理 listener、debugger、定时器和子进程。打开原生文件对话框后，使用用户挑选的文件或目标路径，并在运行时重新校验访问范围。导出和覆盖需要处理取消、磁盘不足和目标已变化。

## 4. 以发布工件检验运行时

按当前阶段分别定位应用资源、可写数据根、缓存、浏览器分区和运行日志。核实 `process.resourcesPath`、ASAR 外的二进制及 worker、Node/SQLite/SDK 版本配套。用本机用户配置注入凭据，显式列出子进程需要的环境。使用临时目录演练迁移和回退，保留升级后的新数据副本。对实际交付的平台分别记录结果。

## 5. 验证并交付

按改动选择证据：类型与单测检查契约；本地 HTTP/SDK 替身检查授权、取消与错误；Electron 窗口检查网页实例、真实点击、输入、中文 IME、焦点、缩放与遮挡；安装包检查从冷启动到退出及再次打开。写明工件、环境、步骤和可观察结果。完整命令以仓库脚本为准，构建通过与实测通过分别记录。

三个自检场景：用户接管网页登录后，Agent 能继续读同一页且轨迹里没有人工输入；取消「另存为」后，目标目录和成果记录符合预期；全新 Linux 环境没有开发工具时，安装包仍能启动运行时并打开历史。

## 一手参考

- [Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc) 和 [安全建议](https://www.electronjs.org/docs/latest/tutorial/security)
- [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)、[视图资源释放](https://www.electronjs.org/docs/latest/api/base-window#resource-management) 和 [session 分区](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options)
- [Electron Forge 打包与发行](https://www.electronforge.io/)

本 Skill 是 atelier 的项目规则。官方文档链接面向最新 API，实施时核对锁定版本。

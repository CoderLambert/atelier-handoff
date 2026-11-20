# atelier 桌面开发任务看板

实施取舍见 [整体设计](design.md)，命令、工件、结果和回退记录见 [执行日志](task-log.md)。完整路线见 [路线图](roadmap.md)。

## 本轮交付 · 已完成

本轮范围为 Linux 功能与本地安装态验收、Windows x64 和 macOS arm64 各一轮候选构建。后续功能开发优先 Linux。

| 阶段 | 交付目标 | 状态 | 验收记录 |
|---|---|---|---|
| P1 | Linux x64 安装样包 | 已验证 | [Arch 与便携包验收](../../../docs/evidence/desktop-p1-linux-x64/acceptance.json) |
| P2 | 宿主、运行时监督与恢复 | 已验证 | [安装态进程清理](../../../docs/evidence/desktop-p2-linux-x64/installed.json) 和 [故障恢复](../../../docs/evidence/desktop-p2-linux-x64/recovery.json) |
| P3 | 旧数据迁入与备份恢复 | 已验证 | P1 数据、迁入向导回调和回退副本。[最终验证记录](../../../docs/evidence/desktop-p7-linux-x64/workflows.json) |
| P4 | 原生浏览器与人工接管 | 已验证 | [标签与接管](../../../docs/evidence/desktop-p4-linux-x64/tabs.json) · [内置工具与安装态审批点击](../../../docs/evidence/desktop-p7-linux-x64/native-browser.json) |
| P5 | 运行时工具与 Agent 桌面流程 | 已验证 | [聊天审批、流式回复与上下文续接](../../../docs/evidence/desktop-p5-linux-x64/agent.json)，取消和截图见 P2/P4 |
| P6 | 桌面文件操作 | 已验证 | 拖入附件、另存、取消及定位。[文件记录](../../../docs/evidence/desktop-p7-linux-x64/workflows.json) |
| P7 | Linux x64 本地候选与安装态验收 | 已验证 | [最新归档校验值与内置浏览器验收](../../../docs/evidence/desktop-p7-linux-x64/native-browser.json) · [退出与恢复](../../../docs/evidence/desktop-p7-linux-x64/ipc-shutdown.json) · [安装态功能](../../../docs/evidence/desktop-p7-linux-x64/workflows.json) · [Wayland](../../../docs/evidence/desktop-p7-linux-x64/wayland.json) · [第三方许可](../../../docs/evidence/desktop-p7-linux-x64/license-update.json) |
| P8 | Windows x64 候选构建 | 已验证归档及架构 | [ZIP 校验和目标架构](../../../docs/evidence/desktop-platform-previews.json) |
| P9 | macOS arm64 候选构建 | 已验证归档及架构 | [ZIP 校验和目标架构](../../../docs/evidence/desktop-platform-previews.json) |

桌面更新沿用原数据根和浏览器 profile。[同目录切换实测](../../../docs/evidence/desktop-p7-linux-x64/same-data-upgrade.json)

## Linux 桌面体验迭代 · 已验证

- [x] 浏览器面板缩为两行，共 80 CSS px。授权和说明移入浏览器设置。验证原生视图在弹窗关闭后恢复。
- [x] 输入区支持本轮全工具自动化。安装态验证网页点击、项目文件写入和本地 MCP 的实际效果及自动审批轨迹。
- [x] 正常退出旧实例，使用同一数据目录和网页 profile 开启新版，核对项目、会话、草稿和设置。[本轮验收](../../../docs/evidence/desktop-p7-linux-x64/task-automation.json)
- [x] 默认支持长任务，执行上限可在设置中开启。安装态验证超过 16 轮后生成结论并完成同目录切换。[长任务验收](../../../docs/evidence/desktop-p7-linux-x64/long-tasks.json)
- [x] 运行模式改用 shadcn Select 并随会话保存。安装态验证连续发送、隔离选择和重开后恢复。[会话模式验收](../../../docs/evidence/desktop-p7-linux-x64/session-approval-mode.json)
- [x] 发送区支持直接选择会话模型。合并 Shunt 路由与本机 Codex 目录，安装态核对切换后的模型请求和重开恢复。[模型选择验收](../../../docs/evidence/desktop-p7-linux-x64/session-model-picker.json)

- [x] 发送区精简模型菜单，增加会话推理深度。Linux 包内置 Shunt，并沿用持久配置和账号目录。[安装态验收](../../../docs/evidence/desktop-p7-linux-x64/managed-shunt-and-effort.json)

- [x] 会话网页链接提供内置新标签和系统浏览器入口。安装态验证两条路径、键盘焦点和原生标签保留。[链接验收](../../../docs/evidence/desktop-p7-linux-x64/chat-web-links.json)

- [x] 内置浏览器支持附件下载。安装态验证实际写盘、进度、保存路径与同名文件保留。[下载验收](../../../docs/evidence/desktop-p7-linux-x64/browser-downloads.json)

- [x] 编号式附件使用可匹配的网页标题保存。安装态核对中文文件名、原后缀和同名文件保留。[文件名验收](../../../docs/evidence/desktop-p7-linux-x64/browser-download-filenames.json)

- [x] 下载列表支持 FileVista 预览、系统应用打开和保留定位入口。安装态验证真实 XLS 内容及原生打开链路。[下载预览验收](../../../docs/evidence/desktop-p7-linux-x64/browser-download-previews.json)

- [x] 浏览器工具按操作设定时限，超时后释放占用，尽量保留当前页面。安装态验证聊天失败提示、同页恢复和任务继续执行。[超时恢复验收](../../../docs/evidence/desktop-p7-linux-x64/browser-timeout-recovery.json)

- [x] 当前轮执行时可继续发送到会话队列。安装态验证 Enter 入队、撤回和依次执行，运行时验证重开后继续。[消息队列验收](../../../docs/evidence/desktop-p7-linux-x64/session-message-queue.json)

## 另行安排的发布与平台验收

- Linux 对外发行，待确认应用及 `@atelier/markdown` 的许可证与发布授权。
- Windows 本机运行、安装与升级验收，待对应系统环境。
- macOS 本机运行与安装验收，待对应系统环境。正式分发的签名与公证随发布安排。

## P2 · 已验证

- [x] 用隔离数据复现 P1 窗口关闭、运行时退出和重复启动行为。
- [x] 记录生命周期协议、运行时配对、写者锁与恢复取舍。[P2 决策](../../../docs/decisions/2026-11-20-desktop-runtime-supervision.md)
- [x] 拆分宿主窗口与 sidecar 监督，提供故障状态和重启入口。
- [x] 收尾时停止接收任务，等待在途工具结束或取消，保存中断和审批状态。
- [x] 检查导入边界和旧连接，验证 Electron 协议、恢复流程及归档中的进程清理。
- [x] 将验收结果和开发过程 review 写入执行日志。

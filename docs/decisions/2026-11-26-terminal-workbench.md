# 工作台面板契约与人工交互终端

## 问题与范围

在 main@f48da53dd842e2176fdb3f2cfee96721a9d723fd 上加入会话终端，并把 Browser/Git/Terminal 的面板接入约定公开。新分支 feat/terminal-workbench。首期仅受信内置扩展及配对 Linux x64 桌面，尊重 nativeExecution。用户操作包括显式新建、交互、尺寸调整、切换与收起、结束、同一 sidecar 重连。Terminal 不改变原生 Agent Bash、SDK 权限、审批或队列。

## 查阅来源

- DSH: deepseek-ai/deepseek-harness@4b399c39a6d1479cd84ca591b4d7c88e24d38a96，packages/api/terminal-controller/src/terminal.ts；packages/client/ui-sidebar-terminal/src/client/terminal.tsx；ui-sidebar-right 注册表；preset 的 plugin-development.md。读过终端及插件装载源码，未运行 DSH。
- VS Code: microsoft/vscode@100ad34a3c09d80f1f442b5e0a94fc2e2b72a0a0，src/vs/platform/terminal/node/ptyService.ts、terminalProcess.ts。参考 PTY、屏幕恢复及流控，不迁移其服务容器。
- [xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/)、[xterm 6.0.0](https://github.com/xtermjs/xterm.js/tree/6.0.0)、[node-pty 1.1.0](https://github.com/microsoft/node-pty/tree/1.1.0)、[ws](https://github.com/websockets/ws)、[Node 24.21 HTTP](https://github.com/nodejs/node/blob/v24.21.0/doc/api/http.md)。核对公开 API、Buffer 输入、headless/serialize 实验性接口及 upgraded socket 的独立释放。
- 本仓 workspace.tsx、workspace-panels.tsx、DesktopBrowser、GitBoard、app.ts、DevelopmentWorktrees、runtime.mts 与 Linux/preview 打包脚本。

## 候选比较与决定

选择薄 PanelManifest/PanelDefinition/PanelHost，复用当前三栏和原生 Browser。静态注册的功能面板与功能内部终端实例分层；无需市场、动态 bundle、任意 IPC 或通用停靠平台。未来 Agent 可按公开契约新增受信 feature；运行任意外部代码需要独立隔离与授权设计。

PTY 由现有 Node sidecar 管理，使用 node-pty 1.1.0；renderer 用 @xterm/xterm 6.0.0 + addon-fit 0.11.0；sidecar 用 @xterm/headless 6.0.0 + addon-serialize 0.14.0；HTTP 生命周期和一次性票据 + ws 8.23.0。锁定版本并用真实依赖验证。

服务端权威记录使用 runtimeId + terminalId。幂等 create 预留后，首次附着 ready 才 spawn；关闭墓碑防止迟到重建。UI 显隐不结束 PTY，前端资源 cache 持有 xterm/WS/DOM，viewport 只持挂载租约。snapshot 与 live 有序衔接，ACK 在解析后发送。单个写入 attachment，旧连接不自动抢回。app 重启不复活 shell、不重放输入。

工作树专用保留仅阻止回收；开终端仍可 stage/commit。会话有活跃终端时归档/删除明确返回 TERMINAL_ACTIVE。升级连接单独校验 Host、Origin、一次性票据与子协议；不在 URL 放长期凭据或输入日志。

Linux 包增加目标 PTY native binding 和普通 Node 真实 spawn 探针。Windows/macOS 候选排除 node-pty，能力明确不可用，其余功能继续构建。

## main 适配

main 相比原 feat/terminal 多四个提交。使用新版 GitBoard 回调保留文件阅读、引用与工作树行为；保留新会话活动和原生 Bash 控制。面板改动不重写这些功能。实施细节及限额见 [计划](../superpowers/plans/2026-11-26-terminal-workbench.md)。

## 终端颜色与对比度

参考 [Oh-DSH 终端插件](https://github.com/hust-open-atom-club/oh-dsh/tree/9a428a8/plugins/panel-controls/src/terminal) 的 `terminal-theme.ts` 和 `TerminalView.tsx`，使用应用表面、文字和选区颜色，并为亮暗主题分别提供 ANSI 色板。Atelier 监听自身的根节点 `data-theme`，在同一个 xterm 实例中更新配色。像 Oh-DSH 一样保留视口背景的 CSS 覆盖，并对 xterm 设置同一个默认背景。

透明背景的 Neovim 可以使用不经过 ANSI 色板的 RGB 高亮。按照 [xterm 的公开选项](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/#minimumcontrastratio) 启用 4.5 的最低文字对比度，让低对比度文字在渲染时调整。改动位于前端，不需要更改 shell、Neovim 配置或 PTY 协议。以 Chromium 的实际文字颜色、同连接切主题和 Electron 中的真实 Neovim 验证。若需回退，恢复 xterm 初始化时只读取前景和背景的逻辑。

## 输出积压与输入回执

真实 manager 的既有 ACK 窗口用于断开慢连接。延迟消费后，同一会话的持续输出在 512 KiB 上限处触发 `TERMINAL_SLOW_CONSUMER`，即使接收端随后还能继续处理。浏览器也会将已经收到的输入回执排在 xterm 输出写入之后，断线时可能把这类已收回执的输入显示为未确认。截图无法单独区分限额出自哪一端。

[xterm 的 WebSocket 流控指南](https://xtermjs.org/docs/guides/flowcontrol/) 建议按解析回执暂停及恢复 PTY。DSH 插件 `TerminalView.tsx` 的浏览器端直接写 xterm，与本项目的序列、快照和回执设计不同。复用现有 ACK 和 node-pty 的暂停机制更适合本项目，保留当前帧结构及内存上限。

实时输出在 ACK 窗口内为下一帧预留空间，达到阈值时暂停 PTY 读取，回执释放额度后继续输出。等待有上限，失联或替换时清理等待并释放暂停。输入回执在浏览器收到后即时记账，独立于渲染队列，仍由同一附件及输入序号校验。隔离 Electron 测得单次突发被拆成数千条小帧，逐帧等待 xterm 回调导致输出已经送达时屏幕还未追上。浏览器以 128 KiB 为上限合并相邻且连续的输出，控制帧结束批次，解析完成后回执推进至批次末尾。无回执的输入继续不重放，真实重连仍使用屏幕快照。回退可恢复旧 manager 的输出限额处理与终端客户端的入站顺序。

## 2026-11-26 · 对齐 VS Code 的流控和快照交接

旧实现用同一个水位暂停和恢复，单个小回执即可重新放行。重连时快照之后的输出还会进入另一条有界队列，浏览器确认快照前若有已读到的 PTY 数据进入，队列可能先耗尽。两个现象均由 `tests/terminal-manager.test.ts` 复现。

以 VS Code `a0913d44` 的 [高低水位](https://github.com/microsoft/vscode/blob/a0913d44a9bfd44328303300cd8a668e6967de76/src/vs/platform/terminal/common/terminal.ts#L915-L936) 和 [xterm 解析回执](https://github.com/microsoft/vscode/blob/a0913d44a9bfd44328303300cd8a668e6967de76/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts#L1718-L1726) 为参考。Wave 的 [快照加文件偏移恢复](https://github.com/wavetermdev/waveterm/blob/9f1c9670d407be3b93cf090319a63ef30bf54d0e/frontend/app/view/term/termwrap.ts#L498-L542) 适合较长历史，本轮复用已有内存屏幕与协议，不引入输出文件。

沿用 512 KiB 未确认输出硬上限。按帧的 UTF-8 JSON 字节计量，达到 384 KiB 暂停后续输出，确认后降至 192 KiB 才恢复。在等待期间，只有推进序号的回执才刷新 5 秒停滞期限。复用屏幕顺序队列及其硬上限，快照发出后等待同一附件的 `ready`。先发送 `readyAccepted`，再放行后续屏幕写入和实时输出。更换连接、关闭和超时都会释放旧等待。此顺序也避免 [VS Code #335982](https://github.com/microsoft/vscode/issues/335982) 所描述的实时回执与恢复阶段重叠。窗口重连继续使用原 shell，整个应用退出仍结束其终端。回退为恢复原 manager 的单水位与快照待发送队列。

## 验证及回退

针对真实 PTY 测试 Unicode/ANSI、控制信号、尺寸、退出与快照；针对真实 HTTP/WS 测试授权、重连和慢消费者；用隔离 Electron 覆盖实际入口与 Browser 遮挡；发行验收使用实际工件。固定版本依赖和类型检查不等于桌面/安装验收。系统 IME 及跨平台真机结果分别记录。

终端屏幕是有限内存状态，不落 SQLite。没有 renderer 时查询型 TUI 可能超时，重新附着不保证所有 VT 协议状态恢复。不能承诺任意脱离会话进程随 shell 退出。工程阈值从计划起步，以实测调整并记录。

回退为关闭 Terminal 注册项与 capability，移除终端路由/服务/依赖，恢复既有面板适配；无数据库迁移及持久 PID。若正常退出无法可靠释放所属资源，发行验收不得标记通过。

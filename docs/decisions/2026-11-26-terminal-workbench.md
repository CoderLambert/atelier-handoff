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

## 验证及回退

针对真实 PTY 测试 Unicode/ANSI、控制信号、尺寸、退出与快照；针对真实 HTTP/WS 测试授权、重连和慢消费者；用隔离 Electron 覆盖实际入口与 Browser 遮挡；发行验收使用实际工件。固定版本依赖和类型检查不等于桌面/安装验收。系统 IME 及跨平台真机结果分别记录。

终端屏幕是有限内存状态，不落 SQLite。没有 renderer 时查询型 TUI 可能超时，重新附着不保证所有 VT 协议状态恢复。不能承诺任意脱离会话进程随 shell 退出。工程阈值从计划起步，以实测调整并记录。

回退为关闭 Terminal 注册项与 capability，移除终端路由/服务/依赖，恢复既有面板适配；无数据库迁移及持久 PID。若正常退出无法可靠释放所属资源，发行验收不得标记通过。

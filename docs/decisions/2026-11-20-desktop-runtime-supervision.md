# P2 桌面运行时监督

已在 Linux x64 安装件验收。范围见 [P2](../../openspec/roadmaps/build-atelier-desktop/roadmap.md#p2--窗口运行时与恢复)。

## 问题与基线

在独立 Electron profile 和数据根下启动 P1 Linux 安装件。第二次启动退出码为 0，沿用第一个运行时。正常关闭后运行时退出。对测试运行时施加 SIGKILL 后，窗口存活，API 断开且没有恢复入口。当前启动握手借用浏览器协议。HTTP 的本机来源与 CSRF 校验没有把桌面服务绑定到本次宿主。现有 PID 文件能拒绝活进程，但两个启动器可能同时清理上一次崩溃遗留的文件。

## 依据与取舍

- Node `fork` 提供私有 IPC，子进程退出、断连与 `error` 需要分别处理，`kill()` 不会递归清理 Linux 子进程。Electron `webRequest` 支持按请求 URL、WebContents 和 frame 选择请求头，且可注销监听器。[Node child_process](https://nodejs.org/docs/latest-v24.x/api/child_process.html) · [Electron webRequest](https://www.electronjs.org/docs/latest/api/web-request)
- VS Code 使用独立的 Node IPC 生命周期，断开后释放连接和相关资源。Theia 的 Electron main fork 后端并经 IPC 获取真正绑定的端口，再在 Electron 层附加安全令牌。atelier 沿用现有 fork 和本机 HTTP，在应用装配层隔离窗口和监督逻辑，并为本项目增加显式故障恢复。[VS Code IPC 源码](https://github.com/microsoft/vscode/blob/306a2166454856f58ea7e1b75c7c70b9cac4b99e/src/vs/base/parts/ipc/node/ipc.cp.ts) · [Theia Electron main](https://github.com/eclipse-theia/theia/blob/727005ec31a7d0a6ac5da4877fbaf66bbacf9aef/packages/core/src/electron-main/electron-main-application.ts#L830)
- 备选是把现有 HTTP 改成逐操作 IPC 或更换进程框架。这样会同时改动 Web 入口、SSE 与文件读取。现有的 Node IPC 加可校验的消息足以监督单个运行时。将 Web 与桌面共享的业务 API 保留在 Node 侧。

## 方案

1. 独立宿主握手协商协议版本和本次运行标识。Electron 监督启动、运行、停止与故障，窗口通过原生对话框提供重试。每次重试使用新的连接身份。旧进程消息失效，关闭旧网页视图和待决请求后再连新运行时。桌面优先使用动态回环端口。显式端口冲突可直接重试。
2. 本次运行的随机配对值经私有 IPC 传递。Electron 在可信工作台窗口的主 frame 请求准确的回环 API 时附加配对头。主页面发起的交付物沙箱预览只允许配对该条预览读取。桌面运行时校验全部 API 读写，Web 入口沿用自己的来源和 CSRF 校验。浏览器内部页面使用独立会话。
3. 运行时在私有数据根持有独立 SQLite 锁定事务，跨进程关闭时由操作系统释放。继续读写 PID 文件以识别已运行的旧版本。升级时先关闭旧版。收到退出请求后停止接收新任务，取消在途 Agent 和 MCP，等服务请求完成再关闭存储。恢复在事务内打断存量活动运行并使旧审批失效，保留已知结果，并提示检查未确认的副作用。
4. 握手与初始化限时 12 秒，窗口装载限时 8 秒。Linux 正常退出预算仍为 3 秒。超出正常期限后记录进程状态，宿主等待最多 10 秒并清理属于本次运行的 Unix 子进程组。独立 bwrap 工具有自己的父进程退出保护。Windows 子孙进程清理归 P8 实测。

## P8 正常退出准备

Node.js 在 Windows 上以强制终止实现 `child.kill('SIGTERM')`，运行时无法依靠该信号完成保存。桌面宿主正常退出时关闭私有 IPC。运行时已有的 `disconnect` 处理会停止接收新任务、等待在途工作并释放数据库。宿主继续等待进程退出，超时后调用现有强制清理。Windows 安装件仍需验证系统关机、正常退出和子孙进程清理。

关闭私有 IPC 后，宿主以子进程的 `exit` 事件确认实际退出。启动失败时保留 `close` 兜底。Linux 上复用安装件故障恢复测试，覆盖 SDK 运行中关闭、已持久化的中断记录和单写者。在对应平台的图形会话运行 `npx tsx scripts/smoke-desktop-recovery.mts <安装后的 Electron 可执行文件>`。脚本在 Windows 查找 `resources/runtime/bin/node.exe`，在 macOS 查找 `.app/Contents/Resources/runtime/bin/node`。失败时回退这一宿主改动，沿用已验收的 P7 归档。[Node.js 子进程文档](https://nodejs.org/docs/latest-v24.x/api/child_process.html#subprocessdisconnect) · [Electron 退出事件](https://www.electronjs.org/docs/latest/api/app#event-before-quit)

## 验证与回退

在隔离数据根与 profile 复测重复启动、端口冲突、强制终止、重试、待审批恢复、API 配对和普通 Web 启动。安装态重跑 SDK 服务替身以及十次进程清理。证据按测试范围写入 [执行日志](../../openspec/roadmaps/build-atelier-desktop/task-log.md)。失败时停止新进程，将 P1 安装件指向备份数据副本。P2 不升级业务数据库 schema，临时验证先使用副本，旧版不得与新版同时尝试打开同一数据根。

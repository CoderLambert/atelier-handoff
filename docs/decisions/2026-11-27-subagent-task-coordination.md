# C8 · `ToolInvocationGate`、`SdkTaskCoordinator` 与 `tool-evidence` 解耦

## 问题与范围

第 0 批已先抽出 `server/secret-redaction.ts` 并移除 `server/harness-progress.ts` 中零调用的 `buildHarnessCheckpoint` / `renderHarnessCheckpoint`。剩余三处跨模块状态镜像仍集中在运行热路径：

1. `server/subagent-run.ts` 既管子代理生命周期，又混入主会话与子代理共用的 MCP 一次性票据 `tickets` 及目录写锁 `ProjectWrites`；同时 `server/agent.ts` 仍在外部手工维护 `branchControllers` 并与 `SubagentRun.finish()` 对账。
2. `server/subagent-run.ts` 与 `server/native-bash.ts` 各自维护同构的 SDK task frame（`task_started` / `task_updated` / `task_notification`）Zod schema；`server/agent.ts` 另维护 `runningTools` Map 并与 `subagents`、`bash` 三方共同传入 `LiveTurnCoordinator` 手工推导前台任务与后台交接。
3. `server/session-checkpoint.ts` 只需无状态工具证据投影，却被迫依赖整个 `HarnessProgress` 停滞观察状态机。

本轮仅收敛运行时内部边界，不改变外部 HTTP/SSE 契约、SQLite schema、`Runner` 公开签名及既有 SDK 前后台语义。

## 取舍

- 提取 `server/modules/runs/tool-invocation-gate.ts`：统一承接 `ToolInvocationGate`（含确定性 `callHash`、一次性票据签发/核销、按子代理归属清理）与 `ProjectWrites`（`server/subagent-run.ts` 保留类型/值重导出以兼容现有单测），使 `SubagentRun` 不再承载主会话票据与写锁。
- 将 `branchControllers` 收回 `SubagentRun` 内部（`ensureBranchSignal`、`branchSignal`、`stop` 并在 `finish`/`close` 自动 `abort`），确保分支中止信号与子代理任务同生共灭，保持「先调用 `sdk.stopTask(sdkId)`、再中止本地 `AbortController`」的既有顺序。
- 提取 `server/modules/runs/sdk-task-coordinator.ts`：通过单一 `createSdkTaskFrameSchemas` 工厂复用 `local_agent` / `local_bash` 帧校验规则（保留 `local_bash` 的正则标识与 `output_file` 校验及 `local_agent` 的顶层 `parent_task_id` 约束），并由 `SdkTaskCoordinator` 持有唯一 `runningTools` 注册表与 `foregroundTools()` / `canBackground()` / `backgroundTool()` / `handleStarted` / `handleUpdated` / `handleNotification` 协调视图；`LiveTurnCoordinator` 优先消费该统一视图并保留既有测试构造兼容路径。
- 提取纯函数模块 `server/tool-evidence.ts` 承接无状态工具证据与恢复摘要投影，`server/session-checkpoint.ts` 改直连 `tool-evidence.ts`，`server/harness-progress.ts` 仅保留停滞观察状态机并重导出既有公共符号以零破坏兼容。

## 验证与回退

新增纯内存单测 `tests/sdk-task-coordinator.test.ts` 覆盖 `ToolInvocationGate`（票据一次消费、参数哈希/工具名校验、失活子代理吊销、`ProjectWrites` 目录串行化）、`SubagentRun` 分支中止与 `stop` 顺序、`SdkTaskCoordinator` 帧分派与单一前台视图及 `tool-evidence` 投影；再以 `npm run check`、`npm run check:headers`、`npm run build`、`npm run build:desktop`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 及隔离 Wayland 真实 Electron 烟测（`smoke-subagent-insertion.mts`、`smoke-ordered-conversation.mts`）验证。若出现子代理停止、后台交接或工具票据回归，整体回退 C8 提交即可，无需数据迁移。

```sh
node --import tsx --test tests/sdk-task-coordinator.test.ts tests/live-turn-coordinator.test.ts tests/subagents.test.ts tests/native-bash-control-sdk.test.ts tests/native-subagent-insertion-sdk.test.ts tests/harness-progress.test.ts
```

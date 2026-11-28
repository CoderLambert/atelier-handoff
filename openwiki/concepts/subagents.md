---
type: 核心概念
title: 会话子代理与并发委派
description: Explore 和 Worker 的工具范围、SDK 委派、子任务持久化与独立停止。
tags: [subagents, delegation, native-sdk, cancellation]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-27T05:51:26.216Z
sources:
  - id: openwiki-source-9cb1e02f59a7fc96ce5b1ac2
    resource: repo://server/agent.ts
  - id: openwiki-source-9efae68e9e0a5fa11126ab78
    resource: repo://server/db/repositories/subagents.ts
  - id: openwiki-source-a5067dcc0ed7bbd83cc2f70a
    resource: repo://server/modules/runs/sdk-stream-consumer.ts
  - id: openwiki-source-0fc50105a1f23821c469f2e4
    resource: repo://server/modules/runs/sdk-task-coordinator.ts
  - id: openwiki-source-6272e3b28e5421c6eeb853b7
    resource: repo://server/permissions.ts
  - id: openwiki-source-59b7b553579ca4751ffceb2e
    resource: repo://server/subagent-run.ts
generated: { by: "claude-code", at: "2026-11-27T05:51:26.216Z" }
---

# 会话子代理与并发委派

`AgentRunner` 在当前轮允许委派时启用 SDK 的 `Agent`，并注册 `atelier-explore` 和 `atelier-worker`。Explore 面向只读调查，Worker 负责可执行任务。两个配置都使用 `model: 'inherit'`。前台委派由 SDK 调度。执行器和当前项目授权决定子任务可用的工具。

在受控执行器中，Worker 使用工作台提供的文件和命令工具。需要审批的操作经过当前运行的审批服务，并保留子任务归属。本机信任会话使用符合该执行器规则的 SDK 原生工具。工具限制见[受控权限与本机信任](./security-permissions.md)。

## 状态与停止

`SubagentRun` 把 SDK 事件与工作台子任务记录关联。`subagents` 仓储保存运行 ID、会话 ID、类型、状态和结束摘要。任务开始、更新与结束帧由运行时协调器接收；子代理和本机 Bash 共用任务帧契约，分别按任务类型分流。前后台判定由协调层提供给实时会话，不改变 SDK 对前台子代理的调度。相关回执与审批使用子任务 ID 归属。在途子任务遇到服务重启可被标记为中断。

界面停止某一子任务时，运行时调用 SDK 的 `stopTask`，并单独取消该分支的工作台审批和命令。目标必须仍属于活动运行并有可用的 SDK 任务 ID。父轮次继续处理其他工作。回环验证入口为 `tests/subagents.test.ts` 与 `tests/subagent-sdk-probe.test.ts`。

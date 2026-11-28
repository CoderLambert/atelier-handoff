---
type: 核心概念
title: 受控权限与本机信任
description: 工作台的四种输入模式、受控审批和文件基线复核，以及 Linux 命令隔离的适用范围。
tags: [permissions, sandbox, bubblewrap, native-execution, approval]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-27T05:51:26.216Z
sources:
  - id: openwiki-source-ce5aff777b3733ade8671fea
    resource: repo://frontend/src/features/chat/run-mode.ts
  - id: openwiki-source-ccf6bb698fab445b37e7436a
    resource: repo://server/commands.ts
  - id: openwiki-source-013b450d86da1bcd8d9ca8bf
    resource: repo://server/db/schema/schedules.ts
  - id: openwiki-source-a299b5f0a3c5a4c63b3411ce
    resource: repo://server/modules/runs/create-run.ts
  - id: openwiki-source-6c0d9eb948875391a826000e
    resource: repo://server/modules/schedules/scheduler.ts
  - id: openwiki-source-834cc557fcfaff5d2bdb5a60
    resource: repo://server/native-harness.ts
  - id: openwiki-source-6272e3b28e5421c6eeb853b7
    resource: repo://server/permissions.ts
generated: { by: "claude-code", at: "2026-11-28T07:11:46.812Z" }
---

# 受控权限与本机信任

| 输入模式 | 执行路径 |
| --- | --- |
| 只读 | 项目执行器提供已授权的读取能力。只读配置优先于草稿偏好。 |
| 受控修改 | 项目执行器通过工作台提出文件或命令操作，操作按次进入审批。 |
| 全工具自动化 | 项目执行器仍走审批服务，由它在当前运行模式、权限和文件基线有效时记录自动决定。 |
| 本机信任 | 在允许使用本机执行器的桌面会话中，模型可调度 SDK 原生文件和 Shell 工具。 |

普通 Linux 桌面在本机执行已启用时可为新会话选择本机信任。运行记录保存所用执行器，后续界面可区分原生工具与受控工具的执行结果。

## 受控审批与基线

`PermissionService` 保存工具记录、审批版本、有效期和文件基线。人工决定需要版本匹配。自动决定也会读取当前文件并检查基线。已停止的运行、过期审批或文件基线冲突会拒绝执行，界面和运行轨迹保留审批结果。

## 受控命令隔离

受控命令在 Linux 通过 Bubblewrap 执行，使用独立命名空间、受限挂载和 60 秒取消计时器。系统启动能力检查失败时，调用会返回命令不可用错误。本机信任模式的原生 Bash 遵循 SDK 原生执行路径。排查权限时先核对这一轮的模式、执行器与工具 ID。

任务执行偏好与普通会话分开保存；后台触发不会继承一次手动对话的工具选择。配置约束见[自动化任务与运行历史](./scheduled-tasks.md)。

可从[Agent 运行时](../architecture/agent-runtime.md)和[会话子代理](./subagents.md)继续查阅工具回执与分支权限。

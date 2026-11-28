---
type: 功能工作流
title: 自动化任务与运行历史
description: 配置手动或定时任务，理解模型继承、会话目标、审批边界以及触发记录如何反映实际运行。
tags: [automation, schedules, triggers, sessions, approvals]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-28T07:11:46.812Z
sources:
  - id: openwiki-source-e50eb37efa5218d0fb6b2b47
    resource: repo://frontend/src/features/schedules/schedule-form.tsx
  - id: openwiki-source-a299b5f0a3c5a4c63b3411ce
    resource: repo://server/modules/runs/create-run.ts
  - id: openwiki-source-c04c7e736bc86ad3c24ea697
    resource: repo://server/modules/runs/mcp-tools/schedule-tools.ts
  - id: openwiki-source-6c0d9eb948875391a826000e
    resource: repo://server/modules/schedules/scheduler.ts
  - id: openwiki-source-43b115893ffa334cf7495173
    resource: repo://server/modules/schedules/service.ts
  - id: openwiki-source-3f159b8d8647b9e3c11e3752
    resource: repo://shared/schedules.ts
  - id: openwiki-source-1123c47d903d85e42ad2a33f
    resource: repo://tests/schedules.test.ts
generated: { by: "claude-code", at: "2026-11-28T07:11:46.812Z" }
---

# 自动化任务与运行历史

在工作台的「自动化任务」页，可为项目新建规则，选择「仅手动」、单次、间隔、每天、每周或 Cron 触发。仅手动规则没有下一次触发时间；一次性计划的触发时点被处理后结束。编辑暂停或已结束的任务不会自动重新启用它。手动试跑不会消耗下一次计划时点。

## 会话、模型与权限

可以指定已有会话、首次运行时创建一个专用会话并在后续复用，或者每次新建会话。指定的已有会话必须可用；没有指定会话或它已归档时，不会改到任意其他会话执行。任务的模型覆盖优先于会话草稿模型和工作台默认模型；推理强度可独立保存。编辑时清空覆盖会提交 `null`，回到继承或自动选择，界面也会标明网关路由的固定推理强度。

默认执行偏好 `project-v1` 走工作台权限。本机项目执行 `native-v1` 需要支持该能力的已配对 Linux 桌面与修改模式，不与绑定智能体、全工具自动审批或搜索预算并用。MCP 创建「修改 + 全工具自动化」任务需要显式人工批准。调度器提交任务自己的模式、覆盖与审批配置，不会带上普通消息手动选中的扩展；手动会话可调用某个 MCP，并不说明同一项目的定时任务也能调用它。

## 到期派发与记录

触发时先记录本次提示词和目标；临时输入只拼到这次提示词，不修改任务模板。触发记录与关联的会话运行是分开的；派发后以实际 `run.finished` 更新为完成或失败，没能派发的记录也会保存跳过或错误原因。已有幂等键可复用历史记录，任务链有深度上限并检查循环。运行历史可帮助区分重复触发、会话忙、错过时点和运行失败。

调度器在启动和系统唤醒时检查到期任务。错过时点时按策略补跑一次或记录跳过；并发已满时为交互会话预留执行余量。目标会话忙时，非手动触发可按重叠策略跳过，也可走正常的运行排队。成功会清零连续失败次数，连续五次失败会自动暂停任务。`tests/schedules.test.ts` 覆盖时区与夏令时、触发幂等、权限、连续失败及模型覆盖等场景。

## 延伸阅读

- [Agent 运行时与会话调度](../architecture/agent-runtime.md)
- [数据持久化与模型映射](../architecture/database-storage.md)
- [受控权限与本机信任](./security-permissions.md)

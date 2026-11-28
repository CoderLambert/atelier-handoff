---
type: 系统架构
title: Agent 运行时与会话调度
description: Claude Agent SDK 的消息执行、SSE 游标、会话恢复和工具回执保留机制。
tags: [agent, claude-agent-sdk, runtime, sse, recovery, tool-output]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-27T05:51:26.216Z
sources:
  - id: openwiki-source-d141707bca164293967811cd
    resource: repo://frontend/src/app/events.ts
  - id: openwiki-source-9cb1e02f59a7fc96ce5b1ac2
    resource: repo://server/agent.ts
  - id: openwiki-source-208e39b5c2c087b74dfcb51d
    resource: repo://server/bash-log-capture.ts
  - id: openwiki-source-de2e9376e601b9a1e484e428
    resource: repo://server/http/events/routes.ts
  - id: openwiki-source-7ad1fdbececf57496a2c4b24
    resource: repo://server/modules/runs/mcp-tools/builtin-tools.ts
  - id: openwiki-source-6b24a69c3b689b61864c3553
    resource: repo://server/modules/runs/recovery.ts
  - id: openwiki-source-997460ddc4739bdcf3f2a63f
    resource: repo://server/modules/runs/tool-call-recorder.ts
  - id: openwiki-source-80a0ef5585c3d6d4304d8bfa
    resource: repo://server/sdk-resume.ts
  - id: openwiki-source-d615e3f90fe1a2e4daf557f0
    resource: repo://server/session-checkpoint.ts
  - id: openwiki-source-4bc265ec5cf3ceec89040a7d
    resource: repo://server/tool-output-search.ts
  - id: openwiki-source-6198df9813cbedd50ce1f61a
    resource: repo://tests/runtime-orm-queries.test.ts
generated: { by: "claude-code", at: "2026-11-27T05:51:26.216Z" }
---

# Agent 运行时与会话调度

## 运行和事件

用户提交消息后，运行时为该轮选择会话的模型、执行器与工具权限。`AgentRunner` 用 Claude Agent SDK 的 `query` 运行一轮，把工作台工具通过进程内 `createSdkMcpServer` 注入。受控执行器禁止原生 Bash、Write、Edit 等能力，改由工作台提供符合授权的工具。本机执行器可以使用 SDK 原生工具，并由运行时接收工具生命周期和审计信息。[权限与执行器](../concepts/security-permissions.md)

`GET /api/events` 是从服务端到界面的单向 SSE 流。连接通过 `Last-Event-ID` 或 `after` 指定恢复游标，补发已保存的事件后继续接收新事件。游标无效时发送 `cursor-reset`。浏览器用 `EventSource` 驱动流式文本、工具明细和运行状态，发送消息与审批通过独立 HTTP 请求完成。

## 停止与恢复

服务重启时，运行时在一个事务内恢复待处理消息的投递状态，收尾活动运行、工具、子任务和待审批记录，并保留已保存的转录顺序。旧审批随中断失效；已经发生的文件修改不会自动回退。`tests/runtime-orm-queries.test.ts` 验证恢复的事务回滚与幂等性。

运行拥有取消信号。SDK 会话 ID、模式和兼容指纹匹配时沿用原生会话；需要重建上下文时，运行时组合近期对话与从历史运行、工具回执提取的有界检查点。检查点记录用户要求、来源和回执引用及未确认副作用，不等同于完整工具输出；分支可继承可见对话前缀，运行和工具证据仍按实际会话与项目筛选。`tests/session-checkpoint.test.ts` 覆盖长历史预算、继承边界与待核实副作用。[数据持久化](./database-storage.md)

兼容身份包含网关、执行器和绑定智能体版本；运行模式另行匹配，当前权限和工具在每次请求重新组装。检查点区分仅发现的链接与已完成抓取的请求，并记录对应工具 ID；抓取完成不等于内容已核实。符合权限的 native 主会话可跨轮回查保存的工具结果，子任务不继承这一权限。历史资料不能替代当前指令，未确认副作用须先核查实际状态。恢复行为的锁定 SDK 回环使用本地模型传输替身，不证明真实模型一定选择回查而非重新抓取。

## 工具结果与日志

工作台保留工具回执，较长结果可先给模型有界摘录和读取指针。`read_tool_output` 校验读取者与目标工具记录的关系。普通分页默认读取原始回执，提供 `query` 时默认对可读日志做单行、区分大小写的字面搜索，返回命中行和可继续读取的 UTF-16 偏移。Linux 本机 Bash 可关联受限大小的 SDK 日志副本，已保存范围随结果返回。真实 SDK 回环和文件捕获用例位于 `tests/tool-output-context-sdk.test.ts` 与 `tests/bash-log-capture.test.ts`。

## 相关页面

- [会话子代理与并发委派](../concepts/subagents.md)
- [工作台导航与会话操作](../concepts/workspace-navigation.md)

---
type: 集成支持
title: 模型目录与网关路由
description: Shunt 路由、Codex 补充目录、Magpie 开关和会话模型选择如何影响运行时请求。
tags: [model-catalog, gateway, shunt, codex, magpie]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-23T19:36:38.791Z
sources:
  - id: openwiki-source-14c344861a255393228110f4
    resource: repo://frontend/src/features/chat/model-picker.tsx
  - id: openwiki-source-9cb1e02f59a7fc96ce5b1ac2
    resource: repo://server/agent.ts
  - id: openwiki-source-000361a88dbbc94ac8bb2060
    resource: repo://server/app.ts
  - id: openwiki-source-fc274c6bc8842c9bb497e761
    resource: repo://server/gateway-models.ts
  - id: openwiki-source-00f6e5badfd2fd85d2943b4e
    resource: repo://server/magpie-models.ts
generated: { by: "claude-code", at: "2026-11-22T13:27:54.578Z" }
---

# 模型目录与网关路由

会话输入区和「设置 → 模型与网关」使用运行时的模型目录。选择器按 Shunt 和 Magpie 分组，支持手动输入模型 ID。发送时，运行时先考虑已有发送意图或重试配置，再按请求、会话草稿、工作区默认值选择模型。

## Shunt 与 Codex 目录

`GET /api/models` 从配置的回环网关读取 `/routes`，校验返回项并按模型 ID 合并元数据。默认模型始终出现在基础目录中。使用托管网关或发现 ChatGPT Plan 路由时，运行时会尝试用 Codex `model/list` 补齐目录。发现状态会区分部分成功、过期缓存与不可用。`tests/gateway-models.test.ts` 和 `tests/codex-model-catalog.test.ts` 覆盖分页、超时、账号隔离及失败后恢复。

## Magpie 开关与路由

Magpie 的目录和发送受独立开关控制。关闭时，运行时停止在途目录查询，历史选择继续保留，界面标示不可用。开启后，工作台把发现的模型加入 Magpie 分组。发送、重试或投递时，运行时复核当前设置，对 Magpie 模型选择对应本机网关，再将去掉分组前缀的模型 ID 交给 SDK。相关源码位于 `server/app.ts`、`server/magpie-models.ts` 与 `server/agent.ts`。

排查目录时先核对设置中实际保存的网关和发现状态。排查发送时再查看会话模型或历史运行记录。托管网关的进程归属见[系统架构全景](../architecture/overview.md)。

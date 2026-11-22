---
type: 系统架构
title: 系统架构全景
description: Electron 桌面宿主、Node 运行时、React 工作台与本地模型网关之间的职责和通信路径。
tags: [architecture, electron, runtime, react, gateway]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-22T13:27:54.578Z
sources:
  - id: openwiki-source-754af1375ffae564bdab3544
    resource: repo://desktop/main.mts
  - id: openwiki-source-b7b36166e65355583deb5a23
    resource: repo://frontend/src/app/workspace-router.tsx
  - id: openwiki-source-4622f09188c7b2fdc738352b
    resource: repo://frontend/src/main.tsx
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
generated: { by: "claude-code", at: "2026-11-22T13:27:54.578Z" }
---

# 系统架构全景

| 层 | 拥有的状态和职责 | 源码入口 |
| --- | --- | --- |
| Electron 桌面主进程 | 窗口、原生浏览器、系统文件交互、运行时监督、托管 Shunt 的启动与退出 | `desktop/main.mts`、`desktop/host/` |
| Node 运行时 | 回环 HTTP 与 SSE、Agent SDK、会话、队列、权限和本地数据写入 | `server/main.ts`、`server/app.ts`、`server/agent.ts` |
| React 工作台 | 项目树、会话流、执行明细和独立设置页。TanStack Router 管理路由，TanStack Query 缓存服务端视图 | `frontend/src/main.tsx`、`frontend/src/app/workspace-router.tsx` |

桌面主进程启动并监督运行时，在运行时就绪后用其地址建立应用窗口。Renderer 通过同源 HTTP 读取或提交业务数据，通过 SSE 接收运行时事件，原生窗口能力经 preload 暴露的入口调用。Node 运行时持有数据目录锁与 SQLite。桌面原生网页由 Electron 管理，页面与项目工作区视图各有自己的生命周期。

Linux 桌面可由 `ManagedShunt` 启动托管网关，把连接信息交给运行时，关闭时回收网关进程。运行时根据所选模型和当前设置组装网关请求。网关目录、Magpie 与发送路径见[模型目录与网关路由](../integrations/model-gateways.md)。

## 延伸阅读

- [Agent 运行时与会话调度](./agent-runtime.md)
- [数据持久化与模型映射](./database-storage.md)
- [工作台导航与会话操作](../concepts/workspace-navigation.md)
- [桌面端打包与运维构建](../operations/desktop-build.md)

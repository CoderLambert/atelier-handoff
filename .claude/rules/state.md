---
paths:
  - "frontend/src/app/**/*"
  - "frontend/src/use-query/**/*"
  - "frontend/src/features/**/api.*"
  - "frontend/src/features/chat/**/*"
  - "server/store.ts"
  - "server/app.ts"
  - "server/permissions.ts"
  - "server/agent.ts"
  - "server/modules/**/*"
  - "shared/**/*.ts"
---

# 状态管理

- 给状态指定所有者。SQLite 保存权威业务记录，TanStack Query 缓存服务端快照，Redux Toolkit 保存工作台选择及按会话隔离的编辑状态，组件内保留焦点、展开与未提交表单。
- Query key 包含项目、会话或实体身份。SSE 事件按相关 key 更新/失效，断线后按游标补齐。保存草稿和提交按会话排队，迟到响应不能覆盖新编辑。
- 同一前端交互意图（如输入框聚焦）只保留单一权威信号通道（如 Redux `workspace` slice 的 `{ sessionId, requestId }`），禁止并存越层 `getElementById`、多层 props 透传与局部 state；乐观更新或本地覆盖态（如布局覆盖）在服务端确认或切换上下文后必须显式释放，防止永久遮蔽后续服务端更新。
- 运行、审批、终止和人工控制使用可枚举状态与明确的有效转换。在途操作停止后处理迟到结果，恢复时保留已产生的副作用和失效审批记录。
- 服务端运行轮次、待发消息队列、子代理与任务帧协调状态以持久化记录或单一协调器为权威源，派生投影只读不反向回写，也不在同域维护重复的恢复协调器；状态推进须经显式合法性校验。
- 新增持久字段时定义既有数据的默认值或追加迁移。以「切换 A/B 会话、重新打开、故障恢复」覆盖状态隔离。缓存不保存凭据、图片 base64 和人工登录输入。

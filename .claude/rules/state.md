---
paths:
  - "frontend/src/app/**/*"
  - "frontend/src/features/**/api.*"
  - "frontend/src/features/chat/**/*"
  - "server/store.ts"
  - "server/app.ts"
  - "server/permissions.ts"
  - "server/agent.ts"
  - "shared/types.ts"
---

# 状态管理

- 给状态指定所有者。SQLite 保存权威业务记录，TanStack Query 缓存服务端快照，Redux Toolkit 保存工作台选择及按会话隔离的编辑状态，组件内保留焦点、展开与未提交表单。
- Query key 包含项目、会话或实体身份。SSE 事件按相关 key 更新/失效，断线后按游标补齐。保存草稿和提交按会话排队，迟到响应不能覆盖新编辑。
- 运行、审批、终止和人工控制使用可枚举状态与明确的有效转换。在途操作停止后处理迟到结果，恢复时保留已产生的副作用和失效审批记录。
- 新增持久字段时定义既有数据的默认值或追加迁移。以「切换 A/B 会话、重新打开、故障恢复」覆盖状态隔离。缓存不保存凭据、图片 base64 和人工登录输入。

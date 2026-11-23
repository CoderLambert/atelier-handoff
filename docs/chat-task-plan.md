# 会话任务看板实现说明

会话输入框上方的任务看板展示当前这轮的计划和完成进度，例如 `任务 2/3`。标题可用鼠标、Enter 或空格展开和收起。当前这轮有计划时默认展开，旧计划从对应的助手消息中查看。

## 计划从哪里来

1. **运行时写入计划。** 模型调用工作台的 `update_plan` 时，运行时校验任务文本和状态，将整份列表写入当前 `Run.plan`，然后记录 `plan.updated` 事件。可用的 SDK `TodoWrite` 在工具完成后也会转换成同一份 `Step[]`。每项任务有 `content` 和 `status`，状态为 `pending`、`in_progress` 或 `completed`。[工作台工具](../server/agent.ts#L649) · [SDK 回执处理](../server/agent.ts#L1790) · [运行记录写入](../server/store.ts#L163)
2. **事件通知前端刷新。** 全局 SSE 把事件送到 `useRunEvents`。前端按 `sessionId` 合并刷新请求，使 TanStack Query 中对应的会话快照失效，并通过 `GET /api/sessions/:id` 读取最新记录。连接重开时会刷新可见数据，活动会话也有已有的快照轮询兜底。计划数据随运行持久化，重新打开会话时可以从同一个接口恢复。[事件订阅](../frontend/src/app/events.ts#L16) · [快照查询](../frontend/src/app/workspace.tsx#L160) · [快照读取](../server/db/repositories/session-snapshot.ts#L24)
3. **组件派生完成数。** `TaskPlan` 用 `completed` 条目数和列表总长度生成标题。三个状态分别使用空心圆、圆点和勾选图标，已完成文字加删除线。读屏软件可获取完整的完成数、折叠状态及每项的状态。停止、出错或收到最终回复时，界面继续展示实际保存的任务状态。[清单组件](../frontend/src/features/chat/task-plan.tsx#L12) · [双语词条](../shared/i18n/catalogs/chat.ts#L553)

## 为什么放在输入框上方

对话正文可独立滚动。任务清单位于输入区域，用户查看长回复时仍能看到当前进度。输入区和旧消息复用同一个清单组件，状态样式和键盘操作保持一致。[输入区渲染](../frontend/src/features/chat/composer.tsx#L347) · [聊天布局](../frontend/src/features/chat/chat.css#L426)

| 会话状态           | 展示规则                                                               |
| ------------------ | ---------------------------------------------------------------------- |
| 有活动运行         | 优先使用活动运行的计划。当前运行没有计划时隐藏输入区看板。             |
| 本轮结束           | 输入区继续展示最近一次运行的计划及其最终完成数。                       |
| 开始新一轮         | 输入区切换到新一轮。旧计划归入原运行对应的最后一条助手消息，默认收起。 |
| 切换会话或重新打开 | 从所选会话的快照恢复任务状态，折叠状态按当前视图重新初始化。           |

`SessionChat` 选定输入区使用的运行，并将其 ID 传给消息区，保证同一份计划只出现一次。任务内容和状态来自运行快照，展开状态由 React 组件保存。同一运行更新状态时组件继续使用相同的运行 ID，所以用户收起的清单保持收起。切换运行或会话时，组件以新的 ID 初始化。[运行选择](../frontend/src/features/chat/index.tsx#L49) · [消息区展示条件](../frontend/src/features/chat/conversation.tsx#L670)

## 中断后开始其他任务

假设任务 A 做到 `1/3`。点击停止或运行时重启导致中断时，运行结果会标记为「已停止」或「已中断」，`Run.plan` 保留最后一次保存的状态。在同一会话开始下一轮前，输入框上方仍显示 A 的 `1/3`。如果某个条目中断前是「进行中」，它会保留这个状态。查看这项工作是否仍在执行时，以该轮的运行结果为准。[停止与结束处理](../server/agent.ts#L2241) · [重启后的中断恢复](../server/store.ts#L301)

- **A 运行中，普通发送 B。** B 先进入待处理队列，输入框上方继续显示 A。等 B 在同一会话创建自己的运行，A 的清单回到对应的历史助手消息里，默认收起。B 的新运行从空计划开始，等它写入计划后，输入框上方才显示 B 的清单。[消息排队](../server/app.ts#L553) · [新运行初始化](../server/app.ts#L619) · [历史清单](../frontend/src/features/chat/conversation.tsx#L670)
- **A 运行中，用 `Alt+Enter` 实时插入 B。** 插入成功后，B 交给 A 所在的同一个运行，输入框上方沿用这轮清单。模型再次调用 `update_plan` 时，整份清单更新为本轮最新保存的版本。[实时插入入口](../frontend/src/features/chat/composer.tsx#L112) · [计划写入](../server/agent.ts#L649)
- **切到另一个会话执行 B。** 看板读取所选会话的运行记录。切回 A 的会话时，按该会话当时的活动运行或最近一次运行恢复显示。[会话与运行选择](../frontend/src/features/chat/index.tsx#L49)

## 验证与回退

仓库的 Chromium 回归用例覆盖键盘折叠、完成数更新、历史消息归属和会话隔离。桌面验收使用隔离 Electron、真实 SDK 和本地回环模型，验证计划从 `0/2` 更新到 `2/2`、中英文界面和四档窗口宽度。验收环境与结果见执行日志。[浏览器回归](../frontend/src/features/chat/message-actions.test.ts#L906) · [桌面验收记录](../openspec/roadmaps/build-atelier-desktop/task-log.md#2026-11-23--输入框上方的任务清单)

回退时可恢复消息内的原有计划展示。改动范围是聊天组件、样式和词条，运行记录沿用原有 `Run.plan` 字段，已保存的计划继续可读。

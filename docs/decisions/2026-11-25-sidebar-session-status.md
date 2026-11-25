# 侧栏会话状态与已查看结果

会话行左侧用实心圆点表达状态，标题、时间和菜单排列在同一行。圆点悬停提示和屏幕阅读器提供状态文字。切换会话后，后台成功结束或异常的任务各自留下提示。进入对应会话清除提示。等待审批跟随运行状态，打开会话后仍可看到。

- [Herdr 状态概念](https://github.com/herdrdev/herdr/blob/master/docs/preview/website/src/content/docs/concepts.mdx)区分还未查看的完成与已经查看的空闲。[Herdr 桌面 Agent 列表源码](https://github.com/herdrdev/herdr-app/blob/a2e8e3ffa84439d4a245a1e6aa8947ef0dd20a1b/defaults/mods/agents/main.js)在列表里映射状态与视觉标记，点行时聚焦对应终端。
- atelier 已从活动运行查询得到执行、排队、待审批和停止中。用事件流的 `run.finished` 记录后台成功、失败和中断，避免把活动查询暂时缺少结果或主动停止误判为成功。侧栏先显示活动运行，再显示未查看的结果，最后显示空闲。
- 未查看结果以会话 ID 保存在当前 renderer 的 Redux 状态。进程重启会清除提示，历史记录仍可查询。重新建立或预热界面时，事件流从 bootstrap 游标开始，避免把既有历史作为新提示。路由进入会话时清除该会话提示。使用 [React 的 `useEffectEvent`](https://react.dev/reference/react/useEffectEvent)读取已提交路由，切换会话时沿用原有 SSE 连接。

隔离验证覆盖从正在执行的 A 切到 B、A 后台完成、打开 A 清除提示、B 后台异常、待审批不随查看消失，以及当前会话完成和重放事件。核对中英文和窄侧栏的标题、状态与时间。回退 renderer 的事件处理、状态与样式即可恢复旧行为。

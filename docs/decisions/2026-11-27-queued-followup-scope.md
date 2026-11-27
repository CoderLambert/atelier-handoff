# 队列续跑与授权复核

## 问题与依据

SQLite 记录显示上一轮结束后调度器已尝试派发。用该轮 SDK 发现事件的 Skill 标识和版本重建了排队时的两份指纹。原有七项一致，新增两项自动继承的本机 Skill 后，整份授权指纹发生变化。旧版暂停了已排队消息，继续按钮仍拿同一个旧指纹重试。截图中的消息同时展开了摘要和同一份全文。

OpenClaw 的 `followup` 在当前轮结束后逐条派发。锁定参考版本 v2026.11.1 的 `scheduleFollowupDrain` 用独立执行范围重新准入，单条消息走 `drainNextQueueItem`，在途结果不明的记录不自动重放。Atelier 已有 SQLite FIFO、执行槽和 Claude 插话回执，沿用这些路径与各自的权限约定。[OpenClaw 队列](https://docs.openclaw.ai/concepts/queue) · [OpenClaw v2026.11.1 drain](https://github.com/openclaw/openclaw/blob/v2026.11.1/src/auto-reply/reply/queue/drain.ts) · [Atelier Claude 执行决策](2026-11-26-long-task-cli-parity.md)

## 续跑和复核

- 入队时在原 JSON 意图中记录已解析的 Skill 标识。下一轮派发时，只把已列入范围中且当前仍允许的自动 Skill 加入计划。现有指纹仍比对内容版本、已选扩展、MCP、浏览器授权及工作树。仅新增的自动 Skill 留给新消息。已获准 Skill 更新或失效时阻止派发。
- 旧消息按原指纹校验。授权变化的队首提供「复核并继续」，显式确认使用当前范围，重新走原来的准入、执行槽和事务校验。保留原消息、附件、执行模式、模型、预算和请求标识。撤回、结果待确认和普通继续队列分别沿用现有操作。实时插话仍按原兼容性和 SDK 回执判定。
- 展开队列消息时只显示一次正文。状态文案和确认提示提供简中和英文。

## 验证与回退

通过隔离 SQLite 与 HTTP 验证仅新增 Skill 时下一轮自动开始，原有 Skill 版本变化仍暂停，普通继续无法覆盖旧授权。验证显式确认后附件、选择和草稿保留，并且同一消息只启动一次。用真实 SDK 与回环模型交叉验证既有撤销和恢复，真实 Electron 检查展开及复核提示。旧版认识原意图字段并忽略新增字段，回退后恢复严格整份指纹校验。

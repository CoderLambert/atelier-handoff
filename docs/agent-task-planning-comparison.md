# 成熟 Agent 的任务清单与运行进度

调研日期 2026-11-28。参照 Claude Code、Codex、Gemini CLI 和 Cursor 的官方文档、公开源码与本机协议声明。Atelier 部分以当前源码为准。Cursor 的公开证据覆盖产品行为和 SDK、CLI 协议，其桌面界面内部实现仍待核实。本轮验证范围为协议声明和源码，产品界面的相同场景实测留待设计验证。

## 四种实现

| 产品 | 执行中的任务清单 | 工具活动与执行结果 | 执行前评审 |
| --- | --- | --- | --- |
| Claude Code | 有任务工具的会话使用结构化 Task 工具。SDK 通过 `tool_use_id` 关联创建请求与回执，取得任务 ID。进行中的条目可显示 `activeForm`。终端可以折叠清单，清单可跨上下文压缩保留。后台 shell 与子代理有单独的 `/tasks` 入口。不同模型及配置下任务工具的可用性不同。 | SDK 可观察工具调用开头、参数片段与参数块结束。执行回执来自后续工具结果。 | Plan Mode 先读代码并提出方案，批准后开始编辑。 |
| Codex | `update_plan` 使用 `step` 和三态 `status`，整轮更新事件可附带 `explanation`。 | App Server 用独立的 `item/started`、`item/completed` 和命令输出事件传递工具生命周期。整轮结束另有 completed、interrupted 或 failed。 | Plan Mode 返回供审阅的方案文本，运行中清单使用独立工具。 |
| Gemini CLI | 原有 `write_todos` 整表覆盖，支持 blocked、cancelled，并校验最多一个进行中。实验性 `tracker_*` 支持会话内持久化的任务 ID、父子关系和依赖。 | 调度器有独立审批、执行和取消状态。工具进度组件在有正数总量时计算百分比。 | Plan Mode 支持研究、澄清、编辑 Markdown 和确认后执行，执行时可选手动或自动接受编辑。 |
| Cursor | 官方更新日志展示聊天内可动态更新且能表达依赖的待办。 | SDK 分别提供 `partial-tool-call`、`tool-call-started` 和 `tool-call-completed`。CLI 的文件写入结果可带路径、行数与文件大小。公开文档可核实这些事件和字段。 | Plan Mode 生成可编辑方案，用户评审后点击 Build。 |

- Claude 的清单、可用性与事件配对参见 [交互清单](https://code.claude.com/docs/en/interactive-mode#task-list)、[SDK 任务跟踪](https://code.claude.com/docs/en/agent-sdk/todo-tracking#display-progress-in-real-time)、[模型适用范围](https://code.claude.com/docs/en/agent-sdk/todo-tracking#model-availability)。工具参数与执行前评审分别见 [工具流](https://code.claude.com/docs/en/agent-sdk/streaming-output#stream-tool-calls) 和 [Plan Mode](https://code.claude.com/docs/en/common-workflows#plan-before-editing)。
- Codex 参见 [App Server 的轮次与工具事件](https://learn.chatgpt.com/docs/app-server#turns) 和 [Plan Mode 模板](https://github.com/openai/codex/blob/6bfc58a688a73c287da51797d99c3345caecbae8/codex-rs/collaboration-mode-templates/templates/plan.md)。本机 Codex CLI 0.172.0 生成的 TypeScript 协议声明确认了上述事件及可空的 `explanation`。
- Gemini 参见 [待办工具源码](https://github.com/google-gemini/gemini-cli/blob/60f8082b14ffa7f10b608270232f3f57b5abbec8/packages/core/src/tools/write-todos.ts)、[实验性任务跟踪器](https://geminicli.com/docs/tools/tracker/)、[工具调度源码](https://github.com/google-gemini/gemini-cli/blob/60f8082b14ffa7f10b608270232f3f57b5abbec8/packages/core/src/scheduler/scheduler.ts)、[进度渲染源码](https://github.com/google-gemini/gemini-cli/blob/60f8082b14ffa7f10b608270232f3f57b5abbec8/packages/cli/src/ui/components/messages/ToolShared.tsx#L251-L281) 和 [Plan Mode](https://geminicli.com/docs/cli/plan-mode/#how-to-use-plan-mode)。
- Cursor 参见 [Agent To-dos](https://cursor.com/changelog/1-2#agent-to-dos)、[SDK 交互事件](https://cursor.com/docs/sdk/typescript#interaction-updates)、[CLI 输出格式](https://cursor.com/docs/cli/reference/output-format#tool-call-types) 和 [Plan Mode](https://cursor.com/docs/agent/plan-mode#how-it-works)。

## 优先改进任务内容

用户关心的是条目是否准确、范围是否合理。现有系统提示要求复杂任务记录真实计划，`update_plan` 验证条目数量、文字和状态。条目有没有遗漏要求、增加交付物或遵守约束，目前主要由模型判断。[系统提示](../server/agent.ts) · [计划工具](../server/modules/runs/mcp-tools/builtin-tools.ts)

Codex 的公开指令要求把复杂工作拆成顺序合理、可逐项验证的步骤，简单任务直接处理，计划改变时说明原因。Claude 的 Task 工具把简短标题和任务描述分别表示。对 Atelier，优先借鉴拆解规则与完成标准，沿用当前清单的读写接口。[Codex 计划指令](https://github.com/openai/codex/blob/main/codex-rs/models-manager/prompt.md#planning) · [Claude SDK 任务跟踪](https://code.claude.com/docs/en/agent-sdk/todo-tracking)

- 优先覆盖用户要求的目标、限制和交付物。可以加入直接支持交付的必要检查。额外工作留给确认后的计划更新。
- 一条写一个可检查的结果，按依赖排序。根据任务复杂度决定是否建清单与条目数。
- 前置材料缺失时，先读已提供的资料，再确认会影响交付的问题。发现新约束或用户追加目标后，仅更新受影响的步骤。
- 图中的简历场景可拆成两条。第一条是基于现有经历整理 AI 应用前端简历，并生成单文件 HTML。第二条根据原始请求确定验收范围。用户明确要求桌面、移动端与 A4 时，保留三项验证及约定的下载交付。用户只要求单文件 HTML 时，检查文件可独立打开并交付该文件即可。

先用同模型、同输入对照旧版和新版输出，评估需求覆盖、范围外承诺、条目可验收性及缺少材料时的行为。测试样例覆盖简单请求、只读、多格式交付、缺少材料和中途改要求。现有评估框架可承载结果记录。离线替身用于校验接口与记录行为，任务内容的改善由真实模型对照判断。[评估框架](./harness-eval.md)

### 成熟方案怎样提高生成质量

| 公开实现 | 做法 | 对 Atelier 的取舍 |
| --- | --- | --- |
| [Codex Plan Mode 模板](https://github.com/openai/codex/blob/6bfc58a688a73c287da51797d99c3345caecbae8/codex-rs/collaboration-mode-templates/templates/plan.md#L41-L94) | 先做只读调查，查配置、入口或数据契约。交付、约束和重要取舍仍不明确时再向用户确认。正式方案写清边界、失败路径和验收。 | 读取已授权的材料，把未解决且影响交付的问题留给用户。普通清单保留足以执行的粒度。 |
| [Gemini CLI 规划指令源码](https://github.com/google-gemini/gemini-cli/blob/60f8082b14ffa7f10b608270232f3f57b5abbec8/packages/core/src/prompts/snippets.ts#L598-L660) | 先检查涉及模块、数据流和依赖。计划深度按任务复杂度调整。简单改动描述修改和验证，复杂改动补足范围、备选、分期和回退。 | 由需求和依赖决定条目数。小任务可以直接做，复杂任务才细拆，并把前置项放在依赖它的步骤之前。 |
| [GitHub Spec Kit 任务生成](https://github.com/github/spec-kit/blob/f2010547121b3351e4923fe467205079e4593a32/templates/commands/tasks.md#L66-L96) · [一致性审查](https://github.com/github/spec-kit/blob/f2010547121b3351e4923fe467205079e4593a32/templates/commands/analyze.md#L125-L165) | 从规格和实施方案生成任务，按用户故事组织可独立验收的增量。生成后查无任务覆盖的要求、无需求依据的任务、模糊验收和依赖顺序冲突。 | 把双向核对纳入清单生成。原文的每项必做要求都能找到对应步骤，每个步骤都能追溯到明确要求或必要验证。 |
| [Anthropic Agent 评估](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) · [生成和审查分工](https://www.anthropic.com/research/building-effective-agents#workflow-evaluator-optimizer) | 用多个试次衡量变化。客观约束用可复现检查，语义问题用明确评分规则并用人工标注校准。生成和审查分工适用于标准清晰且返修有实测收益的场景。 | 先做质量基线和对照。把单独复核作为实测候选，比较它对复杂计划的收益以及新增的失败模式。 |

这些来源证实了各项目公开的指令、模板或评估方法。GitHub Spec Kit 的一致性审查仍由模型执行，双向映射帮助发现问题，语义正确性仍需评估。

### Atelier 的生成与验收设计

**生成顺序。** 从本轮请求、用户已接受的决策和可读取材料提取交付物、硬约束、必要的验证和未知项。生成前用现有工具核实会改变拆解的事实。缺少关键材料时明确停在哪一步。对明确、低风险的需求直接给出简短清单。生成后对照原始请求和核实的事实做一次逐项核对，合并重复项，去掉缺乏依据或无法执行的承诺。

**首轮对照。** 用相同模型、工具权限和输入比较三版。A 是当前行为。B 增加需求提取、按依赖拆解和提交前的双向核对。C 在 B 上为复杂计划加一轮独立复核，输入是原始需求、已核实事实和候选清单。单独记录哪一版避免漏项或越界，哪些失败由复核引入。方案取舍由未参与调提示词的留出样例决定，耗时和额外调用单列。

| 合成样例 | 可接受的计划内容 | 关键失败 |
| --- | --- | --- |
| 用已有简历重组并交付单文件 HTML | 使用已提供的经历，制作 HTML 并验证可独立打开 | 编造项目或业绩，增加 PDF 交付、发布或未要求的 A4 验收 |
| 同一请求明确要求桌面、移动端和 A4 | 清单覆盖三项验证以及约定的 HTML 交付 | 仅覆盖其中两种视图，或把 A4 检查擅自改成 PDF 交付 |
| 只有目标岗位和格式，缺少简历材料 | 先检查已授权附件或确认材料来源，根据实际资料安排后续编写 | 把不存在的附件当作事实，承诺基于猜测生成经历 |
| 先只读排查登录失败并汇报 | 找到相关入口、核对证据并汇报结论和待确认项 | 安排修改、部署、迁移或提交 |
| 简单操作与临时修改要求 | 简单操作直接处理。新要求只改变受影响的任务和验收 | 为简单任务硬凑清单，或把取消的交付重新列为必做 |

**评分。** 逐项记录必做要求覆盖、范围外承诺、可执行性、依赖顺序和完成条件。违反硬约束、编造关键事实、遗漏明确交付物各自直接判该样例失败，不能被其他高分抵消。允许不同任务措辞、分组方式和可行技术路径。先人工标注代表性样例，再用规则与评分器辅助跑回归。对新旧版本的清单做匿名盲评并交换顺序。现有评估框架的离线模式可验证输入、记录和评分链路。真实模型生成质量需要同条件多轮对照后才能判断。[本地评估框架](./harness-eval.md) · [OpenAI 评估方法](https://developers.openai.com/api/docs/guides/evaluation-best-practices#create-and-combine-different-types-of-evaluators)

## 后续的运行状态与工具适配

1. **先做好工具活动与退出状态。** 运行日志当前从工具块开始生成准备通知，实时状态栏显示本轮总耗时。运行时已经读取 SDK 流，能识别参数片段是否含内容来计算首个有效输出的时间。可以进一步利用同一事件记录该次工具调用最近收到参数的时间，按调用 ID 合并更新。界面分别展示准备参数、等待审批、执行和结果。连续收到片段时显示「正在生成写入内容」，长时间没有信号时显示距最近活动的时间。停止或中断时从轮次终态关闭活动指示，同时保留最后的清单计数。活动提示只需要时间和阶段，参数内容留在原有工具边界。 [流式转录](../server/run-transcript.ts) · [工具准备通知](../server/modules/runs/run-transcript-ledger.ts) · [请求计时](../server/request-timing.ts) · [运行状态栏](../frontend/src/features/chat/run-live-status.tsx)
2. **优先验证原生任务事件的适配。** Atelier 锁定的 Agent SDK 0.3.332 同时声明了 `TodoWrite` 与 Task 工具类型。当前运行时装配工作台 `update_plan` 和 `TodoWrite` 路径，计划字段只保存文字与三态，`TodoWrite` 的活动短语未投影到界面。若推进逐项更新，先在隔离 SDK 中观察给定模型、运行模式与工具配置的实际工具集及成功回执，再评估把原生任务 ID 与活动短语投影到工作台。先用现有整表接口保持兼容，按仓库约定继续以锁定 SDK 行为为基准。 [SDK 锁定版本](../package.json) · [工具装配](../server/agent.ts) · [TodoWrite 回执](../server/modules/runs/tool-hooks.ts) · [任务数据](../shared/types.ts)
3. **把完成条件和工具回执放在对应步骤旁。** Codex 的计划改动说明可供参考，Cursor 的写入回执示范了可点验的结果。对「制作单文件 HTML」可以显示已写文件，对「验证桌面、移动端和 A4」显示对应检查结果，对「交付」显示已发布的下载件。每条关联都应有明确的工具调用、回执或交付物标识。复杂任务需要事前评审时，可单独借鉴 Cursor 与 Gemini 的可编辑方案流程。 [Atelier 交付物写入](../server/artifacts.ts) · [Codex 计划事件](https://learn.chatgpt.com/docs/app-server#turns) · [Cursor 文件回执](https://cursor.com/docs/cli/reference/output-format#tool-call-types)

首轮设计验收可用回环模型连续产生工具参数，分别覆盖只有调用开头、持续有参数片段、等待审批、执行完成及中途停止。逐一检查状态文案、最近活动时间与清单计数。再用锁定的 Claude SDK 版本核实模型实际发出的流事件。

# T01 · 本机载体与 SDK 验证记录

日期：2026-11-18。范围仅为 T01；本记录描述 T01 阶段的事实，将官方文档、已有项目证据、离线测试和当轮真实调用分别标明。

后续 T02—T20 已实施，当前状态见 [本机首版完成记录](local-release.md)。本报告中“页面仍为原型”“后续待实现”等为 T01 阶段状态；原始 HTML/CSS/JS 现完整保存在 prototype/，其哈希仍与本报告的设计基线一致。

**T01 已完成：独立实验工程、14 项离线测试和 7 项真实 SDK 场景通过。** 本批共 7 次 query、8 个输入/续接动作，无追加调用；验证范围为 Node 24.21.0 + Agent SDK 0.3.326 / CLI 2.1.326 + Shunt 0.64.0 + gpt-6.1-sol。生产 SDK 适配、权限服务及 UI 接线仍未实现。

主证据：[环境与约束](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/environment.json)、[逐场景结果](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/results.json)、[离线测试日志](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/offline-tests.log)、[类型检查](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/typecheck.log)、[lockfile 重装检查](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/install.log)。时间戳采用 UTC（2026-11-17 17:48—17:49），本地 UTC+8 对应 2026-11-18 01:48—01:49。环境中的 inferencePerformed:false 指无推理预检阶段，不指后续真实批次。

## 产品目标与现状

atelier. 面向个人开发者，在授权的本机项目内提供对话、代码阅读、受控修改、逐次审批、执行追踪与成果留存。界面需要显示真实进展、待确认操作和可找回的任务结果。

本轮按 README、开发说明、任务清单、HTML/CSS/JS 的顺序阅读。现有 app.js 使用种子数据、localStorage、固定回复、固定差异与模板成果；`schedule()` 在约 1.8 秒后改变模拟状态。会话与运行未拆分，审批只改变前端状态，停止只是清除定时器。后端、数据库、真实文件授权、实际审批与恢复尚未实现。

保留 index.html、styles.css、app.js 作为设计与交互基线。独立实验不会接入或改变页面中的模拟流程。

## 选型与接入路线

推荐本机 **Node 24 LTS + TypeScript + 官方 Claude Agent SDK**，后续由仅监听 127.0.0.1 的应用服务连接现有 Web 界面，采用 HTTP/SSE 和 SQLite 保存与传递运行事实。T01 不建立该服务或数据库，也不引入桌面壳。

用户明确选择的模型路线：

```text
atelier → Claude Agent SDK → http://127.0.0.1:3001（Shunt）
                               → chatgpt-plan / gpt-6.1-sol
```

Shunt 的上游配置使用 OpenAI Responses。SDK 面向本机网关，凭据由 Shunt 保管；不将上游 OpenAI 地址当作 SDK 的 Anthropic endpoint，不复制 OAuth 文件，也不继承当前 Claude Code 会话的其他全局代理。

这条路线已有学习项目可参考：`/home/lambert/Projects/claude-code-demo/src/config.ts` 提供连接配置，`docs/verification.md` 记载了 Read/Edit 等真实测试，`docs/wechat-agent-verification.md` 记载了审批、续接与中断等测试。它们属于已有工程证据，不作为 atelier 已完成的证明；本轮只读参考，未修改该项目、调用其微信服务或使用其目录做文件实验。

Anthropic 官方文档明确不支持经网关运行非 Claude 模型。因此成功结论只能是记录版本下的实测兼容，不能承诺所有 Claude 功能或未来 SDK 版本都适用。

## 已核实环境

| 项目 | 值 | 证据等级 |
| --- | --- | --- |
| 系统 | Linux x86_64，内核 7.2.5-3-omarchy | 本机命令 |
| 实验 Node | 24.21.0，使用本机已有安装 | 本机命令 / preflight |
| npm | 11.19.0 | 本机命令 / preflight |
| Agent SDK | 0.3.326，2026-11-16 发布 | npm registry、安装包与 lockfile |
| 配套 CLI | 2.1.326 | 包元数据及所有真实场景的 sdk.init |
| Shunt | 0.64.0；127.0.0.1:3001 的 health 返回 ok | 无推理 HTTP 检查 |
| 模型 | gpt-6.1-sol | Shunt 配置、SDK init、完成的 assistant 消息均回报此值；不额外推断网关内部服务商行为 |
| 认证 | Shunt 管理 chatgpt-plan OAuth；SDK 使用本机占位认证 | 本轮只读工具与后续真实调用通过；未读取 OAuth 凭据 |

源码与可运行命令见 [实验 README](../experiments/t01-agent-sdk/README.md)。独立安装的 Claude Code 2.1.318 与 SDK 配套 CLI 分开记录，不混用版本结论。

## 官方能力核实

| 能力 | 文档结论 | 实现/验收注意点 |
| --- | --- | --- |
| 运行时 | TS SDK 要求 Node >=18.14.0，通过平台 optional dependency 包含原生 CLI | 精确锁版本，不忽略 optional dependencies；实际 init 版本仍取证 |
| 认证 | 支持 Anthropic API key、Bedrock/Vertex/Foundry 路线，以及自定义 BASE_URL/Bearer token | 当前选择 Shunt；配置存在不等于认证已通过；CLI 订阅登录不自动等同第三方产品认证 |
| 工具集 | tools 指定工具；allowedTools 仅添加自动批准规则 | 本实验仅开启 Read，再按场景增加 Edit/Write |
| 工具事件 | includePartialMessages 提供 stream_event；工具调用和结果可按 ID 关联 | content_block_stop 只是参数生成完毕，不是执行成功 |
| 权限回调 | canUseTool 仅处理需要询问的调用；自动批准的调用不进入它 | PreToolUse 检查每次调用；写入 ask；回调等待并决定单次操作 |
| Hook 异常 | onFailure:block 从 TS SDK 0.3.317 开始支持 | 守卫异常不能默认放行；取消后重新检查信号 |
| 取消 | streaming input 支持 interrupt；AbortController/close 控制 query 与进程生命周期 | 分开验证当前轮结束、审批取消、进程退出；停止不回滚已发生写入 |
| 续接 | resume 使用指定 session_id；continue 选最近会话；fork 复制历史 | 跨进程需要持久 transcript；fork 不复制文件；普通在途 Promise 不承诺恢复 |
| 延后审批 | 新版 hook defer 可结束当前轮，之后继续；活进程 reinitialize 可重新派发待处理请求 | 不等于死亡进程的普通 callback 自动恢复；后续 T08/T11 再设计 |
| 用量 | result 可带 usage/modelUsage/total_cost_usd；续接存在累计口径 | 不重复累加；Codex/ChatGPT 套餐实际计费未知，不套用 Claude 价格 |
| 结构化计划 | SDK 有相关工具/结构化输出能力，但不保证每轮产生可直接展示的计划 | 本轮不开放计划工具；缺少计划时不虚构步骤或百分比 |

## 本轮验证与证据

离线检查已通过 TypeScript 编译与 **14 项测试**，包含路径穿越、相似路径前缀、内部/外部/悬空符号链接、多硬链接、真实基线变化、参数替换、取消/超时/重复批准、工具 ID 关联及文本重复归并。它们只证明测试器和守卫逻辑，不代表模型能力通过。

真实实验使用每批独立临时项目；workspace、外侧哨兵、SDK 状态、原始日志分离。权限决定由测试器按场景给出，SDK 调用与文件变化真实发生。验证只使用合成非敏感文件，不操作实际业务项目。

| 场景 | 状态 / 耗时 | 实际结果与证据 |
| --- | --- | --- |
| 只读与事件 | PASS / 6.475s | Read 结果成功，正确返回只存在于文件内的随机标记，23 个 text delta；目录/指纹不变。[事件](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/readonly.jsonl) |
| 跨进程 resume | PASS / 3.005s | 原进程退出后，新进程以相同 session_id 续接；工具集为空、无工具调用，仍正确恢复标记。[事件](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/resume.jsonl) |
| 拒绝 Edit | PASS / 12.838s | 实际等待并拒绝一次；Edit 结果为错误，文件不变，而整轮正常完成。这证明拒绝操作不等于会话失败。[事件](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/deny-edit.jsonl) |
| 允许 Edit/Write | PASS / 12.927s | 分别批准两次操作；note.txt 为 APPROVED 加换行，新建 created.txt 为 CREATED 加换行，其他文件未变化；工具结果与快照对应。[事件](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/allow-files.jsonl) |
| 审批取消与迟到允许 | PASS / 8.957s | 真实 pending 状态被取消，迟到/重复 allow 被拒；目标和哨兵不变，进程退出码 143，无最终 result。[事件](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/cancel-permission.jsonl) |
| interrupt 后继续 | PASS / 18.511s | 第一轮 terminal_reason=aborted_streaming；同一进程随后返回 CONTINUED，第二轮 completed；最后正常关闭进程。[事件](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/interrupt-continue.jsonl) |
| 生成期间 abort | PASS / 8.770s | 已收到文本增量后 abort，观察退出码 143；无最终 result，文件不变。[事件](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/abort-generation.jsonl) |

### 从本轮实测得到的实现约束

- **取消必须有进程级收尾。** 两次 abort 都以 `Claude Code process aborted by user` 结束读取，进程退出码 143，没有 result。应用不能仅靠 run.finished 的理想路径清理状态；退出、异常与超时也要归入真实终态。
- **应用自己的取消信号必须参与审批。** pending 取消时记录 `appAborted:true`、`sdkAborted:false`。本轮依靠应用 AbortSignal 立即取消审批，未证明仅依靠 SDK 回调 signal 就能及时结束等待。
- **interrupt 与 abort 不同。** interrupt 返回中断回执并产出 aborted_streaming 终态，随后同进程继续成功；abort 结束了 SDK 子进程。
- **费用不能直接展示为实际支出。** 可取得 result 的会话去重后的 SDK 估算累计为 `$0.053508`，但 modelUsage.costBasis 明确为 unknown，两个 abort 场景又缺少最终用量；该数既不是完整账单，也不是实际套餐扣费。实际费用仍为 unknown/null。
- **用量与窗口要标注来源。** allow-files 回报 cacheReadInputTokens=2176；resume 的 modelUsage/成本累计包含前轮，而 result.usage 表示本轮。中断结果的 usage 为 0，但 modelUsage 已有值，不能据此宣称无消耗。SDK 报告的 contextWindow=1000000 与 provider=firstParty 只作为原始字段保留，未验证其代表 Codex 的实际窗口或真实上游。
- **计划能力仍未实测。** 本轮刻意不开放计划工具，未观察到可供产品直接展示的结构化计划；T18 继续保持待办。

调用授权：本批最多 8 次 query/续接，进一步限定最多 8 个输入动作；每次最多 6 轮和 120 秒，SDK 单次软估算 $0.50、整批软估算 $4。SDK 内部循环/重试可能产生多次 HTTP 请求。实际 ChatGPT 套餐额度变化不在 SDK 美元字段中得到可靠反映，缺失值保留 unknown/null。

### 证据复核与基线

[验收复核及源码指纹](../experiments/t01-agent-sdk/evidence/2026-11-17T17-48-05-513Z-2231e8/audit.json) 确认：7 项场景全部通过；resume 使用不同 PID，且前进程先退出；所有非写入场景目录与内容未变，外侧哨兵未变；项目证据与文档未发现当前已知凭据值。该扫描是已知值检查，不是通用秘密检测证明。

审批等待取消到进程退出为 **2014ms**，生成中 abort 到退出为 **2012ms**。这是本次测量，不是未来延迟保证。源码、依赖清单及 lockfile 的 SHA-256 随证据保存，便于判断后续修改是否使本轮结论失效。

原型三个文件的 SHA-256 与实施前一致，视觉与交互基线未改变。本轮没有运行浏览器测试，也没有修改学习项目或现有 Shunt 配置；未提交、推送或部署。

## 限制与后续工作

1. 路径校验和 hook 是应用层约束，不是 OS 强沙箱；本轮未开放 Bash。批准前指纹复核与实际文件打开之间仍存在竞争窗口，后续 T03/T09 需设计正式边界与文件应用机制。
2. 回调测试器不等于产品权限服务：人工 UI、审批持久化、跨窗口幂等、过期与恢复仍属于 T08—T11。
3. 会话历史续接不等于恢复在途运行；进程丢失时应记录 interrupted，不能自动重放有副作用的操作。
4. 本轮没有生产 HTTP/SSE、数据库、附件、成果服务或浏览器验收。SDK 验证通过不等于 A01—A14 全部通过。
5. 缺失 usage/计划不能伪造 0 或完成百分比；实际计价、context window 和 Claude 专属能力不能从模型别名推断。

T01 已按本轮真实证据标记完成；T02—T20 均保持待办。后续优先 T02：明确 Session/Run 与持久化，建立本机服务入口；随后按任务依赖实现只读链路，再接正式审批与文件变更。

## 官方来源

以下来源于 2026-11-18 查阅：

- [npm 当前发布元数据](https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk/latest)
- [Agent SDK Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)、[TypeScript API](https://code.claude.com/docs/en/agent-sdk/typescript)
- [权限流程](https://code.claude.com/docs/en/agent-sdk/permissions)、[审批与输入](https://code.claude.com/docs/en/agent-sdk/user-input)、[Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [流式输出](https://code.claude.com/docs/en/agent-sdk/streaming-output)、[用量](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [会话](https://code.claude.com/docs/en/agent-sdk/sessions)、[会话存储](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [网关支持边界](https://code.claude.com/docs/en/llm-gateway)、[网关协议](https://code.claude.com/docs/en/llm-gateway-protocol)

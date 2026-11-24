# AI 多提交规划

## 问题与范围

原有 AI 提交只读取暂存区并生成一条提交信息。用户期望 AI 分析当前工作树的已暂存、未暂存及未跟踪改动，提出多个有序提交，经用户编辑分组和说明并确认后创建提交。当前仓库中可能已有与本功能无关的未提交内容；开发和验收使用独立临时仓库，不修改用户索引或引用。

## 查阅来源

- [Git status porcelain v2](https://git-scm.com/docs/git-status) 区分索引、工作区、未跟踪和冲突；[git apply](https://git-scm.com/docs/git-apply) 的 `--cached` 只操作索引。
- [Git write-tree](https://git-scm.com/docs/git-write-tree)、[commit-tree](https://git-scm.com/docs/git-commit-tree) 和 [update-ref](https://git-scm.com/docs/git-update-ref) 分别写树、写提交对象与按预期旧值更新引用；引用事务不包含索引或工作区。
- GitHub Desktop 固定提交 `7abdff678e47ebc5b1c3cb60615f79b1bd6a8738` 的 [apply.ts](https://github.com/desktop/desktop/blob/7abdff678e47ebc5b1c3cb60615f79b1bd6a8738/app/src/lib/git/apply.ts) 使用 `git apply --cached` 处理选择的差异；[commit.ts](https://github.com/desktop/desktop/blob/7abdff678e47ebc5b1c3cb60615f79b1bd6a8738/app/src/lib/git/commit.ts) 先撤销现有暂存再按所选内容暂存。该方法不直接满足保留已有暂存语义的要求。
- openai/codex 固定提交 `ded559680df03ebf944d01d8fd19be1debb51d04` 的 [ghost_commits.rs](https://github.com/openai/codex/blob/ded559680df03ebf944d01d8fd19be1debb51d04/codex-rs/git-utils/src/ghost_commits.rs) 使用 `GIT_INDEX_FILE` 构造独立快照，真实索引不被快照操作改写。临时索引本身不解决 HEAD 更新后的暂存语义或跨资源崩溃恢复。
- 沿用 [AI 单提交决策](2026-11-24-ai-git-commit.md) 的工作树租约、索引锁、签名限制及当前 Git hooks 策略。

## 方案与边界

冻结 HEAD、真实索引和工作区，分别表示 HEAD→索引与索引→工作区的变更；不能只读取最终文件内容。模型只能对服务端生成的稳定变更单元提出分组及文案，不具备 Git 执行权。用户确认前不改变真实索引或引用；不忽略未经分析、不支持、冲突或因隐私排除的内容。普通文本在安全可验证时按变更块分组，同一路径的工作区块依赖全部已暂存块；不能安全拆分的变更明确展示并仅按完整单元处理。

服务端根据用户最终计划和快照编译有序提交树，复核分组、依赖及内容，使用独立索引构造提交链，带预期旧值一次更新目标引用。原始索引的剩余暂存语义必须相对于新 HEAD 保持；提交涉及原本未暂存内容时不能简单保留旧索引，否则会出现反向暂存。引用和索引不是单个原子事务，执行前持久化操作 ID、索引备份及目标、引用及对象 ID；中断后按实际状态对账，只在满足归属和旧状态校验时补齐，外部变化或锁归属不明时保留证据并要求人工处理。用户工作区文件不由执行器覆盖。重复确认通过持久 ID 幂等处理，不自动推送。

2026-11-24：实测用户当前数据根已使用早期第 9 版任务表，但其约束尚不包含安全放弃状态。新增独立第 10 版迁移，在事务中保留旧任务记录并升级约束；第 9 版数据库和 WAL 在用户实例切换前需先进行一致性备份。测试同时覆盖早期和已含新约束的第 9 版。

2026-11-24：多提交分析改为先读取本地快照，由用户选择本次模型并主动开始分析。未选择时使用工作台默认模型；该选择不修改聊天草稿或全局配置。请求按选定模型的来源使用现有 Shunt/Magpie 网关与认证，不接受客户端提供网关地址；已发起分析的模型 ID 随结果返回以供显示。多批分析仍共享既有 120 秒上限，未声称可以保证大工作区按时完成。

## 2026-11-24：批次分析恢复

多批串行分析共用 120 秒，任何一批或最终整理失败都会丢弃已验证的分组。界面的通用错误覆盖多种原因，单凭“已分析 0 项”不能确定是超时。目标是逐批保留已验证结果，只重试未完成的部分，并保留用户编辑；敏感、冲突和不支持的单元仍需明确处理。

会话绑定实际认证令牌的进程内随机密钥 HMAC，而非保存令牌；凭据变化后拒绝续跑。容量不足时只淘汰已完成的空闲会话，未完成会话在其有效期内保留，容量耗尽时明确拒绝新分析。旧 API 调用可以省略分析 ID，但连接中断后无法凭 ID 取回结果；当前界面在请求前生成 ID。

参考 [AbortSignal.timeout 与组合取消](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static)；[LangGraph checkpoint 恢复机制](https://deepwiki.com/langchain-ai/langgraph/4.1-checkpointing-architecture) 将成功步骤的结果与恢复点关联，失败步骤可续跑。该参考仅用于恢复设计，未在本项目中运行或引入依赖。相比单纯延长全流程期限，采用有界逐批期限和短期内存分析会话，绑定项目、工作树、快照、模型与披露策略，保留完成批次；运行时重启后不保证恢复。全局整理失败保留批次结果，继续受完整性和依赖检查约束。仍须验证竞态、重试去重、敏感内容边界和真实 Git；若不能证明这些边界，应停止使用恢复结果而不是提交不完整计划。

## 验证与回退

以真实 Git 和隔离数据根覆盖部分暂存、同文件分块、排除、冲突、签名、竞态、重复请求及引用推进和索引发布之间的强制中断；本地模型替身验证输出归属和协议。实际桌面分别检查中英文、亮暗主题与分组确认。若不能证实索引恢复和用户改动保全，阻止执行入口并保留单次暂存提交作为回退；不得以仅有静态测试代替真实 Git 故障测试。

## 2026-11-24 · 先规划再审查，独立判断凭据披露与提交

已复现两个问题。弹窗收到本地快照就挂载编辑器，尚未分析的单元全部被计为待处理。旧凭据正则只看赋值关键字和右侧字符数，文本补全的普通引用、函数调用和明确的测试占位值均会命中。删除行和上下文中检出的值同样会封锁本地提交。用户截图中其余凭据提示的真伪仍未逐项核对。

- [Git 差异文档](https://git-scm.com/docs/git-diff) 区分新增、删除和上下文。[kpdecker/jsdiff v9.0.0 的 `structuredPatch` 与 `formatPatch`](https://github.com/kpdecker/jsdiff/blob/v9.0.0/src/patch/create.ts) 在内存保留两侧坐标，将零长度范围的序列化差异留给格式化器。沿用当前冻结文件与已验证的 Git 变更块。
- [Yelp/detect-secrets v1.5.0 的 `KeywordDetector.analyze_line`](https://github.com/Yelp/detect-secrets/blob/v1.5.0/detect_secrets/plugins/keyword.py) 按文件语法选择字面值匹配规则。[同版本的启发式过滤](https://github.com/Yelp/detect-secrets/blob/v1.5.0/detect_secrets/filters/heuristic.py) 单独识别间接引用和模板。借鉴按值及语法识别的方法。其 Python 扫描器及允许列表行为与本应用的封闭请求边界和打包环境不同。
- [gitleaks/gitleaks v8.30.0 的 `GenericCredential`](https://github.com/gitleaks/gitleaks/blob/v8.30.0/cmd/generate/config/rules/generic.go) 将值形状、熵与精确例外结合。独立进程或仓库扫描模式会增加桌面发行依赖，仍需把输出对齐到冻结层及变更单元。单独依赖熵会漏掉低熵的明文凭据。两套上游实现仅阅读源码，未在项目中执行。

选择在 Node 运行时按冻结文本两侧扫描。常见固定格式优先于通用字面值判断。通用判断区分常量与普通引用、调用及少量精确占位符。检测是有界启发式，合成凭据与真实凭据形状相同时同样处理。模型批次和最终整理都跳过命中的单元及不能与之独立规划的依赖，连其路径和 ID 也不发送。对用户仅报告类别及路径或行位置。新增行或路径命中时禁止纳入多提交，删除与既有上下文命中时允许本地分组和逐组预览。客户端没有放行字段。预览和执行都从服务端新快照复核，按编译后的实际提交差异再核对新增内容。受保护路径和 Git 结构限制沿用；二进制内容只使用元数据供模型分组，可按原有整文件规则本地提交。

Renderer 先展示快照摘要和本次模型选择。只有明确开始或续跑才可发推理请求。分析请求带当前快照版本，重试绑定本次解析出的模型与语言；不确定的传输结果优先用原编号只读查询。审查默认展示提交组与组内变更，单列未分析、模型未分组、披露受限和本地提交受限。用户明确选择手动编辑时可提前进入编辑器。部分及最终整理失败沿用已验证批次，保留手动分组、标题、正文和保留决定，新结果仅补入未改动且未归组的单元。分析记录过期后，可以在保留草稿的前提下明确重新分析。工作树变化先重新读取并按仍有效的单元 ID 保留编辑，预览须重新校验。没有数据格式、Electron main 或持久化改动。

先在合成差异和临时 Git 仓库验证普通代码、占位符、固定格式、换行赋值、删除与上下文、分块、跨层依赖、二进制以及伪造请求。再用本地网关覆盖大批量、多批失败、最终整理失败和只读查询。依次运行项目门禁，用独立数据根和 profile 的 Electron 检查双语主路径。实测入口参考 [Playwright Electron](https://playwright.dev/docs/api/class-electron)。如果披露与提交门禁不一致，回退本节的投影、分类和审查流程，恢复更保守的整体拦截，保留独立索引执行与恢复机制。

## 2026-11-24 · 规划响应兼容与诊断

390 项的首批未通过响应校验，界面将多类失败显示为同一提示；现有证据不能区分实际错误，也未实测该模型。当前检查点以原始批次下标保存成功前缀，直接减小批次并复用检查点会造成归属错误。先兼容完整 JSON 的单层围栏并保留严格 schema、ID 和安全检查，将既有失败原因单独展示；不通过修补部分 JSON 或忽略遗漏来伪造完整结果。暂不引入自动拆分重试：它需要新的持久尝试记账及子批检查点，模型失败的真实原因仍未确认，自动重复请求也可能产生额外费用。后续根据明确诊断和隔离验证决定是否添加。

参考 [Messages API 结束原因](https://platform.claude.com/docs/en/api/messages) 的 `end_turn`、`stop_sequence`、`max_tokens` 和流中 `null` 定义；完整非流式输出在保持严格 JSON 和 ID 校验的前提下可接受 `stop_sequence`，`null` 不作为完成凭据。[LangChain JSON 解析器](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/utils/json.py) 可从围栏提取 JSON，但也支持修补不完整 JSON；本功能只接受完整、单层围栏，不采用修补或提取前后自然语言。模型响应、校验细节和凭据不写日志。使用合成回环响应和隔离 Git 验证，无真实模型行为保证；如错误接受无效计划，回退围栏兼容，仍维持严格校验。

## 2026-11-24 · 显示进行中的分析进度

分析 POST 等所有模型请求完成后返回。运行时已经记录通过校验的批次，弹窗缺少只读进度通路，故进行中只有等待文案。用户需要知道正在分析第几批、已完成多少项，以及何时进入最终分组整理。

[TanStack Query v5 的查询选项](https://tanstack.com/query/v5/docs/framework/react/reference/useQuery)和[上游 QueryObserver](https://github.com/TanStack/query/blob/main/packages/query-core/src/queryObserver.ts)支持按活跃查询状态更新轮询定时器。项目锁定 5.108.0，已有会话和浏览器预览使用相同方式。[taskforcesh/bullmq 的 Job.updateProgress](https://github.com/taskforcesh/bullmq/blob/master/src/classes/job.ts)把进度和最终返回值独立保存，并发布变动。借鉴独立进度值，进度仍随应用已有的短期分析会话消失，避免新增存储和队列。复用全局 SSE 会使临时状态进入持久化事件日志，修改分析 POST 为流会改变现有 JSON 恢复契约和测试客户端。

选择在现有工作树 API 增加轻量 GET。只按项目、工作树、分析编号和冻结版本读取内存中的批次数、已验证项数和建议组数，禁止读取或返回差异、提交文案、模型原始输出。开始、恢复和最终结果继续走原有 POST。Renderer 在活跃弹窗内间隔约一秒读取，关闭或完成即停。进度读取不重新扫描 Git，也不发起推理。最终整理单独显示阶段，批次数反映实际验证完成数。回退可移除进度 GET、统计通知和对应视图，继续保留提交计划与恢复行为。

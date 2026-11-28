# 会话任务清单的生成质量

用户希望输入框上方的任务条目准确、合理、可执行。截图显示一份两步清单，但完整原始请求缺失，单凭清单无法确认桌面、移动端和 A4 是否属于用户要求。当前系统提示要求复杂任务使用 `update_plan`，工具验证文本和状态的格式。需求是否覆盖、范围是否扩大、验收是否可执行均由模型判断。

## 取舍

- Codex 的 [Plan Mode 指令](https://github.com/openai/codex/blob/6bfc58a688a73c287da51797d99c3345caecbae8/codex-rs/collaboration-mode-templates/templates/plan.md#L41-L94) 先查事实，再处理会改变交付的歧义。Gemini CLI 的 [规划提示](https://github.com/google-gemini/gemini-cli/blob/60f8082b14ffa7f10b608270232f3f57b5abbec8/packages/core/src/prompts/snippets.ts#L598-L660) 按复杂度选择拆解粒度。借鉴这些规则来生成当前会话中的短清单。
- GitHub Spec Kit 的 [任务映射](https://github.com/github/spec-kit/blob/f2010547121b3351e4923fe467205079e4593a32/templates/commands/tasks.md#L66-L96) 和 [一致性审查](https://github.com/github/spec-kit/blob/f2010547121b3351e4923fe467205079e4593a32/templates/commands/analyze.md#L125-L165) 提供了检查必做要求和额外范围的办法。Atelier 在现有模型轮次中引导生成后自检，沿用当前工具、权限、许可检查及 `Run.plan` 格式。
- 额外模型审查可作为对照候选。只有留出样例显示它稳定减少重要漏项、越界或事实编造时，再评估产品接入。[完整调研与样例](../agent-task-planning-comparison.md)

## 实施与验证

1. 在现有运行入口只对拥有计划能力的会话注入规划指令。工具说明同时明确短清单、范围和验收，模型根据已知事实和实际工作更新状态。简单请求可以直接处理，澄清只针对会影响交付的关键未知项。
2. 用真实 SDK 和回环替身核对模型可见的指令、工具说明、计划回执与持久化。复用 Chromium 清单用例核对现有显示。隔离本机模型用同一组输入对照旧指令、新指令和独立复核候选，分别记录请求或输出无效等实验限制。
3. 回退时恢复原系统提示和工具说明。读取既有清单使用原有字段。

## 验证结果

- `tests/task-plan-generation.test.ts` 经真实 Claude Agent SDK 发起受控只读和 Linux 本机信任两种运行。回环替身记录了模型收到的规则和工具说明，也验证了 `plan.updated` 事件及 `Run.plan`。隔离 Linux Electron 显示清单从 `0/2` 更新到 `2/2`，重载后可读到已保存的清单。
- 对照使用本机 `qwen3.5:9b`、合成任务和固定的采样设置。最初的 Anthropic 兼容调用多数未生成可比较的计划工具参数，改用 Ollama 结构化输出比较文字内容。每对样例用同一请求和输出格式，在审阅内容后核对新旧版本标记。这项试验验证候选文本，实际执行与工具回执由上面的 SDK 测试验证。
- 最终轮覆盖 11 个场景，其中 8 个未用于最初的规则编写。明确要求桌面、窄屏和 A4 的简历场景，新清单写出了实际预览三个场景并在验证后交付 HTML 原件。价格计算样例写出了有效来源、筛选条件和分子分母。修改交付要求的样例仅保留 Markdown，明确了如何汇报关键路径缺口。缺少会议逐字稿时两个版本均追问所需材料，单步翻译均有直接答复。
- 仍有波动。新版在入职流程样例没把已提供的角色名单写进条目，在只读排查样例漏掉明确的脚本路径，简历样例未明确要求下载时使用了代码块交付。新旧指令各有漏项。没有用用户正在使用的模型验证稳定性，独立复核候选也没有得到足以支持增加额外模型调用的证据。
- 另用一个采样种子复测 5 个场景。指定三种验收环境的简历以及价格计算都复现了新版优点。只读排查提到了正确的两个路径。用户取消 A4 后两个版本仍出现“分页”字样，候选清单对这项约束的表述还有波动。
- 原始结果在 `.local/task-plan-quality/`，包括 `holdout-blind.jsonl`、`holdout-key.jsonl`（最终规则 `repeat=5` 与 `repeat=6`）、`compare-final.mts` 与 `electron-candidate.log`。

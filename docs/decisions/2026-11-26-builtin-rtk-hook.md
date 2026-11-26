# 内置 RTK Hook：随包提供，默认启用

状态为已实现，Linux x64 安装态专项与通用发行验收均通过。锁定 CLI 的 `classic.PreToolUse` 插件调用原生 `$.tool.check` 预检原命令，随后由原生 Bash 检查包装命令。项目设置与工具轨迹均从实际安装件核对。对应[桌面路线图](../../openspec/roadmaps/build-atelier-desktop/roadmap.md) P5（运行时工具）与 P7（Linux 安装态）。

当前自动匹配范围及新增验证见 [RTK Bash 命令覆盖](2026-11-26-rtk-command-coverage.md)。

## 2026-11-26 · 锁定 SDK 权限验证

沿用原生 Bash 回环夹具的隔离方式和 `nativeSdkOptions()`，锁定 `@anthropic-ai/claude-agent-sdk@0.3.332`，以 `settingSources: []`、独立的 `HOME` 和 `CLAUDE_CONFIG_DIR` 启动真实 SDK。模型替身每轮只提出一次 Bash。使用临时 Git 仓库，原命令为 `git status`，改写后走路径含空格的本地替身，由系统 Git 执行 `git status --short`。以 `PostToolUse` 的输入、回环模型收到的 `?? sample.txt` 回执和 `canUseTool` 的调用记录判定结果。

| 规则 | 直接提交受规则约束的命令 | 从原命令改写后 |
|---|---|---|
| 原命令 `permissions.deny` | 拒绝 | 执行了改写后的命令 |
| 原命令 `permissions.ask` | 触发询问，夹具拒绝 | 未触发询问，执行了改写后的命令 |
| 改写后命令 `permissions.deny` | 拒绝 | 拒绝 |
| 改写后命令 `permissions.ask` | 触发询问，夹具拒绝 | 触发询问，夹具拒绝 |

保留现有 Hook 的 `allow` 和仅返回 `updatedInput` 两种写法结果一致。用 `disallowedTools` 设置精确规则也复现了原命令拒绝失效，针对改写后命令的拒绝仍有效。16 个案例中有 5 个原命令校验案例失败。SDK 官方 Hook 文档说明 `defer` 会丢弃改写，`canUseTool` 只处理到达询问阶段的调用。锁定 SDK 的公开 `Query` 接口没有对 Bash 两份输入分别预检的入口。继续实施的前提是同一调用能由 SDK 对两份输入落实拒绝与询问，并用这组对照重验。[SDK Hooks](https://code.claude.com/docs/en/agent-sdk/hooks#modify-tool-input) · [SDK 权限](https://code.claude.com/docs/en/agent-sdk/permissions#how-permissions-are-evaluated)

在当前工作区执行 `node --import tsx .local/rtk-hook-sdk-probe.mts` 可复跑，原始输出在 `.local/rtk-hook-sdk-probe.log`，退出码 `1` 表示权限验收失败。`node --import tsx --test tests/native-bash-control-sdk.test.ts` 的现有原生 Bash 回归 2 项通过。自动审批拒绝运行已下载的 RTK 二进制，本轮的权限证据来自真实 SDK、回环模型和本地包装替身。产品改写、界面、打包与安装态验收均未进入实施。

## 2026-11-26 · 候选版本与审批回调复核

npm 的 SDK 与 Linux x64 运行时 `latest`、`next` 均为 `0.3.332`。npm 版本清单和官方发行页没有更高版本，配套 CLI 的 `latest`、`next` 均为 `2.1.332`。本次用已锁定的 SDK 和同一个回环夹具验证两种在审批阶段提供 `updatedInput` 的公开接口。[SDK 发行记录](https://github.com/anthropics/claude-agent-sdk-typescript/releases) · [CLI 发行记录](https://github.com/anthropics/claude-code/releases)

| 改写位置 | 原命令规则 | 实际命令规则 | 结论 |
|---|---|---|---|
| `PreToolUse` | 拒绝和询问未生效 | 拒绝和询问生效 | 原命令规则失效 |
| `canUseTool` | 拒绝和询问生效 | `permissions.deny`、`disallowedTools` 和 `permissions.ask` 命中时均执行 | 实际命令规则失效 |
| `PermissionRequest`，`permissionPrompts: 'none'` | 拒绝和询问生效 | 两种拒绝规则均阻止执行。命中询问规则会终止调用，SDK 未发出第二次审批回调 | 实际命令的询问无法走原审批流程 |

已配置 `canUseTool` 时，探针中的强制询问进入 `canUseTool`。移除此回调并使用 `permissionPrompts: 'host'` 时，无显式规则的改写对照停在原命令的询问，未进入 `PermissionRequest`。`permissionPrompts: 'none'` 让该对照进入 `PermissionRequest` 并执行改写，但同时关闭了宿主审批入口。两条审批阶段改写路径均未达到交付条件。[SDK 审批接口](https://code.claude.com/docs/en/agent-sdk/user-input#respond-to-tool-requests) · [PermissionRequest Hook](https://code.claude.com/docs/en/hooks#permissionrequest)

执行 `node --import tsx .local/rtk-hook-sdk-probe.mts --approval-rewrite` 复跑，共 12 案例，4 项未达到预期。追加 `--approval-host` 可复查宿主模式。原始结果见 `.local/rtk-hook-sdk-approval-rewrite.log` 和 `.local/rtk-hook-sdk-approval-host.log`。保留自动改写的阻塞状态。后续候选须在同一次派发中对两份输入落实拒绝与询问，且在需要批准时把请求交给现有审批入口。

## 2026-11-26 · 托管规则与执行后压缩验证

atelier 当前的原生 Bash 选项没有逐命令拒绝或询问规则。本机信任模式通过 `settingSources: []` 跳过用户和项目设置，SDK 仍会加载托管策略。将两条测试规则分别改由 SDK 的 `managedSettings` 注入后，原命令的拒绝和询问均生效，执行前改写仍各误放行一次。`resolveSettings()` 能读设置快照，但 SDK 声明它不会执行管理员配置的 `policyHelper`，因此空快照不足以证明当前调用没有托管规则。[SDK 类型参考](https://code.claude.com/docs/en/agent-sdk/typescript#resolvesettings)

执行后压缩的探针保留原 Bash 输入。真实 SDK 的 `PostToolUse.updatedToolOutput` 将测试摘要交给回环模型，原命令只执行一次。托管拒绝和询问都阻止执行，失败的 `git status` 保留退出码 128 和错误文本。用 `node --import tsx .local/rtk-hook-sdk-probe.mts --post-output` 复跑。6 项中，4 项执行后压缩对照通过，2 项执行前改写对照误放行。原始日志在 `.local/rtk-hook-sdk-post-output.log`。[SDK Hooks](https://code.claude.com/docs/en/agent-sdk/hooks#modify-tool-output)

RTK OSS v1.2.1 的 `pipe` 支持将已捕获的 stdout 交给内置过滤器，而且无需再次运行 Git。其 Git 专用过滤器各有输入前提：`git-status` 接受 porcelain，`git-diff` 面向统一 diff，`git-log` 按 RTK 自有的提交分隔符解析。普通 `git status`、`git diff --stat` 和 `git log` 输出没有统一兼容性。候选方案是执行后只过滤已验证兼容的 stdout，其余按原样返回，或按需显式调用随包 RTK。采用执行后过滤会改变原决策中的自动压缩范围和轨迹语义。真实 RTK 管道仍需实测。[RTK v1.2.1 pipe 调度](https://github.com/rtk-ai/rtk/blob/v1.2.1/src/cmds/system/pipe_cmd.rs#L258) · [Git 解析实现](https://github.com/rtk-ai/rtk/blob/v1.2.1/src/cmds/git/git_cmd.rs#L2911)

## 2026-11-26 · 采用 CLI 插件的原生权限预检

锁定 CLI 2.1.332 的插件 API 提供 `$.tool.check({tool, input})`。它无副作用，返回原生 `allow`、`ask` 或 `deny`。在本机信任主执行器内加载应用自带的 `classic.PreToolUse`，先调用 `next(e)` 等待原有工作区、工具范围和 Hook 裁决。仅对宿主当次标为可替换的精确 Bash 输入进行预检。原命令必须得到 `allow`，其他结果保留原命令及正常审批；通过后仅替换 command，沿用原裁决，让 SDK 对实际命令执行原生检查。授权后的 `tool.run` 输入固定，`tool.call` 会影响 Bash 后台移交，均不挂接。预检 API 没有执行者身份，子代理保持原生 Bash。管理员禁止插件或先行接管该调用时也保持原命令。此前的执行后压缩方案不采用。[锁定 CLI 插件接口](https://code.claude.com/docs/en/plugins/mods/reference#mods-api-methods) · [原生插件保护逻辑](https://github.com/anthropics/claude-code/blob/main/mods/sec-default/hooks/register.ts)

使用 `node --import tsx .local/rtk-native-check.mts` 验证 13 个单次 SDK 派发场景，包括宿主拒绝、两侧精确规则、询问后允许与拒绝、开关和托管策略接管。包装替身接收 `git status` 原样的两个参数并记录真实启动次数。普通调用一次，否决调用零次。托管规则接管包装时，SDK 在合法的情况下执行原 Git 命令，包装程序不启动。产品测试使用实际运行时、锁定 SDK、回环模型与固定摘要的 OSS 1.2.1，在一轮的多次 Bash 调用之间修改开关，验证 SQLite 轨迹、后台与取消、退出码以及原命令回退。带 23 个提交的固定形态对照中，默认 `git log` 返回 10 条，`git log --oneline -20` 返回 20 条；四种命令的 `rtk bypass` 输出均与原生 Git 字节一致。包装器对 Git 和 bypass 保留调用方的 XDG 配置；统计库、恢复记录、自定义 TOML 过滤和遥测由 RTK 专属变量隔离。Linux 安装态截图、双语命令对及重启结果保存在 `.local/rtk-delivery/electron-final/`。

## 用户操作

- Linux x64 安装包随附 RTK OSS，无需用户安装或配置 `PATH`。模型照常调用 `Bash`；本机信任模式下，符合条件的命令默认自动走 RTK。变化是实际命令被包装、工具回执可被压缩，不承诺原始输出仍可从轨迹找回。
- 「项目扩展」在 Skills、Commands、MCP 之后增加「Hooks」，首版仅列「RTK · Bash 输出压缩」，标注「内置」。项目选「跟随全局 / 启用 / 停用」；全局默认启用，项目未设置即跟随。全局设置改的是默认值，显式项目值优先；界面同时显示设置来源以及「已启用 / 已停用 / 当前不可用」，并说明只适用于本机信任。未打包的平台不显示成已可用。
- 执行轨迹区分模型提出的命令和实际执行的命令；SDK 回执不足以确认启动时，不把计划改写标成已执行。要得到完整输出，可以先关项目 Hook，或显式用 `rtk bypass …`（命令入口须随包可用；不开额外审批豁免）。保持 Read、Grep、独立 Git 工作台、受控命令不变。
- 不增加用户脚本导入、编辑、继承或通用 Hook 市场。不改普通 Claude Code CLI 的 `~/.claude`、Codex 的 `~/.codex` 或仓库 `AGENTS.md`。这里的 Claude Code CLI 是实施者，不是产品配置目标。

## 依据与取舍

- [RTK v1.2.1 Codex 实现](https://github.com/rtk-ai/rtk/blob/v1.2.1/src/hooks/init/codex.rs) 注册 `rtk hook codex`；[Codex 集成说明](https://github.com/rtk-ai/rtk/blob/v1.2.1/hooks/codex/README.md) 展示用 `PreToolUse` / `updatedInput` 原地更新 Bash 输入，而不是拒绝再让模型重试。借鉴这个交互，不复制 Codex 的权限语义。
- [RTK v1.2.1 Claude hook](https://github.com/rtk-ai/rtk/blob/v1.2.1/hooks/claude/rtk-rewrite.sh) 会在部分命中时返回 `permissionDecision: allow`；[`rtk rewrite` 源码](https://github.com/rtk-ai/rtk/blob/v1.2.1/src/hooks/rewrite_cmd.rs) 使用外部权限配置，也可能改写复合命令的一段。本机隔离探针确认 `git status && printf ok` 会被部分改写。不要执行 `rtk init`，不要把上游 hook 的审批结果或任意改写文本送入 SDK。采用 atelier 自己的窄匹配，再调用上游现成的 OSS 过滤器，不自研过滤器。
- [Claude Code Hook 权限说明](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) 区分 `updatedInput` 和权限裁决；在锁定 SDK 的 `sdk.d.ts` 中 `PreToolUseHookSpecificOutput.updatedInput` 是可选字段。`server/agent.ts` 已设置 `settingSources: []` 和独立 `CLAUDE_CONFIG_DIR`，用程序化 `PreToolUse` 做当前轮/工作区/执行者校验并记录轨迹。把 RTK 接到该路径，不注册一个能单独放行的 Hook，不改 SDK 配置隔离。
- [RTK Git 实现](https://github.com/rtk-ai/rtk/blob/v1.2.1/src/cmds/git/git_cmd.rs) 会调整部分 Git 调用的参数和展示：例如 `status` 可走 porcelain，而 `log` 默认展示可能省略合并提交或截短；这不是透明字节压缩。`AGENTS.md` 提示只能影响模型选择，不能保证自动命中；单独改写桌面显示则不能保证模型得到缩短的回执。首版采用已获确认的窄范围 Bash 预改写。

## 实施顺序

1. **先验证实际的 SDK 和 RTK 语义。** 从 `tests/native-bash-control-sdk.test.ts` 的隔离项目、锁定 SDK 与回环模型出发，证明更新 Bash 参数后原有审批和显式拒绝不变。分别测原命令和实际命令的拒绝/询问规则；不能只验证包装过的命令，不能假定规则会理解 RTK 包装。`server/agent.ts` 的现有 Hook 末尾已经有自己的裁决；RTK 不得添加、扩大或替代该裁决。如果锁定 SDK 下不能保持边界，停止自动改写并报告，不把它作为已验证默认交付。
2. **实现小范围匹配、选项和轨迹。** 只允许首版明确列出的、无 shell 语义的单条命令：起步用无参数 `git status`、`git diff --stat`、`git log` 或经逐项验证的固定常用形式（如 `git log --oneline -20`）。精确匹配，不接收任意参数；带引号、环境赋值、路径、机器可读格式、完整 diff、管道、重定向、换行、复合命令、命令替换、已显式调用 `rtk` 或无能力的情况保持原样。用经验证的绝对资源路径包装，正确引用含空格路径；不让用户配置、仓库文件或 shell `PATH` 决定自动改写的二进制。只在实际执行器为本机信任时考虑改写，并经过现有工作区校验、执行者工具权限等检查。保留 Bash 的其他输入、工作目录、工具 ID、后台、超时、取消和回执处理。RTK 缺失、版本不符、探测失败等情况在派发前用原命令；派发后失败不自动重跑。上游可能为过滤内部探测 Git，不把「SDK 只派发一次」误写成「RTK 内部从不多次调用 Git」。
3. **从后端设置到界面。** 在运行时集中解析全局默认与项目覆盖，复用 SQLite `settings` 的现有访问模式；用独立、版本化键，缺省为全局启用/项目跟随，不复用 Skill 继承的字段。按操作定义共享 schema、验证项目归属、提供 GET/PATCH；前端在 `frontend/src/use-query/` 加独立 hooks，复用扩展页标签样式和现有选择控件，补全简中、英文。运行时在进入本次 Bash 前复核有效设置，已派发的命令不会因开关变化而撤回或重跑。轨迹通过既有 `ToolCall` 路径加可选结构化元数据（原命令、实际命令、具体 Hook；确认执行与否由真实回执决定），按历史兼容规则处理，不插入一个假工具调用。
4. **固定 Linux x64 工件并从安装态验收。** 使用 [v1.2.1 OSS Linux x64 发布资产](https://github.com/rtk-ai/rtk/releases/download/v1.2.1/rtk-oss-x86_64-unknown-linux-musl.tar.gz) 和 [发布校验清单](https://github.com/rtk-ai/rtk/releases/download/v1.2.1/checksums.txt)，不使用动态 `latest`、安装脚本、标准版 BUSL 引擎或 API proxy。参考 `scripts/linux/package.mts` 中 Shunt 的固定版本、哈希、许可证和 staged/归档校验流程：在独立临时目录下载、校验、解包，复制经校验的二进制和原版许可证；写入 release、许可证及资源清单，保留可执行位。通过 `process.resourcesPath` 解析安装资源，经现有 main → runtime 启动边界传可信绝对路径，不由 renderer、项目配置或模型传路径。开发/测试用明确的经验证资源，不回落到本机 `~/.local/bin`。RTK 会写本地统计库（上游 [`tracking.rs`](https://github.com/rtk-ai/rtk/blob/v1.2.1/src/core/tracking.rs) 支持 `RTK_DB_PATH`）；验证隔离在 atelier 可写数据根，不写用户原有 RTK 库、不使用本机或项目的自定义过滤器、不启用遥测。不接管用户的全局 RTK。

已核对的归档 SHA-256：`44aa460c4827d206d11405c652832c9f7082edccfbc3a9f15a69a851e8a9e8b4`。隔离解包后 `rtk` 为 `e2950ef652b7e5af115b4573d19ca329a6ee2af758ccaa1de67d5d308694ada0`，`LICENSE` 为 `33f694a31d9f9df3e292a9413a3cdb0113fa72698e2c719f657ff6b53165dcc4`。所选 [OSS 版本为 Apache-2.0](https://www.rtk-ai.app/docs/resources/editions/)。

## 验收和回退

| 层级 | 要证明什么 |
|---|---|
| 单测、存储/API | 默认启用、项目覆盖优先、关闭后下一条尚未派发的 Bash 不改写；项目隔离及重启；不可信输入不能改路径；支持与不支持的命令表；缺失/失效能力回退；历史无新增字段仍可读取。 |
| 锁定 SDK + 回环模型 + 真实 RTK | 原命令与实际命令对应，实际输出和非零退出正确；否决或待审批原样；后台/取消与前台归属；失败无重复派发；受控模式、复合命令和 `bypass` 不被自动改写；若纳入有可能被 RTK 主动限量的日志形式，须验证限制及界面提示。区分真实 SDK 和模型替身，不用付费模型完成这些断言。 |
| Linux x64 实际安装件与隔离 Electron | 无系统 RTK、精简 PATH、独立数据根和 `userData` 仍随包可用；两种语言下可从项目 Hooks 查看并控制状态，A 项目停用不影响 B，重启保留；轨迹显示原/实际命令；应用退出不遗留任务。最终跑 `npm run check`、`npm test`、`npm run build`、`npm run build:desktop` 和相关发行 smoke，保留失败复现。 |

已有证据仅限隔离 CLI：真实 OSS 1.2.1 在临时 Git 仓库运行 `git status`、`git log --oneline -20`、`git diff --stat`，并在指定的 `RTK_DB_PATH` 写库。另一份样本的 `git log -20` 原始 5,733 字节、RTK 3,473 字节，`bypass` 逐字节一致且保留探针退出码 7。这不是桌面、真实模型或安装包验证。不得用该样本估算整个会话的费用降幅。

用户回退：项目设为「停用」；全局关闭使未覆盖的项目恢复原生 Bash。产品回退：可撤回 Hook 注册及资源改动，已存可选设置和轨迹不得造成历史读取失败。若出现权限误放行、无法隔离 RTK 状态、错误退出码丢失或取消泄漏，停止发布该默认集成。已有 Skill 继承的未提交变更不在本任务范围；接手时先看 `git status --short`，保留现有改动，不混合提交，不在活动会话中重启桌面。

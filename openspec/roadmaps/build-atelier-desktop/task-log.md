# atelier 桌面版执行日志

以[路线图](roadmap.md)为阶段索引，以[设计](design.md)为范围和决策依据。每项完成记录填写阶段、变更、验收命令、工件或证据路径、已知限制和回退步骤。状态使用待实施、进行中、已验证、阻塞。完整功能验收后在该段加入简短的「开发过程 review」，记录可合并的任务、可复用的测试证据或可提前结束的排查，并写明下一轮调整。

## 2026-11-25 · 消息页脚精简（已验证并启动）

- 用户消息页脚只保留时间和操作。输入区仍提供运行模式选择，历史权限模式可在执行轨迹查阅。恢复页脚上的模式标签即可回退显示改动。
- 通过类型检查、前端与桌面构建、定向 Chromium 回归。用隔离 Electron 和合成历史验证中英文的本机信任标签、运行模式选择与执行轨迹。沿用原数据目录启动新版，项目、会话、运行和设置指纹一致。结果及截图在 `.local/chat-footer-mode/`。
- 全量测试复跑通过，运行时 679 项通过、1 项跳过，前端 120 项通过。首轮技能代理用例遇到 `Broken pipe`，复跑未复现。复用已有消息操作回归和独立 Electron 夹具，分别覆盖通用运行模式和截图中的本机信任场景。
- 用户消息时间与气泡右缘对齐，操作显示在时间左侧。复用消息操作用例和 Electron 夹具核对中英文、悬停与聚焦。类型检查、全量测试（运行时 679 通过、1 跳过，前端 120 通过）和前端及桌面构建均通过。已切换桌面并核对原数据指纹，证据在 `.local/chat-time-alignment/`。恢复原页脚排列规则即可回退。

## 2026-11-25 · 对话消息布局（已验证并切换）

- 用户消息用随内容收窄的右对齐气泡，文件和附件引用留在气泡内。助手正文沿阅读列展示，执行明细可展开。短时间、运行模式和原有操作收在消息底部，时间提示提供完整日期。沿用[前端设计规范](../../../frontend/DESIGN.md)的主题与阅读宽度。回退本次 renderer 组件和样式即可恢复版式。
- 基线 `1c84f48` 加验收源码哈希。通过 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build` 和 `npm run build:desktop`。运行时 679 项通过、1 项既有跳过，前端 120 项通过。隔离 Electron 使用合成对话，核对中文 1440×900、英文 1280×800 和 540px 窄视口的气泡、换行、键盘操作与执行明细。截图、原始日志和输入哈希在 `.local/chat-message-layout/`。
- 待活动任务结束后正常退出旧窗口，用原数据目录和 Chromium profile 打开新版。3 个项目、19 个会话、130 条运行和 7 条设置记录指纹一致。运行时及本机网关响应均为 200。
- **开发过程 review**。把气泡尺寸和页脚位置断言加进已有的 Chromium 消息操作测试。执行明细展开时页面会随内容变化滚动，复用键盘操作核对折叠及消息按钮获得焦点。下次用同一对话夹具同时验证截图和键盘布局。

## 2026-11-25 · 输入区统一提交与模型设置（已验证）

- 空闲与运行中统一使用发送箭头，去除底部常驻按键和权限提示。辅助技术仍可读取快捷键与权限说明，现有队列区域继续显示入队项目。会话内用同一入口显示模型与推理深度，展开后保留默认模型、手填 ID、固定档位和目录刷新。[决策与回退](../../../docs/decisions/2026-11-25-composer-compact-controls.md)
- `npm run check`、`npm run build`、`npm run build:desktop` 和全量测试通过（运行时 679 通过、1 跳过，前端 120 通过）。隔离 Electron 用替身的目录和运行快照验收中英文组合控件、关闭焦点和提交后队列显示。定向 Chromium 覆盖 IME、现有入队语义、固定档位、手动选择及 Git 多提交中的独立设置。证据在 `.local/composer-compact-controls/`。文件说明独立检查通过 6 份源码。
- 首次构建时用户桌面仍在运行任务。任务结束后随「对话消息布局」的桌面构建一起切换。
- **开发过程 review**。复用现有的消息操作和模型夹具，在同一个测试内验证视觉入口改造与原运行语义。桌面场景仅替换运行快照及目录，避免为纯 UI 调整消耗真实推理调用。

## 2026-11-25 · Git 阅读选区引用与复制路径（已验证并切换）

- 选区通过工具栏动作或 `Alt+Shift+Q` 加入当前同项目会话草稿，卡片显示文件和行号，发送文本带代码原文与版本来源。路径图标复制仓库相对路径。重用草稿保存、去重、删除和长度限额。[决策与回退](../../../docs/decisions/2026-11-25-git-reader-code-quotes.md)
- `npm run check`、`npm run build`、`npm run build:desktop`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 通过（运行时 679 通过、1 跳过，前端 120 通过）。隔离 Electron 用高亮的真实 Git 文件验证反向跨行选择、终止换行的行号、保留输入、重复引用、草稿重载和无自动发送，并用 Clipboard 写入探针核对复制值。中英文入口均核对，证据在 `.local/git-code-quotes/`。独立 `check:headers` 通过 11 份文件。
- 旧窗口正常退出后沿用原数据目录和配置启动新版。项目、会话、运行与设置内容指纹一致，运行时及本机网关均返回 200。
- **开发过程 review**。用现有草稿写入回执同时核对原文、行号和保存，为单次验收提供来源证据。使用真实高亮的反向选区覆盖跨节点与尾部换行，避免单独测试视觉行号就误判正确。

## 2026-11-25 · Git 文件阅读标签（已验证并启动新版）

- 文件变动与历史详情的全文入口统一打开 Git 阅读标签。按工作树、路径、版本和历史提交去重，保留每个阅读位置及返回时的差异选择。编辑区使用行号、语法高亮和独立横纵滚动。窄侧栏用带提示的图标收紧固定入口，打开文件菜单可选被滚出视野的标签。[决策与回退](../../../docs/decisions/2026-11-25-git-file-reader-tabs.md)
- `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`（运行时 678 通过、1 跳过，前端 120 通过）、`npm run build`、`npm run build:desktop` 均通过。隔离 Electron 用真实 Git 比较三个版本，验证去重、原差异筛选、滚动恢复、键盘切换和关闭，以及中文 1440×900 和英文 1280×800 的全窗口/侧栏切换。复制通过 Clipboard 写入探针核对原文。截图、脚本和结果在 `.local/git-file-reader-tabs/`。
- 切换时旧实例已退出，未持有运行时锁。沿用原数据目录和浏览器配置启动，旧项目、会话、运行和设置的内容指纹一致，运行时及本机网关返回 200。11 份文件通过独立文件说明检查。
- **开发过程 review**。从同一 Electron 夹具先抓到弹窗回归，再验证打开、返回和版本隔离。英文窄侧栏截图暴露了活动标签被裁切，补测标签元素和容器边界后再生成交付截图。

## 2026-11-25 · Git 差异阅读与文件定位（已验证并切换）

- 提交详情每个折叠文件只保留标题行，用图标控制展开、折叠和对比模式。单个下拉替代横向文件条，窄侧栏查看提交时差异占满阅读区，关闭返回提交列表。文件变动和提交详情均支持行内与左右对比，前后版本的上下文与变更对齐。[决策与回退](../../../docs/decisions/2026-11-25-git-diff-review-controls.md)
- 文件图标按历史提交、索引或工作区预览完整文本。历史删除项读取第一父提交。文件夹图标通过可信桌面桥定位当前检出的文件。`npm run check`、`npm run build`、`npm run build:desktop` 和全量测试复跑通过（运行时 678 通过、1 跳过，前端 120 通过）。首次最终全量运行里，独立执行器夹具父进程先写出 `ready`，后代尚未写 `ticks` 就被取消。定向复跑和全量复跑通过。
- 隔离 Electron 用真实 Git 验证中文 1440×900 下的 41 文件滚动、键盘展开、批量折叠、左右行对齐、历史快照、删除前内容和窄侧栏返回。英文 1280×800 验证索引、工作区全文和左右对比。系统定位使用真实 IPC 与配对运行时，Electron shell 调用由探针核对路径。脚本、截图和原始结果在 `.local/git-review-controls/`。
- 旧窗口正常退出并释放数据锁后，以相同数据目录、浏览器配置及本机网关开启新版。SQLite 完整性检查通过，3 个项目、19 个会话、124 个运行及 7 项设置内容指纹一致，运行时和网关健康端点返回 200。单批文件说明核对后，19 份源文件通过独立 `check:headers`。
- **开发过程 review**。从截图中的重复入口直接建立 41 文件夹具，一次覆盖大列表、左右对齐和读取真实版本。通过区分提交、暂存和工作区的文本，验证完整预览不会拿错版本。下次先用同一份夹具比较宽、窄布局，省去为滚动单独准备数据。

## 2026-11-25 · Git 按层丢弃与双层差异（已验证并切换）

- 分支 `feat/git-layer-aware-review`，基线 `3b7f45d`。文件行的丢弃动作带变更层。未暂存从索引恢复，已暂存明确同时恢复索引和工作区，未跟踪只删除路径。确认框列出路径与影响。通过现有项目工作树 API 复核目标并串行写入。同文件两层差异可直接切换和同时查看。[决策与回退](../../../docs/decisions/2026-11-25-git-layer-aware-review.md)
- `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`（运行时 677 通过、1 跳过，前端 119 通过）、`npm run build` 和 `npm run build:desktop` 通过。真实临时 Git 仓库覆盖保留索引、重命名、首次提交前新增、过期目标和未跟踪替代文件保护。隔离 Electron 在 1280×800 验证中文双层差异、Esc 后焦点和保留暂存，在 1440×900 验证英文过期提示和恢复 HEAD。复跑入口和截图保存在 `.local/git-layer-aware-review/`。
- 旧窗口正常退出后运行时释放数据锁。沿用原数据根、浏览器配置和本机 Shunt 重开，窗口已映射，运行时与网关 HTTP 均为 200。SQLite `quick_check` 通过，版本及 3 个项目、19 个会话、124 条运行和 7 条设置记录数量一致。文件说明单批只读核对后，独立 `check:headers` 检查 13 份源码通过。
- **开发过程 review**。用分层内容和索引条目校验操作效果，避免将 Git 刷新的索引 stat 缓存当成暂存内容变化。复用现有 Electron 启动夹具，将多语言、撤销确认和文件状态变化合在同一条用户流程。

## 2026-11-25 · Git 分支侧栏重构、提交历史无限滚动与多维检索（已验证并切换）

- 重构 Git 工作区「分支与提交」面板：移除手动加载更多按钮，改用 `IntersectionObserver` 哨兵实现触底自动无限加载（240px 预取、状态锁、轻量骨架屏、初始提交分割线及重试条）；重构左侧栏信息层级，新增固定 HEAD 状态卡片、可折叠分组、选中深绿指示条、微型检出 HEAD 标签、紧凑 Worktree 路径胶囊（悬浮 Tooltip 绝对路径）及远端前缀弱化；增加左侧纯前端 0 延迟即时模糊搜索与右侧防抖（250ms）关键词（信息/Hash/作者）、作者与时间范围多维检索。[技术决策](../../../docs/decisions/2026-11-25-git-history-and-branch-workbench.md)
- 按照 React 最佳实践与单一职责拆分前端组件目录 `frontend/src/features/git/git-history/`（提取 `useGitCommitFilters` 自定义 Hook 隔离状态与防抖副作用，抽取 `GitHeadCard`、`GitBranchGroup`、`GitBranchItem`、`GitCommitRow`、`GitCommitSkeleton` 等纯展示子组件并使用 `React.memo` 优化长列表重绘开销）；后端提取 `queryGitLogCommits` 与时间区间校验，消除重复参数与容错逻辑。
- 自动化检查与测试全量通过：`npm run check` 零错误通过；`npm run check:headers` 对新增及修改源码通过；`node --import tsx --test tests/git-workbench.test.ts`（11 项通过）；`npm run test:frontend`（119 项通过）；`npm test` 全量通过。
- 桌面端平滑切换：通过 `npm run build && npm run build:desktop` 完成生产构建，在当前运行的 Linux x64 Electron 实例中热切换生效，无缝保留既有数据目录与配置。现场核对分支过滤、提交多维筛选、短 Hash 复制及触底无限加载均正常运转。
- **开发过程 review**。针对搜索检索体验，将「前端 0 延迟防御性即时过滤」与「后端 `git log` 全量深层检索」结合，彻底消除了输入过程中的不匹配提交闪烁与网络滞后竞态。拆分出单一职责的 memo 纯组件后，无限滚动滚动过程中仅受影响行重新渲染，性能显著提升。下一轮若有类似列表检索需求，优先沿用本套组合式 Hook 与防御过滤模式。

## 2026-11-25 · 凭据测试样例可预览（隔离验证通过）

- 用临时 Git 仓库复现截图中五个测试文件的凭据命中。测试改用运行时构造的合成样例，以及用于回环认证的明确占位符。生产快照复验五个文件均可进入模型候选和提交预览，独立凭据阳性对照仍同时被这两道检查拦截。复跑 `node --import tsx .local/ai-commit-test-fixtures/verify.mts`，输出为同目录 `red.log` 和 `snapshot.log`。[决策与回退](../../../docs/decisions/2026-11-24-ai-multi-commit.md#2026-11-25--凭据回归测试样例)
- 定向运行五个测试文件，85 项通过。隔离副本按顺序通过 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build` 和 `npm run build:desktop`。运行时 660 项通过、1 项既有 WebFetch 跳过，Chromium 119 项通过。五份源文件说明检查通过。测试、检查、构建输出和候选 SHA-256 均在 `.local/ai-commit-test-fixtures/`。
- 隔离 Electron 打开修正前的计划，预留受限分类触发预览过期提示，然后重新读取工作树。旧分组和标题保留，五个修正的文件回到待分配并批量进入逐组预览，阳性对照继续保留不提交。Electron 验收没有推理请求。原仓库 HEAD、暂存区和运行窗口保留。[桌面状态](../../../docs/evidence/ai-multi-commit/test-fixtures/resolved-zh-1280.png) · [机器结果](../../../docs/evidence/ai-multi-commit/test-fixtures/electron-result.json)
- **开发过程 review**。直接让生产快照读取测试源码，定位到合成输入写法，避免扩大到测试目录白名单。桌面夹具首跑发现批量分组会切换筛选，随后增加等待工作树读取完成的步骤。下次修改凭据回归样例时先跑源码可提交性检查，再用同一临时仓库验证阳性对照和最终预览。

## 2026-11-25 · AI 提交的对话修改（隔离验证通过）

- 首轮可补充分组要求，随原分析会话恢复。审查时继续用当前模型按要求改标题、挪动或合并整批变更，界面列出实际改动并支持撤销。摘要可直接确认，详情可核对逐组差异。摘要确认保留验证结果及操作 ID，执行响应丢失后可重取回执。[技术决策和回退](../../../docs/decisions/2026-11-24-ai-multi-commit.md#2026-11-25--对话修改提交草稿)
- Chromium 首跑缺少可输入的首轮要求，修复后通过首轮请求、对话修改、撤销及原续跑保留编辑断言。API 以临时 Git 和回环替身验证过期快照、伪造受限 ID 及带凭据的补充要求均被拒绝，披露负载也不含受限路径、差异、手写正文或历史里的合成凭据。证据在 `.local/ai-commit-conversation/{red,chromium,test}.log`。
- 验收基线 `3db4a86` 加 `.local/ai-commit-conversation/sources-final.sha256`。隔离副本按顺序通过 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build` 和 `npm run build:desktop`。运行时 660 项通过、1 项既有 WebFetch 跳过，前端 119 项通过。原始输出在 `.local/ai-commit-conversation/{check,test,build,build-desktop}.log`。
- 隔离 Electron 以真实 Git 验证一条请求归并 25 个 OpenWiki 变更并改名、失败后保留要求和手写正文、根据上文追问、逐组预览和撤销。首次提交响应交付中断的实验复现了旧代码的快照过期提示。修复后使用同一操作 ID 和摘要重试，回执恢复，临时仓库最终只增加 3 条确认过的提交。确认前 HEAD 和暂存区字节一致。中英文复验包含英文深色的修改失败提示。网关捕获 2 次规划与 4 次修改请求，均为回环替身。真实模型的分组质量尚未验证。复跑 `node --import tsx .local/ai-commit-conversation/electron-smoke.mts <隔离源码副本> .local/ai-commit-conversation`。[对话摘要](../../../docs/evidence/ai-multi-commit/conversation/conversation-zh-1280.png) · [逐组预览](../../../docs/evidence/ai-multi-commit/conversation/preview-zh-1440.png) · [英文错误状态](../../../docs/evidence/ai-multi-commit/conversation/conversation-en-error-1440.png) · [机器结果](../../../docs/evidence/ai-multi-commit/conversation/electron-result.json)
- 单批只读核对 18 个文件，更新 10 个有效说明，独立 `check:headers` 通过。原仓库 HEAD、暂存区和运行窗口保留，全部验证提交创建于临时仓库。源码与候选逐项比较及文件说明证据位于 `.local/ai-commit-conversation/`。
- **开发过程 review**。把修改失败、只改指定分组、手写正文保全和撤销合并到同一个 Electron 验收夹具。通过 renderer 丢弃首个成功响应复现提交回执丢失，保留真实 Git 执行与权限复核。下一轮新增确认入口时直接复用这个夹具同时覆盖执行已完成和客户端未知状态。

## 2026-11-25 · 手动提交与待决定项批量分配（隔离验证通过）

- Git 文件工具栏新增手动入口，读取冻结快照后打开一组空白草稿，用户可选已暂存、未暂存及未跟踪改动。需要决定视图支持勾选单块、同类里的整个文件、整类或全部待决定项，选定目标后显式应用。每次只修改草稿分组及保留列表，提交继续使用既有逐组预览、确认和恢复接口。包含受限项的选择可整批保留。回退范围为本次工具栏、编辑器及词条。
- Chromium 先复现同文件多块缺少批量选择，修复后在 246 项夹具核对按文件归组、批量保留、受限目标禁用、冲突门禁和手动入口零推理。定向类型、i18n、UI 检查通过。原始输出为 `.local/ai-multi-commit-bulk/{red,chromium}.log`。
- 隔离副本按顺序运行 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build`、`npm run build:desktop`，全部通过。运行时 658 通过，1 个既有 WebFetch 跳过，前端 119 通过。原始输出为同目录 `{check,test,build,build-desktop}.log`。
- 隔离 Electron 使用真实 Git 和回环模型替身，在 AI 计划中一次分配同文件三个变更块；从独立手动入口选中三个块并确认创建一条本地提交，另一文件仍在暂存区，两项未跟踪改动保留。前后推理计数证明手动流程为零，真实模型调用为零。中英文渲染视口为 1280×800 和 1440×900，核对 Esc 后焦点返回手动入口。复跑入口 `node --import tsx .local/ai-multi-commit-bulk/electron-smoke.mts <隔离源码副本> .local/ai-multi-commit-bulk`。[批量分配](../../../docs/evidence/ai-multi-commit/bulk-manual/bulk-assignment-zh-1280.png) · [手动预览](../../../docs/evidence/ai-multi-commit/bulk-manual/manual-preview-zh-1440.png) · [机器结果](../../../docs/evidence/ai-multi-commit/bulk-manual/electron-result.json)。
- 原仓库 HEAD 和暂存区指纹一致。用户运行窗口保留本轮前状态。单批核对 7 个验收源码输入，集中更新 5 份文件说明，独立 `check:headers` 通过。工作区与构建副本的行为源码一致，证据为 `.local/ai-multi-commit-bulk/headers/` 和 `headers.log`。
- **开发过程 review**。同一临时仓库先验证 AI 返回未分组块，再用独立手动入口直接选取并提交这些块，以一条 Git 结果同时覆盖批量分配和暂存保全。Chromium 测试负责混合限制和冲突状态，桌面复验聚焦真实入口与 Git 状态。

## 2026-11-25 · 多提交模型与推理偏好（隔离验证通过）

- 根据用户反馈直接复用聊天输入框的 `ModelPicker`，多提交独立保存上次模型和推理等级于 SQLite settings；跟随默认时保留默认语义，不修改聊天模型。选择中的等级以 `output_config.effort` 发到各批及最终整理；固定路由以网关配置为准，实际上游采纳情况未用真实模型验证。[决策](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- `npm run check`、`npm test`（运行时 658 通过、1 跳过；前端 119 通过）和 `npm run build` 通过。隔离 SQLite 测试覆盖重启后恢复与损坏数据回退；隔离 Git API 测试覆盖默认不继承聊天等级、Shunt/Magpie 请求及改变等级拒绝旧会话续跑。Chromium 测试覆盖保存失败重试、模型切换、固定等级、延迟保存顺序和页面重开。
- 隔离 Electron 关闭并重启，确认 `fixture-picked` / `high` 恢复、三次回环模型请求均带 `output_config.effort=high`，并完成两条测试提交；中文与重启英文截图：[中文](../../../docs/evidence/ai-multi-commit/persisted-model-zh-1280.png)、[重启后英文](../../../docs/evidence/ai-multi-commit/persisted-model-restarted-en.png)。未调用真实模型。用户运行窗口未切换，避免丢失当前状态。
- 文件说明维护批次 `multi-commit-preferences / 未提交工作区` 待补总结：`.local/multi-commit-preferences-headers.sha256` 和 brief 已保存；后台 `codex exec` 被自动审批以可能向外部模型发送私有仓库内容为由拒绝，未绕过。`npm run check:headers` 已通过。
- 开发过程 review：直接复用已有模型选择器和 SQLite 独立设置，避免复制能力映射；先用受控延迟验证快速切换，再以独立 Electron 重启验证持久化，减少对真实数据和付费模型的依赖。

## 2026-11-24 · 重新打开后的多提交复测

- 用户要求重新打开并测试；启动前未发现运行中的 Atelier 桌面或运行时，使用 `npm run desktop` 沿用原有数据目录启动。实际窗口显示原工作区及会话列表；只读 SQLite `quick_check=ok`，2 个项目和 14 个会话可读取。
- 使用 `node .local/multi-commit-electron-smoke.mjs`、隔离项目/profile 和本地回环模型，验证缺失编号提示、继续分析、完整围栏输出、核对和创建两条测试提交，中英文主流程通过。截图和合成夹具在 `/tmp/atelier-multi-electron-B5B9PZ/`；未调用真实模型，也未向外部发送真实工作区差异，因此不能证明 GPT-6-Luna 原问题已解决。

## 2026-11-24 · 多提交响应兼容与诊断（隔离验证通过）

- 完整单层 JSON 围栏及 `stop_sequence` 完成响应经过现有 schema、凭据和 ID 完整性校验后可用；不修复截断或忽略任何变更。网关消息、JSON、分组字段、长度和 ID 错误分别提示；零批失败后可更换模型重新开始。保留已有成功批次与手动编辑，不自动付费重试。[决策](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- `npm run check` 通过；`npm test` 运行时 651 通过、1 跳过，前端 119 通过。后续新增 390 合成项的七批覆盖测试以及 `tsc --noEmit` 通过；`npm run build` 通过。隔离 Electron 使用回环网关先返回缺失 ID，然后返回完整 JSON 围栏，验证明确错误、继续分析、逐组预览及创建两条测试提交；截图：[缺失编号提示](../../../docs/evidence/ai-multi-commit/planner-missing-id-1280.png)。未调用真实 GPT-6-Luna；此次实际失败的具体错误仍未知。
- 开发过程 review：先按失败类别复用本地回环测试，再用隔离 Electron 验证真正入口；旧桌面夹具因界面流程更新而首次失效，改用当前先规划后审查的入口后通过。大批次自动拆分需单独设计检查点和费用上限，不在无真实原因证据时引入。

## 2026-11-24 · AI 多提交实时进度（隔离验证通过）

- 分析中显示当前批次、进度条、已验证变更块和建议组数量。全部批次完成后单独显示最终整理。统计来自运行时冻结分析会话，专用只读查询不重读 Git 或增加推理请求，关闭或分析结束即停止查询。[决策与回退](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- Chromium 先复现只有等待提示，修复后在回执仍挂起时读到批次进度，并验证快照版本、分析编号、查询关闭与推理次数。运行时定向测试 71 项通过，覆盖跨项目、工作树、版本和不同分析编号的进度隔离。原始证据为 `.local/ai-multi-commit-progress/{workflow-red,workflow,server-targeted}.log`。
- 在隔离源码副本依次运行 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build` 和 `npm run build:desktop`。运行时 646 通过、1 个既有 WebFetch 用例跳过，前端 119 通过。全量复验曾有既有 Skill 代理请求体测试偶发 `Broken pipe`，同源码复跑通过。原始输出为同目录 `{check,test,build,build-desktop}.log`、`test-broken-pipe.log`。
- Linux x64 Electron 45.4.1、独立 profile 和回环模型夹具在请求挂起时验证第 1 / 3 批、第 2 / 3 批和已分析 64 / 129 项，随后观察全部 129 项完成并进入整理，整理失败后仍能续跑、保留编辑和本地创建 3 条提交。检查英文单批进度及中文 1280×800、英文 1440×900 视口。真实模型调用为 0。复跑入口 `node --import tsx .local/ai-multi-commit-progress/electron-smoke.mts <隔离源码副本> .local/ai-multi-commit-progress`。[实时批次](../../../docs/evidence/ai-multi-commit/progress/analyzing-zh-1280.png) · [最终整理](../../../docs/evidence/ai-multi-commit/progress/organizing-zh-1280.png) · [机器结果](../../../docs/evidence/ai-multi-commit/progress/electron-result.json)。
- 验收源码与工作区 12 份源码哈希一致，原仓库 HEAD 及暂存区指纹一致。用户运行窗口未切换。单批复核并应用 9 份文件说明，独立 `check:headers` 覆盖 12 份源码并通过。证据为 `.local/ai-multi-commit-progress/{source-receipt.json,headers.log,headers/}`。
- **开发过程 review**。复用 131 项 Electron 夹具，在第二批和最终整理的实际请求挂起时读取进度，避免使用计时推测。发现实时计数和上一版计划的待分析数字会同时出现，调整为分析期间显示进度、返回后恢复原编辑视图，并增加可见性断言。

## 2026-11-24 · AI 多提交审查与凭据误判（隔离验证通过）

- 点击「AI 提交」先读取本地快照，展示变更块总数、可规划数量和本次模型选择。明确开始后才请求模型。审查优先显示提交组和组内变更，未分析、模型未分组和受限项各有状态。续跑绑定快照、模型和语言，断线可只读查询，过期可保留草稿后重新开始。点击预览直接定位到首组差异。
- 区分源码引用、调用、明确占位符和疑似凭据。命中时显示格式和路径或行位置，相关单元及依赖不发给模型。新增行与路径命中阻止本流程提交，删除与既有上下文命中可按本地预览确认。预览与执行重新校验冻结单元和实际提交差异。保留受保护路径、二进制仅发送元数据、冲突索引和跨层依赖限制。[技术决策与回退](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- 合成差异复现旧判断。普通引用、两种函数调用、`test-token`、可能凭据字面值和 PEM 标记均判为不可发送，删除与上下文也判为不可发送。本机原始记录 `.local/ai-multi-commit-review/baseline-privacy.log`。
- 实施前，合成凭据回归因普通引用误判和含空格字面值漏判失败，Chromium 回归因初始状态缺失失败，见 `privacy-red.log`、`workflow-red.log`。定向修复后，真实 Git 与回环网关共 15 项通过，Chromium 审查流程通过。凭据场景覆盖删除和上下文仅供本地审查、隔离同文件块、暂存依赖、二进制只传元数据以及预览和执行双侧拒绝伪造选择。浏览器覆盖 245 个单元只留下 5 项决定、失联只读查询、最终整理失败及过期后保留编辑。证据位于同一目录的 `privacy-api.log`、`workflow-chromium.log`。
- 基线 `0d3b184` 加工作区源码校验值。最终在隔离源码副本依次运行 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build`、`npm run build:desktop`，均通过。运行时 646 通过、1 个既有 WebFetch 用例跳过，前端 119 通过。完整输出为 `.local/ai-multi-commit-review/{check,test,build,build-desktop}.log`，源码副本位置见 `candidate-path.txt`。较早的定向运行把网关探活误计成推理，改按 `POST /v1/messages` 核对；失败输出保存在 `server-targeted.log`。
- Linux x64 Electron 45.4.1 使用独立 Git 仓库、运行时数据根、profile 和回环网关。131 个变更块中 129 个可规划。第二个分析批次和最终整理各注入一次 HTTP 503，分别只重试失败的批次及整理请求。保留标题、正文、手动分组和明确保留项。首轮确认前 HEAD 与暂存区逐字节一致，确认后生成 3 条提交，留下 2 个明确保留的文件。检查中文 1280×800、1440×900 与英文深色 1920×1080 渲染视口，实际原生内容窗口 2560×1440，并核对预览首组差异可见及 Esc 焦点恢复。[机器结果](../../../docs/evidence/ai-multi-commit/planning-review/electron-result.json) · [选择模型](../../../docs/evidence/ai-multi-commit/planning-review/setup-zh-1280.png) · [最终整理失败](../../../docs/evidence/ai-multi-commit/planning-review/partial-zh-1280.png) · [逐组预览](../../../docs/evidence/ai-multi-commit/planning-review/preview-zh-1440.png) · [英文审查](../../../docs/evidence/ai-multi-commit/planning-review/review-en-dark-1920.png)。
- Electron 复跑入口为 `node --import tsx .local/ai-multi-commit-review/electron-smoke.mts <隔离源码副本> .local/ai-multi-commit-review`，原始输出 `electron.log`。首轮平铺窗口未保持预设几何，随后按实际原生内容边界设渲染视口，断言截图尺寸。旧输出保存在 `electron-native-first.log`、`electron-viewport-first.log` 和 `electron-before-preview-scroll.log`。真实模型分组质量、本机截图中其余凭据提示以及安装件均未在本轮验证。
- 用户窗口保留运行，真实仓库 HEAD 和暂存区指纹一致，164 个任务外原有改动路径的内容一致，未暂存、提交或推送任务改动。当前会话无 OpenWiki MCP，本次取舍和验证已记录在源码决策与执行日志。文件说明单批按 16 个输入的哈希核对，应用 4 份说明，独立 `check:headers` 通过。输入、应用记录和工作区对照见 `.local/ai-multi-commit-review/headers/` 和 `worktree-preservation.json`。
- **开发过程 review**。合并真实 Git 和回环网关验证，让披露、预览及执行共用同一组凭据与跨层变更。桌面先按实际内容尺寸校验，再断言第一组差异进入可视区域。后续在第一次桌面复验就把视口、截图尺寸和差异可见性三项纳入同一断言。

## 2026-11-24 · 多提交问题分类（隔离验证通过）

- 多提交弹窗扩展为桌面大尺寸，默认按原因分开列出待处理项，支持查看全部、已保留及逐类批量保留，保留逐项撤回和提交前预览。大量项目默认收合；有冲突时即使保留也提示先解决冲突。沿用服务端安全检查。
- `npm run check`、`npm test`（运行时 643 通过、1 跳过，前端 119 通过）和 `npm run build` 通过；调整模型设置区高度后 `check:ui`、构建与隔离 Electron 验收通过。浏览器替身覆盖 240 个已分组项与凭据、冲突、可提交的完整文件和普通待分配项，检查分类、批量保留、逐项恢复与冲突门禁。隔离 Electron 使用本地网关及合成文件验证分类和两次提交，截图：[问题分类](../../../docs/evidence/ai-multi-commit/issue-groups-1280.png)。未操作用户窗口或真实模型。
- 开发过程 review：复用现有大批量浏览器和隔离桌面夹具；桌面截图暴露设置区占高问题，缩小后复测，后续提前在 1280×800 核对可见区域。

## 2026-11-24 · 多提交待分配提示（隔离验证通过）

- 在长变更列表提供“只看待分配”筛选，底部显示不可预览或提交的原因、数量和定位入口；受保护且已保留的项不计入待分配。过期计划会禁用预览并提示重新打开。筛选不修改用户计划。
- `npm run check` 与 `npm test`（运行时 643 通过、1 跳过；前端 119 通过）在最后调整中英文数量文案及补充排除项测试之前通过；随后受影响浏览器测试、前端类型检查、`check:i18n` 和 `npm run build` 通过。隔离 Electron 用本地模型替身验证两个待分配项的底部提示、筛选和提交主流程，截图：[待分配提示](../../../docs/evidence/ai-multi-commit/unassigned-reasons-1280.png)。未读取用户正在编辑的计划或关闭其窗口。
- 开发过程 review：优先复用已有多提交浏览器及 Electron 夹具；列表筛选与底栏提示复用同一归属判定，避免两套计数发生偏差。

## 2026-11-24 · 多提交分析超时与续跑（隔离验证通过）

- 分析按批次独立限时；成功批次的分组保留在绑定项目、工作树、快照、模型和披露策略的短期内存会话中。失败后可继续剩余批次，最终整理失败时可保留批次分组。超过分组上限时明确提示并保留未分配项。运行时重启或会话过期后需重新分析。[决策](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- 独立审查发现连续断线后的重复分析、追加分组超限、全局整理遗漏曾分析但未分配单元的问题，已分别修复；`frontend/src/features/git/git-multi-commit-model-picker.test.ts` 使用本地替身验证编辑保留、续跑及连续断线恢复。`tests/git-commit-analysis-sessions.test.ts` 与 `tests/git-commit-planner.test.ts` 覆盖逐批时限、恢复、会话隔离及敏感内容；`tests/git-multi-commit-api.test.ts` 使用隔离真实 Git 仓库验证接口。未调用真实模型。
- 项目 `npm run check`、`npm test`（运行时 641 通过、1 跳过；前端 119 通过）在最后一轮界面审查修复前通过；最终修复后受影响前端测试、前端类型检查及 `npm run build` 通过。隔离 Electron 的原有主流程验收通过，覆盖两次提交、双语和 1280×800/1440×900；本次恢复交互由隔离 Chromium 替身测试，未在 Electron 中实测超时。
- 后续审查补充凭据切换与容量边界：会话使用进程密钥 HMAC 绑定实际认证令牌，凭据变化时拒绝复用；容量耗尽时保留未过期的未完成会话并拒绝新会话。`node --import tsx --test tests/git-commit-analysis-sessions.test.ts tests/git-commit-planner.test.ts` 共 59 项通过；修改后 `npm run check`、`npm test`（运行时 643 通过、1 跳过；前端 119 通过）与 `npm run build` 通过。旧 API 可省略分析 ID，断线后无法凭 ID 找回；当前界面已在请求前生成 ID。
- 开发过程 review：复用真实 Git API 和 Electron 夹具，使用独立审查针对续跑编辑合并及连续断线发现边界问题；后续应尽早把批次失败和界面编辑合并到同一端到端夹具。

## 2026-11-24 · 多提交分析模型选择（已验证并切换）

- 多提交弹窗先读取本地工作树快照，用户选择工作台默认、目录模型或手动输入模型 ID 后才发起 AI 分析；该选择仅影响本次弹窗。请求按所选模型分流至已配置的 Shunt 或 Magpie，服务端返回本次尝试的模型 ID，不改变聊天草稿或全局配置。处理中隐藏旧超时提示，覆盖率文案区分已完成项与全体元数据项。[决策](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- 用户反馈 373 个变更单元仅完成 64 项后超时：源码固定每批最多 64 项并顺序分析，整个多批流程共用 120 秒上限；64 是完成批次累计，不能仅凭截图断言是哪次请求慢。本次未调整限时或声称换模型一定能避免超时。
- `npm run check` 通过；`npm test` 运行时 630 通过、1 跳过，前端 119 通过；`npm run build` 通过。`tests/git-multi-commit-api.test.ts` 用双本地网关验证默认/所选模型、Shunt/Magpie 切换及不修改配置；`git-multi-commit-model-picker.test.ts` 覆盖选择前无推理、超时重试提示和草稿保留。真实 Electron 隔离测试验证选择前无模型请求、指定模型实际到达回环网关、默认模型回退及两条提交，检查中文/英文和深浅主题。[模型选择截图](../../../docs/evidence/ai-multi-commit/model-picker-20261124.png)；脚本 `.local/multi-commit-electron-smoke.mjs`。未调用真实付费模型。
- 已检查旧窗口没有已分组的计划和活动会话任务，正常切换新版；数据库仍为 v10、`quick_check=ok`，2 个项目及 14 个会话可读取。未触碰用户工作区暂存或提交。
- 文件说明维护批次 `multi-commit-model-selection / 0d3b184 + 未提交工作区` 已完成；7 个输入文件的哈希均匹配，已核对并应用其中 4 个文件的说明建议，`npm run check:headers` 通过。输入校验值、brief 和建议保存在 `.local/model-selection-20261124.*`。本功能尚未提交。
- 开发过程 review：复用多提交的隔离 Electron 验收脚本及本地双网关，避免重复对实际模型发请求；先直接读取批处理与时限代码，再解释截图，不将超时误判为某个来源故障。

## 2026-11-24 · AI 多提交规划（已验证并切换）

- 将单条暂存提交扩展为扫描已暂存、未暂存和未跟踪改动，生成可编辑的有序提交分组，核对逐组差异后确认；支持可安全拆分的文本块、明确排除及同文件两层依赖。高置信凭据变更不会发给模型或自动提交。签名、游离 HEAD、分离索引和无法安全处理的文件有明确限制。[决策与回退](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- 服务端冻结工作树/索引/HEAD，使用临时索引构造提交链，持久化 SQLite 操作和独立索引日志，按预期旧值推进分支。真实 Git 测试覆盖已暂存与工作区内容不同、重复确认、强制中断后恢复和两阶段安全放弃。独立审查发现 JSON 凭据过滤及 journal/SQLite 双写间中断两项问题，修复后分别由 `tests/git-commit-plan-privacy.test.ts`、`tests/git-multi-commit-api.test.ts` 和 `tests/git-commit-plan-recovery.test.ts` 回归。
- 数据库新增 v10 迁移，以隔离 SQLite 测试覆盖旧四态 v9、新式 v9、WAL、记录/rowid 保留和故障回滚；迁入测试覆盖日志/备份校验。自动权限审查最初拒绝复制真实数据库；随后用户明确授权将 `.data/atelier.sqlite` 一致性备份至 `.local/atelier-v9-backup-20261124/atelier.sqlite` 并重启。备份 `quick_check=ok`、版本 9；升级后版本 10、`quick_check=ok`，2 个项目、14 个会话、250 条消息和 122 次运行数量保持一致。
- `npm run check` 通过；`npm test` 运行时 621 通过、1 跳过，前端 118 通过；`npm run build` 和 `npm run build:desktop` 通过。Electron 隔离测试使用真实桌面、临时 Git 仓库及本地模型替身：自动生成两组、编辑第一条、预览并创建两条提交；再检查英文深色界面。未调用真实付费模型。截图：[中文 1280×800](../../../docs/evidence/ai-multi-commit/zh-light-1280.png)、[中文 1440×900](../../../docs/evidence/ai-multi-commit/zh-light-1440.png)、[英文深色 1440×900](../../../docs/evidence/ai-multi-commit/en-dark-1440.png)。测试脚本保存在 `.local/multi-commit-electron-smoke.mjs`。
- 已启动新版用户实例，真实窗口显示原有项目和会话；升级前数据库备份保留在上述私有路径。真实用户工作区未进行 AI 模型调用、暂存或提交。
- 文件说明维护批次 `ai-multi-commit / 0d3b184 + 未提交工作区` 已完成；20 个输入文件的校验值均匹配，只读整理建议对其中 6 个文件做说明更新，已核对并应用。`npm run check:headers` 通过。输入校验值、brief 与建议保存在 `.local/multi-commit-20261124.*`；尚无本功能验收提交，不将基线提交冒充本次提交。
- 开发过程 review：用相同的真实 Git 恢复夹具覆盖执行、崩溃和 HTTP 入口，避免只看模拟结果；复用隔离 Electron 的双语截图。之后先确认实际数据库版本再定迁移版本，避免运行中的旧版 v9 与开发中调整约束产生冲突；继续顺序运行共享构建目录的检查。

## 2026-11-24 · Git 面板页面滚动排查

- 使用隔离数据根启动本地服务和 Vite，在 2000×1125 视口打开本项目 Git 面板（129 条文件变动）。浏览器测得文档 `scrollHeight=6373`、视口 `clientHeight=1126`，`.git-list` 本身仍按预期可滚动。
- 129 个列表项里的 `.sr-only` 元素使用绝对定位，原定位参照为 `body`。为 `.git-list` 增加 `position: relative` 后复测：文档高度和视口均为 1126，尝试滚动外层时 `scrollY=0`；文件列表内容高度 6259、可视高度 980，可滚动至底部。`npm run check:ui` 通过；验证使用隔离数据根的 Vite 页面，未在 Electron 窗口验证。

## 2026-11-23 · 会话工具证据恢复

- 用户反馈后续细化剧情时重复抓取网页。排查真实本地 transcript：旧轮央视 WebFetch 已有剧情，新 SDK 上下文的检查点只有工具 ID 和搜索来源，没有已抓取网页与结果的关联。
- 将 SDK 兼容指纹改为版本化的执行范围身份，同模式且兼容时继续使用原生 transcript；停止、异常和旧指纹仍走保守恢复。重建检查点区分搜索发现与成功抓取，并在允许时提供旧回执读取入口。[设计与回退](../../../docs/decisions/2026-11-23-session-evidence-recovery.md)
- `tests/session-evidence-resume.test.ts` 通过真实 SDK 0.3.326 与本地回环模型验证：首轮原生 Read 取得随机事实，删除源文件并重启后切换 effort，下一轮实际请求仍含同一工具结果；自动审批切回逐次审批后写入被拒绝。`tests/session-forks.test.ts` 核对分支截点与续接；`tests/session-checkpoint.test.ts` 覆盖抓取索引、失败、截断、预算和权限隔离。所有模型响应均为本地替身，未验证真实模型自主选择，也未进行真实 WebFetch 网络回环。
- 最终 `npm test`：运行时 303 通过、1 跳过，前端 112 通过；`npm run check` 与 `npm run build` 通过。曾并行启动 build 与 check，Markdown 包生成目录发生竞争而导致类型检查失败，顺序重跑通过。经用户明确授权后正常关闭旧窗口并打开新版；确认窗口已映射、运行时和网关监听原数据目录，本机 SQLite 中原项目、会话及消息仍可读取。未实测桌面界面中的会话交互。
- 开发过程 review：先比对真实历史和 SDK 文档确定缺失位置，用 SDK 回环直接检查第二轮 messages，避免仅按模型回答判断。下次顺序执行共享生成目录的构建和检查；停止后跨轮网页回查及真实桌面体验仍需独立实测。

## 2026-11-20 · 阶段 0 / 规划与开发规则

- 判定点①选择直接生成。个人已有产品，已有原生 Electron、独立运行时与 Web 入口的实测和权衡，用户已确认 Linux 先交付、其他平台各自验收。无商业化信号。新建 `build-atelier-desktop` 包。
- 本轮基线 `1639970`。历史 release 文档与 `.local` 里的测试记录供追溯。P1–P9 均为待实施，后续从 P1 的安装态样包开始。
- 仓库开发指导位于 `CLAUDE.md` 和 `.claude/skills/atelier-electron/SKILL.md`。验证和评审结果在本节追加。

## Review 处置

本轮 `20261119T165520Z-j95yqR`。strategy 和 plan-eng 两镜均以独立上下文按 Sonnet / medium 只读复核三件套，2026-11-20 收齐两份结构化意见。用户选定仅会话内复核，外部复核记作 `runner=none reason_code=user-waived-external`。

| 来源 | 问题 | 处置与证据 |
|---|---|---|
| strategy | P1 的规则与 Skill 应先实际就位 | 采纳。`CLAUDE.md`、`.claude/skills/atelier-electron/SKILL.md` 和 `.claude/agents/atelier-desktop-reviewer.md` 已落地。Skill 结构校验通过。以新的临时配置目录启动 SDK，仅做本地发现，`supportedCommands()` 和 `supportedAgents()` 找到二者，模型请求数为 0。 |
| strategy | 成功升级后新产生的数据如何回退 | 采纳。[设计决策 4](design.md)规定保全新版副本、列出新增记录和导出，用户确认后旧版打开升级前数据。P7 使用新增成果的场景验收。 |
| plan-eng | 各控制入口要核对调用者身份 | 采纳。[设计决策 3](design.md)定义 renderer、API、私有 sidecar 信道的不同信任依据。[P2](roadmap.md)增加未授权客户端和过期连接验收。 |
| plan-eng | 人工接管时在途动作可能无法确认 | 采纳。[设计决策 3](design.md)补充交接中、执行代次撤销、结果待确认和重建目标的恢复流程，P4 注入迟到动作。 |
| plan-eng | 性能和恢复基线应形成发布门槛 | 采纳。[P1 与 P2](roadmap.md)分别冻结安装件预算和恢复时限，由 P7 在相同条件下复测。 |

## 阶段 0 验证

- Electron Skill 来源选择已查阅社区候选和锁定源码。`mindrally/skills` 的 `electron-development` 在目录查询时约 1,493 次安装，仓库约 310 stars。核对版本 `7682ca77710e0971eab4e0ae5dddfa281aea0ba5` 后，采用以 Electron 官方文档为源的项目专用指导，覆盖原生视图、接管和发行验收。
- `quick_validate.py .claude/skills/atelier-electron` 输出 `Skill is valid!`。默认 Python 缺 `yaml`，最终使用带有 PyYAML 的解释器完成校验。SDK 隔离发现输出 `skill=true, reviewer=true, modelRequests=0`。此证据覆盖配置加载；行为效果在 P1 按真实变更复核。
- 判定点②：两镜五项已逐条处置，近期阶段均回指设计，正式文档未引用历史存档。直接生成路径无备忘对账事项。P1 至 P9 为待实施。


## 2026-11-20 · P1 / 可运行的 Linux 发行样包 · 已验证

- Arch/Omarchy x86_64 包 `dist/linux/atelier-0.2.0-1-x86_64.pkg.tar.zst`，SHA-256 `94fea6119c96535163ad86143aecb7a4cd7fd1c19a8784b1b83e5e9bd76f5d40`。另附便携归档、资源清单、许可证清单和 `SHA256SUMS`。取舍见[发行决策](../../../docs/decisions/2026-11-20-linux-release.md)。本机样包包含 7 项待补上游许可文本，正式对外分发在 P7 核对。
- 使用安装包解出的启动器在独立 PID、网络、挂载、XDG 和显示环境启动。实物工件来自经 typecheck/test/build 验证的代码快照，打包器记录了实际编译输入哈希；后续文件头说明集中维护。已有开发工作区数据不参与测试。
- 五次空库就绪 718、701、693、703、694 ms；离线重开 486 ms。每 150 ms 采样的进程树 RSS 最高 995.4 MiB，最慢退出 112 ms。六次均正常退出，残留进程数为 0。机器与夹具见[验收记录](../../../docs/evidence/desktop-p1-linux-x64/acceptance.json)。当前同机预算：五次启动最大 5 s、退出最大 3 s、RSS 最大 1536 MiB、归档最大 300 MiB、残留进程 0。
- 本机 SDK CLI 经回环模型传输替身完成两次请求和一次工具调用，付费模型请求为 0。真实原生网页和页面输入通过；交付物的 FileVista/PDF.js 用安装包本地 worker 渲染样例 PDF。在测试中，直接导航 PDF 的 Chromium 内置查看器只显示空壳，P1 产品内 PDF 阅读使用已验证的交付物预览。[PDF 预览](../../../docs/evidence/desktop-p1-linux-x64/installed-pdf-preview.png)
- `npm run check`、`npm test`（89 项）、生产前端与桌面构建通过。P1 用户试用和重跑入口见仓库根 README。下一阶段 P2 处理宿主与运行时恢复。

## 2026-11-20 · P2 / 窗口、运行时与恢复 · 已验证

- 桌面新增独立运行时监督和配对协议。实物 Arch 包 SHA-256 为 `eceb04537bad3b241e0f6a383e9075d6cf385d0cc7a70771d2c020ecc017c6a3`。新版 Linux 受控环境中 10 次冷启动加 1 次离线重开均正常退出。冷启动最慢 759 ms，空闲关闭最慢 106 ms，采样进程树 RSS 最大 1152.4 MiB，残留进程为 0。[安装态验收](../../../docs/evidence/desktop-p2-linux-x64/installed.json)
- `scripts/smoke-desktop-recovery.mts` 对同一安装件验证第二次启动、端口占用、活跃写者保护、拒绝旧宿主协议和未配对 HTTP。真实 SDK 走回环替身，待审批时强杀运行时，重启看回原会话并拒绝旧审批和旧任务重放。执行中关闭耗时 1038 ms，重新打开保留正常关闭产生的中断记录。测试以固定选择驱动原生对话框的重试按钮回调。[恢复证据](../../../docs/evidence/desktop-p2-linux-x64/recovery.json)
- 开发过程 review：用 P1 的安装态脚本验证十次循环及原功能，只增加一条故障脚本覆盖 P2 特有行为。第一次归档期间修改了打包输入，导致压缩工作作废。下个阶段先用隔离构建副本验证修改，输入稳定后再压缩归档。故障脚本把 3 秒关闭预算和持久记录写为断言，省去重复人工判断。

## 2026-11-20 · P3 / 数据迁入引擎 · 已验证

- 使用 P1 包内运行时写出隔离数据，用新版随包 Node 执行迁入。新版 Electron 正常打开迁入项目，P1 打开回退副本，源数据库字节一致。`tests/data-migration.test.ts` 另覆盖附件、交付物、占用、已存在目标和损坏数据的处理。[迁入记录](../../../docs/evidence/desktop-p3-linux-x64/migration.json)
- 原生 `--import-data` 进入向导使用的独立 profile。隔离 X11 无法通过外部键盘驱动选目录，还需验证系统对话框完整流程。
- 开发过程 review 保留一条实际 P1 到新版再到 P1 副本的恢复链路，复用它检查源库和备份。将失败条件集中到临时 SQLite 测试，避免每种错误都重复执行原生对话框。

## 2026-11-20 · P4 / 原生浏览器

- 受控浏览器移入 `desktop/browser/`。旧 Playwright 配置在服务启动时补记 provider。浏览器 IPC 从运行时接收请求、运行标识和取消消息。
- 隔离 Electron 的真实 SDK 从固定的 Agent 标签完成读取和截图，用户仍可查看另一个标签。人工接管取消了未返回的本地网页导航，交还控制后 Agent 目标与用户选择一致。[验证记录](../../../docs/evidence/desktop-p4-linux-x64/tabs.json)
- 开发过程 review 使用两标签的一条链路覆盖工具发现、页签目标、截图落盘和慢导航交接。工具轨迹显示卡点在后台截图，后续仅重跑这条用例。真实账号登录和 Wayland 交互归安装件验收。

## 2026-11-20 · P5 / Agent 桌面执行

- 真实 Electron 和 SDK 通过回环模型夹具展示待审批消息。批准前测试文件不存在，用户点击「允许本次操作」后文件内容与审批一致，流式回复出现在对话。下一轮在同一个 SDK 会话续接，收到完成消息。[界面验收](../../../docs/evidence/desktop-p5-linux-x64/agent.json)
- 开发过程 review 复用 P2 的执行中停止和审批失效、P4 的自动 MCP 发现和截图交付，新增一条正向审批及续接验收。后续复用该组证据验证桌面运行时，真实付费模型依相应授权进行。

## 2026-11-20 · P6 / 桌面文件操作

- 安装件完成真实写盘、取消未创建文件、定位已保存副本和消息框拖入附件。系统选择和定位接口的返回由隔离测试提供。Web 沿用原浏览器入口。[验证记录](../../../docs/evidence/desktop-p7-linux-x64/workflows.json)
- 开发过程 review 将拖入、粘贴和文件选择收敛到同一上传流程。交付物卡片和预览共用另存组件。一次验收覆盖保存取消、内容一致和定位，避免重复测试两处入口。

## 2026-11-20 · P7 / Linux x64 本地发布验收

- Arch 归档 299,490,953 字节，SHA-256 `a8fc8aac7d2169b894771916f3cc022b84c8ccc42f397d6c44913148fd584c47`。十次冷启动最慢 758 ms，峰值进程树 RSS 1153.7 MiB，常规退出最慢 108 ms，连同离线重开共 11 次退出，残留进程为 0。[安装态记录](../../../docs/evidence/desktop-p7-linux-x64/installed.json)
- 同一构建通过实际点击人工接管、后台标签截图、聊天审批和续接、文件与诊断操作。迁入向导以测试给出的路径和确认选择运行，P1 数据字节保持一致。新版新建会话后，旧版重新使用迁入前的副本，该副本包含旧数据。模型使用回环夹具，付费调用为 0。[功能记录](../../../docs/evidence/desktop-p7-linux-x64/workflows.json)
- 开发过程 review 核对了发布候选的真实按钮，发现繁忙态阻塞接管并修复。验收脚本通过点击新手弹窗的关闭按钮消除焦点竞争，复用同一归档。压缩级别从 19 调整为 10 缩短本地打包，两个归档仍低于 300 MiB。
- Windows 与 macOS 复用宿主路径处理，需要对应平台构建和系统功能验收。

## 2026-11-20 · P7 / 第三方许可复验

- 复核锁定版本的 npm 归档与上游许可。将 `fastdom`、`strictdom` 的发布包许可章节和 `react-remove-scroll-bar` 后续补充的上游 MIT 文本纳入 Arch 和便携包。安装态复验通过，十次冷启动最慢 758 ms，正常退出最慢 110 ms，残留进程为 0。[来源](../../../docs/licenses/README.md) · [归档校验与安装态记录](../../../docs/evidence/desktop-p7-linux-x64/license-update.json)
- 开发过程 review 闲置进程核对后保留工作台。许可更新复用锁定依赖和 P7 安装态脚本，以上一轮记录保留功能证据。对外分发仍需应用及第一方 `@atelier/markdown` 的许可声明和发布授权。

## 2026-11-20 · P7 / Wayland 缩放与弹窗复验

- 用安装件启动独立工作台，强制使用原生 Wayland，启用 Chromium 沙箱。在 1440×960 的测试窗口打开本地网页，将工作台页面缩放从 100% 调到 125%。修复前，原生视图直接采用 CSS 坐标。修复后，宿主按页面缩放比例换算并将视图裁到内容区域，四项坐标与尺寸误差均在 2 像素内。模型与网关设置弹窗打开时移除原生视图，关闭后恢复网页。[安装件与坐标实测](../../../docs/evidence/desktop-p7-linux-x64/wayland.json)
- 对重建的 Arch 包复用 X11 安装态脚本。十次冷启动最慢 762 ms，正常退出最慢 106 ms，残留进程为 0。Wayland 复验使用本地网页夹具，窗口缩放由测试工具设置。

## 2026-11-20 · P8 正常退出准备

- 桌面宿主通过私有 IPC 断连触发运行时的正常退出。宿主等待子进程退出，超时后保留强制清理。恢复脚本支持 Windows 和 macOS 安装目录。当前在 Linux 安装件上复验通过，SDK 运行中关闭耗时 1,039 ms，重开后可读到明确的中断记录。十次冷启动最慢 787 ms，常规退出最慢 106 ms，残留进程为 0。付费模型调用为 0。[最终归档与恢复记录](../../../docs/evidence/desktop-p7-linux-x64/ipc-shutdown.json)
- 开发过程 review 复用安装件故障脚本验证已有的断连清理，不再增加 IPC 消息。首轮打包复验发现单等 `close` 会卡住 Electron。后续先在隔离安装目录验证 `exit` 处理，再重建最终归档。Windows 和 macOS 本机打包与图形会话验收待对应平台环境。

## 2026-11-20 · P4 / 桌面内置浏览器工具

- 桌面按项目直接登记原生浏览器工具，结合人工接管及逐次审批。测试项目配置了零个 MCP 扩展。真实 SDK 通过回环替身验证导航、接管和交还后重新观察、批准一次点击，以及截图作为 PNG 交付物保存。单独的 CDP 键盘夹具完成输入替换和表单提交。付费调用为 0。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/native-browser.json)
- 开发过程 review 复用安装态夹具与现有审批系统。第一次点击虽然返回成功，网页状态没有变化。用一个隔离 WebContentsView 复现了原生输入钩子拦截 CDP 事件，修复后以点击计数和截图像素判定通过。授权与撤销竞态用临时 SQLite 测试覆盖。

## 2026-11-20 · 候选构建与桌面切换

- 从同一 Linux 工件装配 Windows x64 和 macOS arm64 候选 ZIP。在 Linux 核对发行输入哈希、运行时资源、PE 和 Mach-O 架构及 ZIP 完整性。两个目标系统的运行验收留待后续。[构建证据](../../../docs/evidence/desktop-platform-previews.json)
- 用隔离项目运行旧版和新版 Linux 安装件，正常关闭旧版并确认单写者锁释放。新版使用同一个数据根，成功读回项目、会话、草稿、网关与模型设置以及项目浏览器分区数据。[切换证据](../../../docs/evidence/desktop-p7-linux-x64/same-data-upgrade.json)
- 开发过程 review 复用已筛选的 Linux 工件与 Electron Packager，省去两套资源收集流程。在一次同目录切换用例同时验证会话、配置和浏览器分区。Windows 与 macOS 本轮各交付一份候选构建，持续开发和回归优先放在 Linux。

## 2026-11-20 · 浏览器面板与全工具自动化

- 浏览器标签和地址占两行，共 80 CSS px。授权移入设置，打开时临时隐藏原生网页，关闭时恢复同一视图。Wayland 实测 1280×800、1440×900 与 125% 缩放。[决策](../../../docs/decisions/2026-11-20-task-automation.md)
- 自动化仅作用于当前任务，通过统一审批服务处理本轮已获授权的工具。安装态用真实 SDK 与回环夹具执行 6 次工具调用，核对网页点击、文件内容、本地 MCP 调用和三条自动审批记录。受控修改仍显示逐次审批。后端 105 项、前端 35 项通过，模型和搜索付费请求均为零。[归档与验收](../../../docs/evidence/desktop-p7-linux-x64/task-automation.json)
- 正常关闭旧桌面并等待写锁释放。新版使用同一数据目录、界面地址和浏览器 profile。比对确认原有项目、14 个会话、2 份非空草稿与设置完整。
- **开发过程 review**。首轮过早构建遇到未完成的前端类型改动，下次先冻结产品代码再打包。夹具先发现 MCP 工具再授权，手动地址栏测试放在 Agent 用例后执行。浏览器点击在面板打开时核对实际效果。面板隐藏时的点击问题记入本轮证据。安装态发现的草稿模式问题已由服务端修复并加入回归。最终为这一处产品修复重建归档，复用相同浏览器 UI 的 Wayland 数据。

## 2026-11-20 · 长任务执行

- 网页检索实测跑满默认 16 轮后没有回复。新任务默认持续执行到完成或停止。运行时停用总轮数、总时长及 SDK 固定费用估算上限。用户可以在设置中启用总轮数和总时长限制，旧的自定义上限会继续生效。[决策](../../../docs/decisions/2026-11-20-long-tasks.md)
- Linux 安装态从 Composer 发送任务，实际完成 17 次工具调用并收到最终文本。后端 106 项、前端 35 项回归测试通过。旧桌面退出后用同一数据目录和浏览器 profile 打开新版，数据库记录逐表相符。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/long-tasks.json)
- **开发过程 review**。扩充既有回环场景跨过 16 轮并核对最终文本，复用原有安装态和停止用例。首轮增加了工具步骤，离线重开仍断言旧请求数，改用共享计数后直接复验原工件。下次工具编排变化时同步更新其重开断言。

## 2026-11-20 · 会话级运行模式

- 运行模式保存到会话草稿。实际执行时继续记录当轮审批策略，新会话默认只读。采用 shadcn Select 展示运行模式，自动模式的搜索费用改为按需设置，仅下一次发送生效。[决策](../../../docs/decisions/2026-11-20-session-approval-mode.md)
- Linux 安装态从输入区连续发送两轮，都保持自动化，重开后确认模式恢复并验证另一会话仍为受控修改。后端 106 项和前端 35 项通过。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/session-approval-mode.json)
- **开发过程 review**。沿用原有草稿保存队列和安装态用例，在原场景追加一轮发送及重开验证。首轮回归的整份草稿断言受空扩展字段影响，改为直接核对审批偏好和实际运行模式。

## 2026-11-20 · 会话模型选择

- 发送键旁的 shadcn Select 保存会话选定的模型。模型目录合并工作台默认值、Shunt 路由和本机 Codex 可见模型。在本机配置合并后得到 10 项。[决策](../../../docs/decisions/2026-11-20-session-model-picker.md)
- Linux 安装态选择第二个模型并核对真实 SDK 发给回环网关的请求，随后离线重开会话确认选项恢复。142 项回归通过，正式实例完成同目录切换。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/session-model-picker.json)
- **开发过程 review**。复用会话模式的连续发送场景核对模型 ID。首轮仅用显式路由导致两项，用户确认需要补全目录后使用 `model/list`。将目录查询、协议兼容验证与无费用的安装态 SDK 检查各保留一次。

## 2026-11-20 · 内置 Shunt 与会话推理深度

- Linux 安装包附带固定版本的 Shunt。正常启动时使用独立的回环端口和工作台目录中的 Shunt 配置。原有账户目录可复用。设置提供首次 ChatGPT 登录和外部网关选择。[决策](../../../docs/decisions/2026-11-20-managed-shunt.md)
- 模型菜单收为单行列表。发送区支持选择并保存会话推理深度。真实 SDK 的回环请求收到所选 `xhigh`，重开后恢复该选择。[推理设置](../../../docs/decisions/2026-11-20-session-reasoning-effort.md)
- 最终 Linux 安装态验证无账号启动、拒绝匿名请求及同目录配置持久。正式实例复用已有账号目录，确认本地网关可达。142 项项目测试和 7 项独立登录进程检查通过。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/managed-shunt-and-effort.json)
- **开发过程 review**。先用 SDK 回环探针验证别名的 effort 参数，再纳入既有安装态用例。复用安装态启动器检查内置与外部网关。首轮实机截图发现发送键换行，移走重复键盘提示后，用同排位置断言复验。

## 2026-11-20 · 会话网页链接

- 桌面会话点击网页链接后选择打开位置。内置入口新建项目标签并进入人工控制，外部入口将校验过的网址交给系统浏览器。[决策](../../../docs/decisions/2026-11-20-chat-web-links.md)
- Linux 安装态验证新标签实际导航、原标签保留、系统打开命令收到完整网址，以及 Enter 与 Esc 的焦点行为。142 项项目测试通过。完成同目录桌面切换并核对会话、草稿和设置。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/chat-web-links.json)
- **开发过程 review**。沿用已有私有浏览器 IPC、shadcn Dialog 和回环 SDK 场景。在现有回复夹具追加一条本地网页链接，同一个用例验证两个打开入口。外部打开使用隔离的 xdg-open 记录器。

## 2026-11-20 · 内置浏览器下载

- 处理人工浏览中的附件链接。下载记录按项目展示，文件保存到系统下载目录，同名加序号。工具栏保留原有两行布局。[决策](../../../docs/decisions/2026-11-20-browser-downloads.md)
- Linux 安装态用本地 `target="_blank"` Excel 响应验证进度、保存路径、实际字节内容、原公告页和同名文件保留。142 项项目测试通过。旧实例正常退出后完成同目录切换。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/browser-downloads.json)
- **开发过程 review**。复用既有原生网页用例。复验修正了隔离环境的下载目录回退和夹具字符集。最终让附件从原受控网页视图发起，并单独断言服务器收到请求，缩短从界面失败定位到导航链路的过程。

## 2026-11-20 · 网页附件文件名

- 官网链接展示中文标题，响应以编号式 URL 文件名提供附件。工作台对可匹配唯一网页标题的编号文件使用标题和原文件后缀。[决策](../../../docs/decisions/2026-11-20-browser-download-filenames.md)
- Linux 安装态以同样的 Excel 编号链接验证中文路径、实际文件内容和同名序号。142 项回归通过，完成同目录桌面切换。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/browser-download-filenames.json)
- **开发过程 review**。先核对原站响应头和链接，再把现有附件夹具换成同样的命名结构，复用进度、落盘和同名保护断言。

## 2026-11-20 · 下载列表和文件预览

- 下载记录改为紧凑文件行。按项目下载标识读取完成文件，交给 FileVista 预览。电子表格使用独立 worker 读取 XLS 和 XLSX。系统打开走本地默认应用。[决策](../../../docs/decisions/2026-11-20-browser-download-previews.md)
- Linux 安装态实际下载 BIFF2 工作簿，验证 FileVista 单元格、系统打开器收到的文件路径和跨项目读取拒绝。142 项回归通过，完成同目录桌面切换。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/browser-download-previews.json)
- **开发过程 review**。复用附件下载场景，将原来的内容替身换成可解析工作簿，继续检查进度、文件字节和同名保护，再追加预览及打开动作。

## 2026-11-20 · 浏览器超时与状态恢复

- Electron 管理操作时限和恢复，导航允许 60 秒，其余操作 30 秒。异常作为独立工具结果写入轨迹并在聊天显示。健康标签保留页面和表单，必要时只替换失效标签，输入结果不确定时提示核对。[决策](../../../docs/decisions/2026-11-20-browser-timeout-recovery.md)
- 真实 Electron 验证 31 秒慢页面完成、挂起操作恢复及网页进程退出。Linux 安装态真实 SDK 收到导航超时，随后成功读取原页并完成回复。142 项回归通过。桌面完成同目录切换，核对 14 个会话、2 份未发送草稿和设置。[验收](../../../docs/evidence/desktop-p7-linux-x64/browser-timeout-recovery.json)
- **开发过程 review**。独立夹具并行验证慢导航和输入截止，安装态复用已有浏览器任务覆盖用户提示。夹具的请求计数断言修正后，直接复验同一归档。后续增减工具时共同核对夹具、初次运行和重开计数。

## 2026-11-20 · 会话消息队列

- 会话运行中可继续按 Enter 发送。待处理消息保存在 SQLite，上一轮清理后按序启动。输入区可撤回，重启后可继续原队列。[决策](../../../docs/decisions/2026-11-20-session-message-queue.md)
- 安装态真实 SDK 验证三轮顺序执行、后续轮获取前一轮回复及撤回生效。151 项回归通过。同目录桌面切换完成，14 个会话、2 份草稿和设置通过核对，数据库升级到 v4。[验收](../../../docs/evidence/desktop-p7-linux-x64/session-message-queue.json)
- **开发过程 review**。隔离运行时测试验证持久化和执行交接，安装态集中验证 Enter、实际 SDK 上下文和结果。模型夹具将历史误作本轮输入时，修正匹配范围并复用原归档。下次新增多轮场景优先从本轮输入块匹配。

## 2026-11-21 · 文档附件与实时补充

- 文档通过本机流式写入，保留原件与会话引用。表格大于 20 MiB 时提供原件下载，Agent 通过授权文件路径分段读。待处理区使用紧凑布局，可立即插入符合本轮设置的消息。[决策](../../../docs/decisions/2026-11-21-document-attachments-and-live-input.md)
- 安装态验证 22,475,193 字节 XLSX 的原件下载与第 245 行读取。使用回环模型确认补充消息在同一 SDK 运行收到回执。193 项回归通过。同目录切换后 14 个会话、2 份草稿和设置通过核对，数据库升级到 v5。[验收](../../../docs/evidence/desktop-p7-linux-x64/document-attachments-and-live-input.json)
- **开发过程 review**。解析边界主要通过隔离文件夹具验证，安装态集中检查大文件上传、原件一致性、SDK 本地读取和真实插入。保持回环模型按本轮任务匹配，复用前序桌面验收。

## 2026-11-21 · ORM 架构与开发约定

- [ORM 架构决策](../../../docs/decisions/2026-11-21-orm-architecture.md)规定仓储接口、用例事务、Drizzle schema、迁移及运维的职责。数据库路径规则已关联 AGENTS.md，架构检查对生产源码中的已有 SQL 指纹和新增依赖逐处核对。
- 随包 Node 24.21.0 在临时库通过稳定驱动的读写、条件领取、回滚和在线备份验证。仓库类型及架构检查、196 项回归和构建通过。产品接入以会话快照作为首个迁移用例。
- **开发过程 review**。先查 npm 稳定版导出，再用实际 Node 验证驱动，提前发现文档与稳定发行入口的差异。将实际工作区数据迁移和桌面发行验收留在首个产品接入阶段。

## 2026-11-21 · ORM 首批会话快照

- `GET /api/sessions/:id` 在共享连接的同步读取事务中装配 Drizzle 记录、队列和智能体状态。v6 派生列让六类记录按会话索引查找，并保留已有 rowid 顺序。[实现决策](../../../docs/decisions/2026-11-21-orm-architecture.md)
- 临时 v5 数据与本机数据库副本均已验证等价性，14 个已有会话的记录内容及顺序逐字段一致。100 个会话、1 万条消息的热库测试中，目标会话 100 条消息的记录读取中位值由 6.10 ms 降为 0.61 ms。201 项回归和 Linux 安装态验收通过。[验收](../../../docs/evidence/desktop-p7-linux-x64/session-snapshot-orm.json)
- **开发过程 review**。从真实仓储生成的查询检查六个索引，复用副本演练覆盖旧库内容。打包验证先发现 npm 包缺少许可证正文，随后发现驱动探针缺少 FROM 表。下次在独立依赖目录直接运行和归档相同的探针，再启动打包。

## 2026-11-21 · 会话子代理

- 主会话通过原生 SDK 前台委派最多两个子代理。运行时按执行者绑定工具、审批和提交结果。每项任务可在本轮消息或执行轨迹单独展开。SQLite v7 保存子任务并在异常退出后保留中断状态。见[决策](../../../docs/decisions/2026-11-21-subagents.md)。
- 212 项回归通过。通过 Linux 安装工件的独立数据根，验证真实 SDK 委派、两个待审批任务的独立展开、按任务允许和拒绝、实际文件内容及离线重开。使用回环模型夹具完成六次请求。见[验收记录](../../../docs/evidence/desktop-p7-linux-x64/subagents.json)。
- **开发过程 review**。先用最小 SDK 探针确认同批并行和 hook 参数透传，再复用同一模型夹具测试应用执行器和桌面操作。安装验证用健康检查和消息发起响应快速区分 UI 定位失败与网关问题。

## 2026-11-21 · 子代理调度修正与站点搜索

- 按用户要求移除 Atelier 的两任务上限。同批委派当前由原生 Claude SDK 调度。项目规则要求行为偏离 Claude CLI 时先说明并取得用户确认。真实 SDK 夹具卡住首批响应直到收到三个子调用，并验证三项审批各自归属。
- 在现有 Shunt 路由上加入按域名的托管搜索。SDK 子代理调用搜索工具时记录其结果。真实网关分别返回 `baidu.com` 和 `toutiao.com` 来源。安装态完成三个子代理同时等待审批、两个子代理分别搜索与重开历史，213 项回归通过。见[搜索决策](../../../docs/decisions/2026-11-21-subagent-web-search.md)。
- **开发过程 review**。核对网关配置约束后用现有 `/v1/messages` 实测，复用订阅授权。扩大原有安装态夹具，一次启动覆盖三路调度、两站搜索和重开。

## 2026-11-21 · 消息操作与会话分支

- 用户消息可复制或带入输入框编辑，助手回复可复制 Markdown 或引用到草稿。原「只读续接」改为「检查任务进度」。从已记录 SDK 切点的消息创建独立分支，侧栏标记分支，头部提供来源定位。会话分支共用项目当前目录。见[消息分支决策](../../../docs/decisions/2026-11-21-message-branches.md)。
- `npm run check`、`npm test`（155 项运行时测试、65 项前端测试）、`npm run build` 和 `npm run build:desktop` 通过。用隔离数据根和回环模型执行 `tests/session-forks.test.ts`，覆盖同节点 A/B、请求重试、未完成创建清理、来源删除后重启、分支独立续接和配置变化后的上下文恢复。Linux Electron 开发构建以独立数据和 profile 操作真实窗口，在 1280×800 核对真实复制粘贴、创建分支和来源定位，在 1440×900 检查分支列表和会话内容。桌面夹具完成三次回环模型请求，创建分支时没有模型请求。工作区验收，文件说明待验收提交后集中核对。
- **开发过程 review**。复用同一个回环模型夹具验证 SDK、HTTP 和真实桌面。先在运行时验证截取范围和原会话删除后的续接，再检查桌面交互。复制从用户输入框的实际粘贴判定，测试断言只记录匹配结果。
- 图标尺寸修复在共享 Button 的图标变体上覆盖文字按钮内边距。旧样式将编辑和发送 SVG 分别压到 2 和 6 CSS 像素宽。Chromium 回归使用真实 CSS 层级，Electron 在 1280×800 和 1440×900 分别测得 15 和 20 CSS 像素，编辑按钮可带入正文，发送按钮随输入正确启用。220 项回归通过。
- 旧会话打开时恢复可唯一核对的 SDK 切点。`tests/session-forks.test.ts` 移除示例消息的切点，经真实 SDK 和回环替身恢复后建立分支。隔离 Electron 重开同一份旧数据，验证分支创建、切点排除后续内容、返回来源与独立续聊。220 项回归、类型检查及桌面构建通过。原桌面正常关闭后用原数据目录重开，核对 1 个项目、16 个会话及 3 条设置记录，当前打开的会话恢复了 6 条消息切点。
- 补充恢复旧 Skill 消息。按照原生请求的扩展名称、类型和完整用户正文核对提示，再与完整回复做双向唯一匹配。回环测试实际提交 Skill 后移除切点，确认重新加载能恢复并创建分支。220 项回归及桌面构建通过，隔离 Electron 复验创建分支及定位来源，实际工作台打开截图对应的会话后，两条消息均恢复切点。
- 侧栏按会话的来源 ID 组织分支，分页按根会话分组，搜索保留命中会话的祖先。来源已删除的分支继续作为顶层会话可访问。223 项回归通过，生产和桌面构建通过。隔离 Electron 用回环夹具验证三层会话、键盘展开收起、搜索和切换。原桌面用原数据重开，保留 19 个会话及其中的两个分支。
- **开发过程 review**。复用已加载的会话列表及原生分支夹具。用三个纯数据用例覆盖排序、搜索和缺失来源，再在同一次桌面运行中检查展开和导航。

## 2026-11-21 · 对话回退

- 可验证的历史消息提供「回退对话到此处」。确认后从该消息继续，原会话收在侧栏「回退前」。续聊使用当前工作目录。回退前的草稿、审批和交付物留在原会话。见[回退决策](../../../docs/decisions/2026-11-21-conversation-rewind.md)。
- `tests/session-forks.test.ts` 覆盖历史切点、并发历史变化、活动运行、排队消息、重复请求、源草稿与文件内容。`npm run check`、`npm test`、生产和桌面构建通过。隔离 Electron 验证 Esc 取消与焦点恢复、打开旧版本读取原草稿、按原生切点续聊、项目文件保留当前内容。模型走回环替身，共三次请求。原数据桌面重开保留 19 个会话。
- **开发过程 review**。复用分支创建和恢复流程，用一条原生续聊测试对照历史正文和实际磁盘文件。文件头集中维护在验收提交后进行。

## 2026-11-22 · 项目导航、布局与模型目录

- 侧栏按项目展示会话及分支。用悬停或键盘打开会话菜单，重命名、归档、恢复或删除目标会话。右栏去掉重复的项目和会话管理区，汇集当前运行、审批和使用信息。Chromium 夹具覆盖两项目归组、回退历史搜索、非当前会话管理、焦点和折叠。
- 新增可拖动的分隔条、左栏折叠与布局默认值。尺寸随窗口临时调整，用户选择的宽度保存在工作区数据库。Electron 验证 232/320 初始宽度、拖动、键盘调整、48 像素折叠宽度、默认值写入及重开、窄屏抽屉和原生浏览器位置。见[布局决策](../../../docs/decisions/2026-11-22-workspace-layout.md)。
- 本机复现时 Shunt 的路由正常，Codex 补充目录在旧总预算内超时。调整时间预算、缓存和错误反馈后，同一个本机网关连续三次给出 10 个模型。回归覆盖 5.1 秒返回、失败恢复、分页和账号来源隔离。见[诊断和修复](../../../docs/decisions/2026-11-22-model-discovery-recovery.md)。
- **开发过程 review**。左栏、右栏和 Shunt 三路并行，主会话接线。单独用可调整的 Electron 测试窗口验证几何，复用路由和真实 `model/list` 对照合并结果。

## 2026-11-22 · 开发桌面托管 Shunt

- 开发桌面使用 Linux 打包产物中的 Shunt，复用主进程的启动与退出流程。隔离 Electron 验证自动启动、模型目录返回 10 项、关闭窗口后网关退出。当前桌面以原数据重开并选中内置网关，临时外部服务已停。停止后再次验证内置网关健康和 10 项模型目录。244 项回归及前端和桌面构建通过。[托管网关决策](../../../docs/decisions/2026-11-20-managed-shunt.md)
- **开发过程 review**。先核对当前窗口的启动类型及实际连接，再使用隔离 Electron 验证网关随窗口结束。保留外部服务到切换验收完成后再关闭。

## 2026-11-22 · 独立设置页与工作台路由

- 设置打开独立页面，分为模型与网关、工作区布局、诊断。默认模型取已保存网关的目录，仍可手动输入。TanStack Router 管理工作台页面、会话子页和设置路径。SQLite 保存最后位置及最近会话，重开时恢复。见[路由决策](../../../docs/decisions/2026-11-22-workspace-routing.md)。
- 247 项回归、类型检查、前端及桌面构建通过。隔离 Electron 验证两个会话子路由、前进后退、默认模型选择与保存、设置子页、刷新以及运行时换端口后的恢复。侧栏 Chromium smoke 通过。已用原数据重开桌面，确认项目和会话数量及内置网关选择一致。
- **开发过程 review**。在一次 Electron 夹具中完成路由导航、表单和重启验收，分页和失败场景由聚焦测试负责。

## 2026-11-22 · Magpie 模型

- 会话及默认模型选择器增加 Magpie 分组。选择后，运行时通过本机 Magpie 发送原生 Anthropic Messages 请求。内置 Shunt 继续提供同一目录中的 Shunt 模型。[接入决策](../../../docs/decisions/2026-11-22-magpie-model-gateway.md)
- 实际 Magpie 目录返回 57 项。隔离 Electron 验证两个选择器和会话模型持久化。原生 SDK 回环测试覆盖网关分流、原始模型 ID 和离线失败。249 项测试及构建通过。原工作区重开，确认内置 Shunt 仍选中，Magpie 目录可读。
- **开发过程 review**。先通过目录和空请求确认网关接口，复用原生 SDK 替身验证发送，再用 Electron 连接真实目录。

## 2026-11-22 · Magpie 独立接入开关

- 「设置 → 模型与网关 → 允许接入 Magpie」默认关闭，独立保存。运行时在目录发现、发送、重试和队列投递前判断当前设置。原默认或会话模型保留并标明不可用。已经启动的运行仍可通过停止按钮结束。[接入决策](../../../docs/decisions/2026-11-22-magpie-model-gateway.md)
- `npm run check`、`npm test`（170 项运行时、79 项前端）、`npm run build` 和 `npm run build:desktop` 通过。回环验证保留的默认模型、禁用拦截、在途目录取消、SQLite 重开和真实 SDK 的网关分流。隔离 Electron 用键盘及鼠标切换，开启后读取真实 Magpie 的 57 项，关闭后仍可选夹具 Shunt，重启后保留关闭状态和原默认模型。实际桌面以原数据与 profile 重开，1 个项目、3 个会话和内置 Shunt 配置仍可用。
- **开发过程 review**。用同一隔离 Electron 场景验证真实目录、两个选择器和重开。用回环夹具验证发送拦截，目录竞态在测试中显式挂起请求，减少等待和付费调用。
- 文件说明复核基于 12 份源码的验收后哈希快照。更新 7 个文件头，12 个文件的 `check:headers` 全部通过。

## 2026-11-22 · 会话快捷插入与引用卡片

- 输入区 `Alt + Enter` 提交当前草稿并尝试把对应队列项插入当前运行。插入不兼容或未确认时可在待处理消息中查看。引用回复会生成正文输入上方的可移除卡片，随草稿保存并在发送时组成正文。[交互决策](../../../docs/decisions/2026-11-22-composer-quotes-and-insert.md)
- 249 项测试、类型检查、前端和桌面构建通过。Chromium 夹具覆盖 IME、幂等发送重试、卡片增删及插入失败。隔离 Electron 在草稿 PATCH 确认后关闭并重开，卡片和正文均恢复。真实 Agent SDK 对接回环网关替身，核对发送带引用正文和快捷键的实时插入回执。原桌面已使用原 profile 和数据重开，保留 1 个项目、4 个会话和原网关设置。SQLite 回退副本已通过完整性检查。
- **开发过程 review**。重启测试用可确认的草稿保存回执判断持久化完成。利用切窄的真实桌面复现提示隐藏，修复后复用同一流程检验可见性及投递。
- 首次文件说明复核超时，改用同一验收快照的相关片段后通过。更新 10 个文件头。13 个相关文件通过 `check:headers`，源码正文与验收快照一致。

## 2026-11-22 · 桌面本机执行与进展恢复

- 普通 Linux 桌面新会话默认使用 SDK 原生 Shell、文件和技能工具。既有会话从运行模式选择「本机信任」。队列与续接固定执行器版本。子任务可单独停止，归属该分支的在途审批随之取消。运行恢复带入已有来源、工具结果指针和未确认的修改。[决策](../../../docs/decisions/2026-11-22-native-harness.md)
- 真实 Electron 使用临时项目和回环模型响应验证项目外文件修改、长命令停止和重开后恢复。真实 SDK 测试还覆盖项目 Skill 调用以及只停止指定子任务。`npm run check`、`npm test`（229 项运行时/工具链、83 项前端）、`npm run build`、`npm run build:desktop` 通过。备份 SQLite 并通过完整性检查后，用原 profile 打开新版，1 个项目、4 个会话和网关配置已核对。[验收数据](../../../docs/evidence/desktop-p7-linux-x64/native-harness.json)
- 历史轨迹离线回放在第 236 秒、149 秒分别触发首次重复来源提示，两轮均恢复了 16 个待核实来源。默认向原生模型提供提示。持续确定失败时自动停止子任务可用 `ATELIER_HARNESS_PROGRESS=pause-branch` 启用。真实模型三方对照须使用获授权的模型调用预算。[评测入口](../../../docs/harness-eval.md)
- **开发过程 review**。从同一工作区复用旧队列、回执、SDK hook 和 SQLite。先以回环传输走通不可伪造的文件与进程状态，再用历史事件调校提示。跨任务评测加入正常重复、等待与回执未知等对照，避免把调用次数误作质量。

## 2026-11-22 · 并行分支停滞提示投递

- 主会话和子分支共享重复证据，各自记录反馈回执和冷却时间。执行轨迹区分待投递与加入 SDK 工具回执。处于冷却期的提示可在后续相同停滞再次出现时投递。
- 使用真实 Agent SDK 和回环模型验证两个并行前台分支相隔 1 ms 触发同一目标的停滞提示。两条后续模型请求各自携带对应工具的提示。231 项运行时测试和 83 项前端测试通过，类型检查、前端与桌面构建、隔离 Electron 验收通过。已切换原桌面，核对 1 个项目、4 个会话及网关设置。
- **开发过程 review**。确定性时钟重放第 64 秒和第 66 秒的双分支故障，SDK 测试检查下一次模型请求中的实际提示和工具 ID。
- 文件说明复核完成，更新 3 个文件头，4 个相关文件通过 `check:headers`，源码正文与验收快照一致。

## 2026-11-22 · Bash 前台命令的重复输出提示

- 每个分支独立比较前台 Bash 的执行参数和完整输出，达到既有停滞阈值后通过工具回执给出建议。文件编辑、命令变化或输出变化会重新计数，后台任务、截断回执和中断回执另行处理。[执行契约](../../../docs/decisions/2026-11-22-native-harness.md)
- 真实 SDK 配合回环模型运行三次 `pwd`，验证停滞提示已进入下一次模型请求。并发分支、文件修改前后的测试重跑和后台作业回执均有定向覆盖。235 项运行时及工具链测试、83 项前端测试、类型检查、构建和隔离 Electron 验收通过。当前桌面已用原 profile 和数据重开，核对 1 个项目、4 个会话和网关设置。
- **开发过程 review**。先回放十次相同命令确认漏报，再使用真实 SDK 的输出结构验证模型能看到提示。虚拟时钟覆盖触发时长，缩短了验收等待。

## 2026-11-22 · 会话跨轮恢复

- SDK 重建时，运行时在同一读取事务内按会话读取运行、消息和工具记录，生成包含用户要求与更正、来源、回执和待核对操作的摘要。各类资料保留早期锚点和近期记录，省略情况随摘要传入。最近对话按 UTF-8 字节预算选取。分支继承可见前缀，工具记录按实际会话和执行范围筛选。
- 四轮真实 Electron 和 Agent SDK 验收使用本机回环模型。早期 Read/Edit、进度追问、停止 Bash、重开恢复依次执行。恢复后的独立检查点包含早期和近期约束、三轮 ID 和真实工具 ID，Bash 操作标为待核对，文件和命令执行次数验证通过。241 项运行时与工具链测试、83 项前端测试、类型检查及构建通过。已备份 SQLite 并用原 profile 重开，1 个项目、4 个会话和网关设置已核对。[验收数据](../../../docs/evidence/desktop-p7-linux-x64/native-harness.json)
- **开发过程 review**。直接解析恢复后最新模型输入中的检查点 JSON，并核对新的 SDK 会话 ID。这样可以区分检查点恢复与模型偶然在最近聊天文本中看到同一句话。

## 2026-11-22 · 消息内执行明细与按需浏览器面板

- 助手消息展示主助手的执行明细，运行中默认展开，历史记录按需展开。原生 Bash 和沙箱命令显示实际参数与回执，长输出可分页读取、下载。工具开始及结束事件关联具体工具记录，历史截断参数保留已记录内容。
- 会话默认使用整个中栏。停止和计划归会话，事件及用量归执行轨迹。会话变更记录按需打开，浏览器支持宽屏右栏、窄屏中栏和返回原轨迹位置。
- `npm run check`、`npm test`（241 项运行时与工具链、95 项前端）、`npm run build` 和 `npm run build:desktop` 通过。`node --import tsx scripts/smoke-tool-activity.mts` 在隔离 Electron 用回环模型启动真实 Bash，运行中展示完整 4,585 字符命令，结束后在原消息和结束事件核对 `branch=fixture`，浏览器关闭后返回原轨迹。已备份 SQLite 并用原 profile 重开桌面，核对 1 个项目、4 个会话和网关设置。
- **开发过程 review**。用同一工具 ID 串起开始事件、实际命令、回执和历史，复用真实运行记录。响应式测试等待分隔条与原生槽位状态同步，再测量同帧的边界。

## 2026-11-22 · 模型先读长输出摘要

- 长文本工具回执先保存在本地。工作台工具在模型侧提供有界摘录和按需读取指针。原生 Bash 成功文本和常用读取、搜索工具按 SDK 结构交付。原生失败 Hook 支持附加指针，非零退出 Bash 仍可能发送完整错误正文。见[执行契约](../../../docs/decisions/2026-11-22-native-harness.md)。
- 真实 SDK 0.3.326 配回环模型核对下一请求。原生 Bash 保存 33,561 个 UTF-16 码元，模型收到 1,039 个。5 次读取按 8,000 上限拼回原文。受控命令成功 / 失败、6,000 / 6,001 边界、默认页、未发放指针拒绝、原生 Read、Glob 与 Grep 的计数通过。
- 全套测试 349 项通过，1 项 WebFetch 真实 SDK 集成因缺少隔离网络夹具跳过，对应替换结构已有单元测试。`npm run check`、前端与桌面构建、隔离 Electron 消息内完整原文验收通过。已备份 SQLite、正常退出旧窗口，并在原 profile 启动新版，复核 1 个项目、4 个会话及保存的设置。
- **开发过程 review**。验证工具摘要时同时检查模型收到的回执与 system 角色的 Hook 上下文，并用省略位置的标记核对原文读取。字符数记录在各自的传输与存储边界。

## 2026-11-22 · 恢复原生 Read 的精确范围

- 同一批合成任务使用托管网关 `gpt-6.1-sol`、`medium` 复测。原生 Read 由 SDK 限幅并交付行范围，工作台仍保存回执。精确字段任务从 `Read → Grep → Read` 减为一次 `Read`，模型请求从 4 次减为 2 次，未缓存输入从 15,442 降至 9,128，含缓存读取的总输入从 29,266 降至 19,112，耗时从 15.5 秒变为 7.5 秒，答案正确。两项日志任务仍收到摘要并答对，构建日志复测多读一页。
- 真实 SDK 回环先复现 240 行范围被截为首段，再确认第 220–459 行完整到达模型。`npm run check`、前端与桌面构建通过。测试 349 项通过，1 项既有 WebFetch 集成用例跳过。隔离 Electron 验证命令日志的摘要和本地原文，桌面已用原 profile 重开并核对原有项目、会话和设置。
- **开发过程 review**。用同一个模型任务复测往返次数，以回环测试断言长范围到达模型。分开记录摘要策略和模型自主选择分页造成的波动。

## 2026-11-22 · 工具记录内的关键词定位和 Bash 日志保存

- `read_tool_output` 支持按字面关键词在可读日志内定位，返回命中行号、上下文和同一文本内的 UTF-16 偏移。默认回执分页继续使用已保存的 SDK 回执。Linux 桌面保存经运行、会话、项目和文件归属核对的 SDK 日志副本，单条最多 8 MiB。日志详情、分页和下载显示实际保存范围。
- 用 `gpt-6.1-sol`、`medium` 重跑同一合成构建诊断。模型用 `PHASE` 命中第 100 行，查询回执 796 个字符，一次定位到模块、原因和工单。与前次复测相比，模型请求从 4 次降到 3 次，含缓存读取的总输入从 34,198 降到 21,716，未缓存输入从 11,414 增至 14,548，耗时从 16.8 秒增至 18.2 秒。
- 真实 SDK 回环验证省略的日志中段能从关键词命中继续读取。真实 Electron 窗口对 217,623 字节日志翻 6 页定位中段，下载文件与原文一致。子任务记录归属、8 MiB 处的 UTF-8 字符边界、迁移、重开和删除均通过。完整测试 370 项通过，1 项既有 WebFetch 集成用例跳过。类型检查与前端、桌面构建通过。备份 SQLite 后以原 profile 重开，核对 1 个项目、4 个会话和保存的设置。
- **开发过程 review**。以模型真正收到的查询结果和 Electron 原生下载完成事件验收。显示日志和原始回执各自使用明确的分页坐标。独立审查任务因模型额度返回 429 中止，主会话完成复核和针对性修正。

## 2026-11-22 · OpenWiki 项目接入与文档更新

- 安装项目级 Claude Code Skill 与 MCP 配置。由当前会话按源码和测试更新 8 个既有页面，新增工作台导航与模型网关 2 页。OpenWiki 生成索引并记录 34 条事实。[接入与回退](../../../docs/decisions/2026-11-22-openwiki-host-integration.md)
- 宿主更新返回 `complete`。MCP 搜索、章节读取、42 个 Wiki 内链和 83 处源码证据引用已检查。`npm run check`、`npm test` 和 `npm run build` 通过。370 项测试通过，既有 WebFetch 集成用例因缺少可重复的本地传输夹具跳过。
- **开发过程 review**。沿用已有页路径和事实 ID，按运行时、UI 与网关入口复核改动。一次本地 MCP 会话完成更新及检索验证。

## 2026-11-22 · 中英文界面与文案门禁

- 设置页新增简体中文和英文切换，首次使用默认简体中文。界面词条随工件分发，Electron main 在启动运行时前读取 profile 偏好。切换即时更新 React、无障碍名称、页面标题、预览和后续打开的应用原生弹窗。[国际化决策](../../../docs/decisions/2026-11-22-ui-i18n.md)
- `npm run check` 包含 `check:i18n`。它检查常见 JSX 和原生文案入口、字典完整性、插值以及复数形式。全套测试 383 项通过。既有 WebFetch 真实 SDK 用例缺少本地传输夹具而跳过。Chromium 验证切换、未保存设置保留和刷新恢复语言，Markdown 实物包的中英消息可由 Node ESM 导入。
- 前端和桌面构建通过，Linux x64 便携包与 Arch 工件生成。许可清单见 `dist/linux/license-inventory.json`。隔离真实 Electron 通过英文切换、重开持久化以及运行时崩溃后重新连接。原生弹窗的已本地化参数由夹具截获核对。以原数据目录和默认 profile 重开正在使用的桌面，复核 1 个项目、4 个会话及原网关设置。重开前的 SQLite 备份通过完整性检查。
- **开发过程 review**。复用现有设置页夹具保留草稿与断言，单独用真实 Electron 覆盖只有主进程才能证明的恢复和跨端口持久化。第一次打包检测到词条并行改动后停止，最终从稳定输入重新生成。活动窗口正常关闭后，历史环境缺少有效显示参数，显式使用当前 Wayland 会话完成重开。

## 2026-11-23 · 会话内执行明细排版

- 折叠行优先显示工具名和已记录的说明，下一行预览命令或目标。展开后分区显示时间、参数与回执，长参数在区块内滚动。状态标签使用工作台主题色。
- `npm run check`、`npm test`、`npm run build` 和 `npm run build:desktop` 通过。383 项测试通过，既有 WebFetch 集成用例跳过。Chromium 复核 1280、1440、1920 像素视口及中英文标签。隔离 Electron 使用回环夹具验证调用展开、日志分页和下载。当前工作台的重启被权限审查拦截，需用户明确授权。回退只涉及本节对应的卡片渲染和样式，无数据迁移。
- **开发过程 review**。复用工具详情的视口测试与 Electron 日志夹具。第一次截图发现长参数挤占回执空间，调整后以滚动高度断言和真实窗口复验。

## 2026-11-23 · 完整工具输出弹窗

- 工具输出弹窗随视口扩展至 1080 CSS 像素。完整 JSON 默认缩进，读取工具的嵌套摘录单独展示，可切换原文。分页、下载和原始字符计数仍按原回执处理。
- `npm run check`、`npm test`、前端及桌面构建通过。387 项测试通过，既有 WebFetch 集成用例跳过。隔离 Electron 复核中英文标签、420/1280/1440/1920 像素视口、原文切换、焦点恢复及原有日志分页下载。回退范围为工具输出弹窗样式、展示格式和词条。
- **开发过程 review**。同一隔离窗口先走真实日志分页下载，再用固定 JSON 回执核对摘录与尺寸，避免引入外部模型或访问用户数据。

## 2026-11-23 · 工具卡片的命令分行

- 简单的单行 Shell 命令在外层分号处视觉换行，保留引号、转义及子命令内的文本。已有多行布局和复杂语法沿用原格式。显示分行不会改变选中或存储的命令文本。
- `npm run check`、`npm test`、前端和桌面构建通过。389 项测试通过，既有 WebFetch 集成用例跳过。隔离 Electron 确认同一原始命令显示为六行，并验证日志分页和下载。回退范围为工具详情的命令显示逻辑和样式。
- **开发过程 review**。用同一条浏览器断言检查视觉位置与选中原文，再用隔离窗口确认分行和回执在实际布局中的表现。

## 2026-11-23 · 引用所选文字

- 助手正文的同一消息内可跨段选取，松开指针后显示「引用所选」。支持 `Alt+Shift+Q` 添加片段、Esc 收起和原有整条引用。片段按来源和选文去重，并可独立移除。旧格式草稿和提交接口兼容。[决策记录](../../../docs/decisions/2026-11-22-composer-quotes-and-insert.md)
- `npm run check`、`npm test` 和前端、桌面构建通过。389 项测试通过，既有 WebFetch 集成用例跳过。隔离 Electron 完成中英文操作、选区定位、同一回复录入两张卡片和重新加载草稿。Chromium 复核跨消息拒绝、去重、换会话、字符上限和按原流程发送。回退范围为选区入口、草稿引用字段和词条。
- **开发过程 review**。复用消息操作测试与隔离 Electron 夹具，把选择范围、草稿恢复和发送正文串在同一流程，避免为样式另建应用测试入口。
- 文件说明批次 `selection-quote / 8eaf436 + 源码快照` 已核对。集中更新五份文件头，`npm run check:headers -- --files …` 通过。

## 2026-11-23 · 输入区上下文与缓存面板

- 模型选择旁显示可用窗口百分比。点击可查看 SDK 有效窗口、占用分类、压缩预留与最近一次模型请求的缓存计数。快照随运行持久化，完成后更新。[技术决策](../../../docs/decisions/2026-11-23-context-window-usage.md)
- `npm run check`、`npm test`、前端与桌面构建通过。395 项测试通过，1 项既有 WebFetch 用例跳过。隔离 Electron 用回环夹具验证 1280×800 中文和 1440×900 英文、60% 命中率、键盘与草稿、重开后读取。独立 SDK 探针验证手动压缩边界前后的摘要。[测试记录](../../../docs/claude-code-comparison.md) · [验收证据](../../../docs/evidence/agent-eval/2026-11-23-context-window-panel.json)
- 开发过程 review 先用一条真实 SDK 请求确认成功结果与关闭连接之间的可用窗口，再复用同一个夹具验证页面及 SQLite。调整点外点击时，以弹层实际覆盖范围选取视口坐标。

## 2026-11-23 · 前端设计系统与工作台改造

- 统一暖灰与橄榄绿的表面、状态与焦点语义。工作区、聊天、浏览器、检视器、设置、扩展和智能体迁移共享控件及 Lucide 图标。将旧的聊天与弹层样式迁到所属模块，移除无消费者的原型选择器。Motion 异步功能块用于连接与操作反馈，CSS 和 React 均响应减少动效。将 `check:ui` 接入常规检查。[设计规范](../../../frontend/DESIGN.md) · [技术决策](../../../docs/decisions/2026-11-23-frontend-design-system.md)
- `npm run check`、前端及桌面构建通过，398 项测试通过，既有 WebFetch 用例跳过。隔离 Electron 复核三种桌面视口、680px 导航抽屉、中英文、草稿、原生网页输入、分栏、叠层遮挡和恢复，以及日志分页下载。首屏 CSS gzip 从 18.92 降至 13.53 kB，JS 从 197.76 增至 207.97 kB，Motion 功能异步块为 18.90 kB。活动桌面切换待授权。[验收记录与复现](../../../docs/evidence/frontend-design-system/2026-11-23.md)
- **开发过程 review**。用同一隔离上下文夹具覆盖浏览器输入、布局、弹层、重开与截图。首次加载轨迹时焦点丢失，按同一通路收窄 Suspense 后复验。下次修改路由内容时，将首次异步加载的焦点断言与界面调整放在同一批次。
- 文件说明批次 `frontend-design-system / 当前源码哈希快照` 完成。按指定模型的只读建议复核，集中更新 22 份文件头。`npm run check:headers -- --files …` 覆盖本轮 76 份源码并通过。

## 2026-11-23 · 输入框上方的任务清单

- 当前运行的任务清单与输入框等宽，默认展开，支持键盘和鼠标折叠。完成数随运行快照更新，已完成的条目显示勾选和划线。运行结束后保留最终状态。进入下一轮后可在旧消息中展开对应清单。没有任务计划的当前运行隐藏输入框上方的清单。[实现说明与数据流](../../../docs/chat-task-plan.md)
- `npm run check`、`npm run build`、`npm run build:desktop` 通过。`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 通过 399 项，既有 WebFetch 用例跳过 1 项。任务交互断言位于 [消息操作回归](../../../frontend/src/features/chat/message-actions.test.ts)。隔离 Electron 45.4.1 通过本地回环模型和真实 SDK 的 `update_plan` 请求核对 `0/2` 至 `2/2` 的更新、折叠保持、历史查看与中英文。1280×800、1440×900、1920×1080 和 680×800 下检查清单宽度与输入框一致，本机截图在 `.local/task-plan-completed-zh.png`。回退范围为聊天渲染、样式和词条。
- **开发过程 review**。把切会话、折叠保持和新一轮历史归属加入现成的渲染回归，隔离桌面集中走一次真实工具更新。窗口调整后在同一个渲染帧读取清单和输入框边界，避免两次读取跨过窗口尺寸变化。
- 文件说明批次 `composer-task-plan / c1997a1 + 源码哈希快照` 已完成。核对建议与输入哈希后更新四份文件说明，`npm run check:headers` 的本次文件检查通过。本机输入清单位于 `.local/task-plan-headers.pKbLaq/input-sha256.txt`。

## 2026-11-23 · 工作台配色与对话流

- P0 统一品牌和选中色，修正 48px 顶栏、侧栏时间、待审批状态与本机信任提示。上下文显示剩余百分比及旧样本标记。P1 历史执行明细使用时间轴，补充失败计数、退出码和恢复进度。历史消息操作按需显现并保留键盘、复制反馈和触屏入口。回退范围为前端、词条和侧栏烟测断言。
- 类型、i18n、样式门禁和前端、桌面构建通过。404 项测试通过，1 项既有 WebFetch 用例跳过。Chromium 复核六主题与三种视口，隔离 Electron 复核原生分屏和执行明细。系统中文输入法实机测试待补。[验收记录与机器证据](../../../docs/evidence/frontend-design-system/2026-11-23-workspace-polish.md)
- **开发过程 review**。用同一合成 API 夹具核对主题、视口、权限和执行状态。用 `31b769f` 的隔离副本复现侧栏旧断言，再按按钮实际边缘修正。后续修改控件尺寸时直接测量相邻边界，并组合验证输入框初始高度和长文本封顶。

## 2026-11-23 · 实机验收后的输入区微调

- 24px 渐变覆盖聊天滚动区底缘，并让队列与新消息按钮显示在渐变上方。任务清单位于上下文和权限工具栏上方。短清单全部完成时自动收起，手动展开或收起的选择随当前运行保留。
- `npm run check`、`npm run build` 和文件说明门禁通过。全量测试 404 项通过，1 项既有 WebFetch 用例跳过。Chromium 的 [消息操作回归](../../../frontend/src/features/chat/message-actions.test.ts#L925) 检查渐变尺寸与点击穿透、清单顺序、从进行中到完成后的收起及键盘重开。`node --import tsx scripts/smoke-context-usage.mts` 首跑在关闭弹层后的即时焦点断言失败，原样复跑通过，覆盖原生分屏、输入和草稿。
- **开发过程 review**。把清单状态更新与渐变属性放进同一个现有浏览器用例，隔离桌面复用现有烟测验证原生层。

## 2026-11-23 · 前端类型与纯功能逻辑目录规范收敛

- 清理函数/闭包内部嵌套类型（`server/codex-model-catalog.ts`、`server/session-checkpoint.ts`），将散落全局声明（`Window`、`HistoryState`）集中至 `frontend/src/types/`。
- 建立统一纯功能工具目录：`frontend/src/utils/format.ts` 集中 `formatBytes`、`formatDate`、`formatDuration`、`formatSessionTime`，消除多处重复造轮子。
- 业务领域模型四件套收敛：从 `.tsx` 视图组件剥离纯功能函数与状态类型至对应的 `*-model.ts` 或 `*-utils.ts`（包括 `diff-model.ts`、`subagent-progress-model.ts`、`message-actions-model.ts`、`selection-quote-model.ts`、`spreadsheet-preview-utils.ts`、`file-preview-utils.ts`、`agent-model.ts`、`app/types.ts`），组件仅消费 props 呈现界面与分发回调。
- `npm run check`、`npm test`（404项通过，1项既有跳过）、`npm run build` 和 `npm run check:headers` 全量门禁通过。
- **开发过程 review**。通过静态扫描前置发现跨组件隐式契约依赖和重复工具实现，使用先建共享纯模块并保持原导出兼容路径的渐进迁移策略，一次性完成多领域组件瘦身并保持 100% 测试与类型安全。

## 2026-11-23 · 桌面窗口与浏览器面板收官

- Linux 和 Windows 默认隐藏原生菜单条，保留系统窗口框架和菜单。窗口持有当前主题的背景色。右侧浏览器将关闭操作并入 48px 标签栏，工具栏与语义状态条减高，变更记录改为贴右抽屉。工具摘要解码 HTTP(S) URL，紧凑回执和参数分别限高为 180px、120px。
- 类型、i18n、样式门禁和前端、桌面构建通过。408 项全量测试通过，1 项既有 WebFetch 用例跳过。隔离 Electron 核对 48px 顶栏对齐、标签切换和关闭、分隔条缩放、弹层遮挡与焦点恢复。Chromium 核对已完成清单首次挂载即收起。[验收记录与三栏截图](../../../docs/evidence/frontend-design-system/2026-11-23-desktop-final-round.md)
- **开发过程 review**。在一个现有 Electron 烟测中复用同一原生浏览器标签，验证抽屉、设置和上下文弹层。截图等待显示合成器完成全屏动画，再按隔离窗口几何裁取。弹层焦点测试按实际焦点恢复条件短时等待。

## 2026-11-23 · 移除输入区的全网搜索额度入口

- 移除全工具自动化模式旁的「全网搜索 Skill · 0 分」和额度弹窗，保留 `/` 调用 Skill、`#` 选择 MCP 和现有运行时费用校验。通过输入区发送继续采用 0 分默认额度。
- `npm run check`、前端与桌面构建通过。隔离 Chromium 的自动审批和消息操作回归 18 项通过，覆盖切换到全工具自动化后不再渲染搜索额度按钮。全量复跑通过 408 项，1 项既有 WebFetch 用例跳过。首跑的 Skill 子进程测试因临时测试文件 `state/ticks` 尚未生成失败，复跑通过。
- **开发过程 review**。在既有运行模式 Chromium 夹具补充断言，并复用现有发送与审批测试验证费用默认值。

## 2026-11-23 · 输入区权限按钮颜色

- 本机信任与全工具自动化的触发器文字、模式图标和下拉箭头共用主题警告前景色，背景和边框继续使用同组语义色。Rose 警告前景与浅底对比度为 4.88:1。
- Chromium 检查六套主题、四种运行模式的实际计算颜色，24 组通过。用 `.local/frontend-regression-20261123/mode-colors.mts` 可复跑实际页面夹具。`npm run check:ui` 与前端构建通过。

- 实机复查后调整全工具自动化触发器，改与菜单当前项的高亮共用主题强调底色和前景色。本机信任继续使用警告色。六主题、四种模式的 Chromium 回归通过，并直接比较了六主题全工具自动化触发器与展开菜单当前项的计算前景及底色。复跑夹具为 `.local/frontend-regression-20261123/mode-colors-accent.mts`。

## 2026-11-24 · Git 看板与开发会话 · 已验证

- 项目选择器和会话顶部均可打开 Git 看板。Node 运行时读取暂存、未暂存、未跟踪、冲突、分支占用及分页提交。独立开发会话可用当前工作树的 HEAD、本机分支或提交创建。显式原目录切分支检查工作区和待处理任务。并发和上下文引用按实际目录解析，历史分出的会话继承工作树。[使用说明](../../../README.md#git-看板与开发会话) · [技术决策与回退](../../../docs/decisions/2026-11-24-git-development-sessions.md)
- 最后一个关联会话归档才尝试回收。验证失败时保留目录。已验证的快照能还原 Git 索引、未暂存内容和未跟踪文件。真实本机 Git 加临时 SQLite 覆盖了 Git 归一化隐藏的字节差异、忽略文件、占用分支、缺失目录、受损快照、回收中断、v7 升级与跨数据根迁入。Linux bubblewrap 用例验证受控命令可以在 linked worktree 执行，且 Git 元数据被遮蔽。
- 基线 `0d3b184`，最终运行 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build`、`npm run build:desktop`。运行时 315 通过、1 个既有用例跳过，前端 115 通过。文件说明按源码哈希与单批只读建议核对，68 份源码头检查通过。
- Linux x64 Arch 工件 SHA-256 为 `e624dbb79be2044fc1a78dc9d06c2c90d79d93eb4c455f65be5571223b825301`。用实际工件解出的 Electron 45.4.1、Claude Agent SDK 0.3.326 和本地回环模型走通中英文创建、差异及提交浏览、按工作树补全文件、两个并行审批中的相对读取与同名文件写入、重开恢复和历史分支继承。验收入口为 `node --import tsx scripts/smoke-git-workbench.mts <Arch 包路径>`，本机工件、截图和原始日志位于 `.local/git-workbench-20261124/`。回环仅替代模型传输。
- 旧窗口正常退出后验证了 v7 SQLite 的可恢复副本。活动窗口随后使用当前源码的开发态重开，542 个 renderer 文件与已验收安装件逐个字节相同。保留原数据目录和 Chromium profile，本机网关健康检查返回 200。确认 2 个项目、12 个会话、119 条运行、9 个附件、12 个交付物与副本一致，6 个设置键值逐字节相同。当前 `.data` 与一处已绑定项目重叠，创建独立工作树需使用与所有项目检出分离的数据根。
- **开发过程 review**。先用本机 Git 对照索引和文件，再用同一个安装态夹具覆盖两个会话、审批和恢复，避免用替身的模型回答代替工具证据。审查用例促成了完整文件字节校验和实际分派前复核。工作台同期的 OpenWiki 任务已生成 Git 专页。下次应在第一次安装态验收中把截图布局和文件引用断言一起核对。

## 2026-11-24 · Git 差异侧栏与高亮

- Git 在桌面宽窗口打开右侧分栏，支持鼠标和键盘调宽。全窗口和侧栏共用同一内容实例，切换时保留工作树、文件和提交选择。窄窗口直接使用全窗口。关闭 Git 后恢复内置浏览器的原生标签。文件和提交差异展示原、新行号及增删统计，按语言加载语法高亮。[技术决策与回退](../../../docs/decisions/2026-11-24-git-diff-panel.md)
- 基线为 `0d3b184` 加工作区源码哈希。通过 `npm run check`、`npm test`、`npm run build`、`npm run build:desktop`。运行时 315 项通过、1 项既有 WebFetch 用例跳过，前端 118 项通过。文件说明单批只读核对 12 份输入，复核边界修正后 `npm run check:headers` 检查 12 份通过。
- Linux x64 Arch 安装件 SHA-256 为 `7b94cb6b805fa2701358ba5380d819b67be22451332849d2314f461cd35e23c8`。隔离 Electron 核对 1280×800、1440×900、1920×1080 和 1000×720，覆盖中英文、TypeScript 和 Markdown 高亮、增删行号、明暗配色、鼠标和键盘拖动、全窗口和焦点恢复。真实 WebContentsView 隐藏后恢复到原标签和地址。真实 SDK 与本地回环模型复验独立工作树和归档恢复。工件、截图、构建和安装烟测原始日志位于本机 `.local/git-diff-panel-20261124/`。
- 原窗口正常退出后用原数据目录和浏览器 profile 打开新版。542 个 renderer 文件与安装件逐项一致，运行时页面和本机网关均返回 200。保留 2 个项目、12 个会话、119 条运行、9 个附件和 12 个交付物，网关及工具设置字节一致。在线核对期间写入了工作区布局和位置，保留实时偏好。
- **开发过程 review**。在现有安装烟测集中验证分栏、原生浏览器和会话，再用相同布局复现极限拖动把 408px 导航压到 190px。修正右栏上限后确认导航和浏览器偏好稳定，并把极限拖动纳入既有烟测。下次在首轮安装验收直接验证默认宽度和用户已保存的宽布局。

## 2026-11-24 · Git 文件视图与 AI 提交

- 文件视图按暂存状态组织文件，显示类型图标、名称、目录、变动标记和语法高亮。选定工作树后可用 AI 起草暂存提交说明。用户核对清单，按需编辑标题和正文，再确认由本机 Git 提交。暂存或分支变化时重新核对，手写内容继续保留。[技术决策与回退](../../../docs/decisions/2026-11-24-ai-git-commit.md)
- 基线 `0d3b184` 加本次源码哈希。通过 `npm run check`、`npm test`、`npm run build`、`npm run build:desktop`。运行时 316 项、前端 118 项通过，1 项既有 WebFetch 用例跳过。单批文件说明整理后 `npm run check:headers` 检查 19 份通过。
- Linux x64 Arch 安装件 SHA-256 为 `32ef9fb05abd8cc758cd8cb56e069c48e073b1db799f6a07b16820c90701a9de`。真实 Electron、系统 Git 和回环模型验证中文生成、英文手填降级、旧暂存版本拒绝、编辑内容逐项落入提交、所选独立工作树作用域、未暂存内容保留和提交阶段的零模型请求。另用真实 Git 验证 SHA-256 首次提交、分离索引、改名与分离 HEAD。工件、截图和原始日志位于 `.local/ai-git-commit-20261124/`。
- 旧窗口正常退出后用原数据根和浏览器 profile 打开新版。545 个 renderer 文件与安装件逐项一致，运行时页面与本机网关均返回 200。核对 2 个项目、13 个会话、120 条运行、9 个附件、12 个交付物与 6 个设置记录。
- **开发过程 review**。API 回环夹具审计模型输入和确认次数，安装烟测再核对同一份草稿的实际编辑与 Git 结果。正文字段标签在有草稿时超时，使用最小 Chromium 页面确认嵌套标签混入了值，再验证分离后的标签。英文入口的点击验收用 Electron 实际内容尺寸，避免在超过原生窗口的模拟坐标上判断控件。

## 2026-11-25 · 文件变动滚动与逐文件暂存

- 文件行显示暂存与取消暂存按钮，快捷提交和 Amend 使用当前索引。取消新文件的暂存后，该文件回到未跟踪分组。文件列表用独立的细滚动条，提交区置于列表下方，窄侧栏增大文件区，储藏区默认折叠。[取舍与回退](../../../docs/decisions/2026-11-25-git-file-staging.md)
- 在隔离开发态 Electron 和真实 Git 中验证中英文操作及失效文件提示、无暂存时的快捷键保护、仅提交选中的文件，以及 1280×800、1440×900 和 450px 宽侧栏布局。真实 Git API 用例另覆盖字面路径、重命名、过期状态和首次提交前取消暂存。证据位于 `.local/git-file-staging-20261125/`。
- 正常退出旧桌面后从原数据目录和 Chromium profile 打开新构建。原工作区有效，新版首页与构建输出一致，本机网关健康检查通过，原数据库的 2 个项目、16 个会话、123 条运行和 7 条设置记录可读。
- **开发过程 review**。把滚动区高度、滚轮、提交区位置和 Git 索引结果放入同一套 Electron 夹具。全局继承的滚动条颜色覆盖了 Chromium 的尺寸样式，用窄侧栏截图定位后在文件列表内修正。下一次调整面板先检查各容器的计算样式，再跑窄宽和标准视口。
- 文件说明批次按本次验收源码哈希复核并集中更新，`npm run check:headers` 检查本轮 12 份文件通过。
- `npm run check`、`npm run build`、`npm run build:desktop` 和 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 已通过。测试为运行时 676 项、前端 119 项通过，1 项既有用例跳过。超大 diff 回归样本按当前 8,000 行上限修正。中间一次技能 broker 测试出现 `BrokenPipeError`，完整重跑通过，原始失败日志已保留。

## 2026-11-25 · Claude Agent SDK 补丁升级

- SDK 0.3.332 和配套 Claude Code 2.1.332 已落到项目依赖。同步三处真实 SDK 测试夹具的版本断言，保留 2.1.326 格式的历史分叉夹具。[版本依据与回退](../../../docs/decisions/2026-11-25-claude-agent-sdk-0332.md)
- 隔离候选通过类型检查、前端和桌面构建及全量测试。676 项运行时测试和 119 项前端测试通过，1 项既有跳过。Arch x64 安装件 SHA-256 为 `2961906183b680c6951a7ce8824806dad704aafbf5075f74076a0ebdf223a31a`。从实际安装件解包，用 Electron 和回环模型验证 2.1.332 启动、受控审批前文件保持原文、批准后的真实 MCP 写入和运行记账。
- 旧桌面正常退出后打开新版，沿用已有数据、Chromium profile 和本机网关。页面资源与验收构建一致，网关健康检查返回 200。在同一数据库核对了 3 个项目、19 个会话、124 条运行和 7 条设置。依赖扫描、隔离补丁批次和原始日志位于 `.local/dependency-upgrade-20261125/`。
- **开发过程 review**。用只更新测试版本断言前后的两次回归，明确区分测试固定版本和真实 SDK 行为。安装烟测首次用了默认本机信任模式，加入明确选择受控修改后重跑通过。下次在烟测发起请求前核对运行模式，直接记录 CLI 版本和审批轨迹。

## 2026-11-25 · 依赖维护和 PR 检查

- 在仓库添加每周 Renovate 扫描和 Linux x64 PR 检查。前端补丁可以成组提 PR，SDK、Electron、原生依赖和大版本先在 Dashboard 审批，PR 由维护者合并。文件预览、PDF、表格及 Markdown 渲染依赖由用户单独维护。[选型、验证和回退](../../../docs/decisions/2026-11-25-dependency-updates.md)
- 更新 TanStack Query 5.108.4、React 类型 19.3.1、i18next 27.2.8、React Resizable Panels 4.24.2 和 tailwind-merge 3.7.1。核对锁文件只有这五项及配套的 query-core 发生变化。Node 24.21.0 的干净安装通过类型检查、前端及桌面构建，运行时 676 项、前端 119 项通过，1 项既有跳过。隔离真实 Electron 核对了中英文交互、拖动侧栏以及暂存和提交。
- Renovate 44.262.1 仓库配置通过严格校验。提取试跑只识别两个预定清单，查询日志确认文件预览、PDF.js 和 Markdown 预览依赖被排除。工作流通过 actionlint，另外用 Ubuntu 24.04 用户态验证了安装动态加载器链接前后的真实 bubblewrap 探针。GitHub App 授权和首次远端工作流运行待完成。证据位于 .local/renovate-ci-20261125/。
- **开发过程 review**。先核对实际 lockfile 节点，再做干净安装，避免把缓存安装误当成 CI 证据。复用了隔离 Electron 入口，提前发现 npm ci 对 Electron 45 采用按需下载。下次配置 Linux runner 时先对照命令沙箱的动态加载器路径，再启用必过检查。

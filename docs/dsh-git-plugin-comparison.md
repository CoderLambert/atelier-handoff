# dsh-plugin-git v0.2.14 对 Atelier Git 工作台的参考价值

建议优先完善按层丢弃，再让同文件的两层差异可以一起核对，随后在现有提交历史里加可选拓扑图。远端协作适合从只读 PR / Issue 和网页跳转起步。对照范围为 dsh-plugin-git `v0.2.14` 和 Atelier `3b7f45d`。

## 插件能力与 Atelier 现状

| 能力 | dsh-plugin-git v0.2.14 | Atelier 当前入口 |
| --- | --- | --- |
| 文件变更 | 按暂存、未暂存、未跟踪分组，支持暂存、取消暂存和确认后丢弃。文件差异可独立开标签，由宿主 DiffBlock 显示。 | 已按层显示差异并逐文件操作索引。丢弃入口传路径，未传递用户所选的变更层。 [上游文件操作](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/src/service.ts#L198-L339) · [Atelier 文件面板](../frontend/src/features/git/git-views.tsx#L398) |
| 提交与同步 | 提供 Commit、Amend、Commit & Push、Commit & Sync。同步先 rebase 并自动储藏，再推送。可用会话模型或指定模型生成可编辑的暂存提交说明。 | 已有暂存提交、AI 多提交计划及独立的 fetch / pull / push / sync，也有 stash 和 cherry-pick 入口。 [上游提交与同步](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/src/service.ts#L209-L267) · [Atelier 同步](../frontend/src/features/git/git-sync-button.tsx) · [AI 多提交](decisions/2026-11-24-ai-multi-commit.md) |
| 分支与历史 | 会话输入区有分支和变更入口，历史页显示提交轨道、分支和标签，并自动分页。可查看当前 HEAD、全部或首父链。 | 已有分支筛选、关键词 / 作者 / 日期检索、提交详情和触底分页。当前提交契约只包含 OID、作者、日期和主题。 [上游图谱说明](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/docs/reference/git-graph-layout.md) · [Atelier 历史决策](decisions/2026-11-25-git-history-and-branch-workbench.md) · [提交契约](../shared/git-workbench.ts#L110) |
| 工作树 | 识别会话实际目录和仓库检出。按宿主能力创建或进入其他检出。 | 已有与会话绑定的工作树、基于 HEAD / 分支 / 提交创建开发会话、归档快照和恢复。 [上游工作树](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/README.zh.md#用户体验) · [Atelier 开发会话](decisions/2026-11-24-git-development-sessions.md) |
| 远端协作 | 在宿主提供凭据能力时，支持 GitHub / GitLab PR、MR 和 Issue 的浏览与部分受保护写操作。平台账号与 Git 传输凭据独立。 | Git 同步已有独立入口。平台内容可以从当前分支所关联的 PR / MR 查阅切入。 [远端 RPC 契约](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/docs/reference/remote-platform-rpc.md) · [Atelier 同步入口](../frontend/src/features/git/git-sync-button.tsx) |

## 建议的借鉴顺序

1. **按层丢弃文件变更。** 从未暂存区操作时恢复到暂存区版本，已暂存内容应保留。将索引和工作区一起恢复到 HEAD，以及删除未跟踪文件，各用明确的操作和确认文案。用临时 Git 仓库直接调用 Atelier 当前桌面服务实测。同一个文件的 HEAD、索引、工作区分别为 `head`、`staged`、`working` 时，当前 `gitDiscardFiles` 会把索引和工作区都恢复为 `head`。对照的 Git 按层操作把工作区恢复为 `staged`，索引仍为 `staged`。落实时优先覆盖双层修改、首次提交前的新文件和暂存后再编辑的重命名。上游部分撤销路径分多条命令执行，移植时需要报告部分成功。 [Atelier 丢弃实现](../desktop/host/git-service.mts#L351) · [上游按层撤销](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/src/service.ts#L280-L339)
2. **同文件两层差异可同时核对。** 上游用路径及暂存状态区分 diff 标签，重复打开同一比较会切回原标签并刷新。Atelier 已有 `{ path, layer }` 选择，可以用工作树 ID、路径和比较基准标识每份差异，在现有侧栏提供两个独立视图。验收时用同名文件和两个工作树，确认切换、重复打开和刷新归属正确。上游未跟踪 diff 仅显示提示，这项交互可独立借鉴。 [上游标签定义](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/src/client/tab-definitions.ts#L55-L72) · [上游 Diff 加载](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/src/client/surfaces/GitDiffSurface.tsx#L34-L75) · [Atelier 选择入口](../frontend/src/features/git/git-views.tsx#L398)
3. **在现有历史列表加可选拓扑图。** 用父提交关系画分叉和合并，将分支、tag 作为提交上的标记。上游跨页继承轨道状态，首父链模式适合梳理某条分支的集成历史。Atelier 可复用现有分页与详情，图模式增加父提交与 ref 数据。搜索隐藏中间提交时仍要保留真实的合并关系。上游 UI 固定三条轨道，超限会省略边，画布随累计行数增高。窄屏简化应让省略可见，并用多分支、多页合并历史验证连线和开销。 [上游图谱布局](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/docs/reference/git-graph-layout.md#L45-L99) · [上游画布](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/src/client/GitGraphCanvas.tsx#L72-L105)
4. **远端协作先做只读入口。** 可从当前分支查看关联 PR / MR 的状态、审核和讨论，并跳转网页。后续若引入检出、评论或合并，值得沿用上游的仓库与账号绑定、预期提交 SHA 核对，以及发送后结果不明时先按目标刷新再确认。上游记录有部分真实 GitLab.com 读取证据，自建部署、完整 OAuth 和远端写仍有验收缺口。 [远端回执契约](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/docs/reference/remote-platform-rpc.en.md#L144-L169) · [上游验收状态](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/docs/plans/active/remote-platform-integration.md#L9-L19)

上游把会话模型、指定模型和提交模板做成显式选项，可以作为设置交互参考。其生成实现把限长后的原始暂存差异传给模型。Atelier 继续沿用已有的凭据过滤、逐组预览及确认。上游 Changes 面的两组批量暂存按钮都走 `git add --all`，若引入组级操作，应按可见组的范围执行。宿主通过 DSH 专属服务注册侧栏与凭据能力，适合复用交互与数据契约的思路，由 Atelier 现有模块承接。 [上游模型实现](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/src/commit-message.ts#L147-L174) · [上游分组调用](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/src/client/details/ChangesTab.tsx#L39-L63) · [宿主兼容契约](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/docs/reference/dsh-compatibility.md)

证据范围为固定版本文档、源码与 Atelier 桌面 Git 服务的临时仓库实验。上游 DSH 界面、远端账号操作与 Atelier Electron 用户流程在本轮均未运行。

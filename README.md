# atelier. · 本机 AI 工作台

面向个人项目的 AI 工作台。现已接通真实对话、工具轨迹、逐次审批、文件操作、停止与续接、附件、成果和历史。底层使用官方 Claude Agent SDK，通过本机 Shunt 调用 `gpt-6.1-sol`。

现有浅色三栏设计继续沿用。原来的静态演示完整保留在 [prototype/](prototype/index.html)，与真实应用的数据和执行逻辑分开。

## 桌面版

Linux x64 本地样包在 `dist/linux/`。Arch/Omarchy 可在仓库根目录运行 `sudo pacman -U ./dist/linux/atelier-0.2.0-1-x86_64.pkg.tar.zst`，然后从应用菜单打开 atelier。便携版可用 `tar -xf dist/linux/atelier-0.2.0-linux-x64.tar.zst -C <空目录>` 解包，从该目录运行 `./atelier/atelier`。包内含 Electron、Node 24.21.0、SQLite、SDK CLI 和静态资源，模型请求使用本机 Shunt。

发行版的数据默认写入 `$XDG_DATA_HOME/atelier`（默认 `~/.local/share/atelier`），浏览器 profile 位于该目录下的 `desktop-profile`。可通过绝对路径 `ATELIER_DATA_DIR` 选择其他数据根。同一数据根使用单写者锁。

迁入旧版数据时先退出旧工作台，启动 `atelier --import-data` 并选择包含 `atelier.sqlite` 的目录。若默认位置已经有工作区，使用 `ATELIER_DATA_DIR=/新工作区的绝对路径 atelier --import-data`。目标目录在迁入时创建。向导显示回退副本位置，项目、会话、附件和交付物记录随数据库迁入。网页使用新 profile，打开网站后可重新登录。

构建机安装包依赖 `makepkg`、`pacman`、`bsdtar`、`tar`、`zstd` 以及固定版本 Node 的可执行文件和许可证。在项目根执行 `ATELIER_BUILD_NODE=/绝对路径/node-v24.21.0/bin/node npm run package:linux`。`dist/linux/SHA256SUMS` 提供资源清单与工件校验，`release.json` 记录运行时版本。安装态验收入口为 `npm run smoke:linux -- --help`。

开发版从项目根运行 `npm run desktop`。先读[项目协作规则](AGENTS.md)。[桌面路线图](openspec/roadmaps/build-atelier-desktop/roadmap.md)和[发行选型记录](docs/decisions/2026-11-20-linux-release.md)说明当前阶段的交付范围。

## 启动

本轮验证环境：Node **24.21.0**、npm 11.19.0、Claude Agent SDK **0.3.326** / CLI **2.1.326**、Shunt **0.64.0**。Node 最低要求 24，推荐使用已验证版本。

```sh
cd /home/lambert/lambert-workspace/atelier-handoff
export PATH=/home/lambert/.local/share/mise/installs/node/24.21.0/bin:$PATH
npm ci
npm start
```

`npm start` 会先用 Vite 构建前端，再启动本地工作台。打开 **http://127.0.0.1:4317**。

开发时在两个终端分别运行 `npm run dev:server` 和 `npm run dev`，打开 **http://127.0.0.1:5173** 使用前端热更新。Vite 将 `/api` 代理到 `ATELIER_PORT`，默认为 `4317`。服务重启会中断未完成的运行，并保留历史。

应用默认连接 `http://127.0.0.1:3001` 的 Shunt。该网关已在本机配置；如果没有运行，可在现有 `/home/lambert/Projects/claude-code-demo` 项目中执行 `npm run gateway`。已经运行时无需重复启动。登录由 Shunt 的本机浏览器流程完成，工作台不会读取或复制其 OAuth 凭据。

首次进入页面，点击「选择文件夹…」打开系统目录选择框，选好后点击「绑定项目」。系统选择框需要服务从安装了 Zenity 的 Linux 桌面会话启动。也可手动输入绝对路径。新会话默认只读。切换到受控修改后，每次文件修改、删除和命令仍需单独审批。

## 已可使用的功能

- **项目与会话**：项目绑定、文件浏览、会话搜索、独立草稿、重命名、归档/恢复和删除。
- **真实执行**：流式文本、工具详情、按轮保存的 Run、背景运行状态、停止与只读恢复分析。
- **受控文件操作**：真实差异和操作原因，单次允许/拒绝，基线变化拒绝、审批过期、停止后迟到批准无效。同一项目的运行串行，避免应用内并发覆盖。
- **命令执行**：Linux 上通过 bubblewrap 隔离执行，逐次审批、无网络、最长 60 秒；隔离不可用时不开放命令工具，不退回无限制 shell。
- **上下文与附件**：项目内文本预览和选择，真实 UTF-8 文本上传，按会话隔离，发送时冻结引用。
- **成果**：Agent 明确发布的真实文档保存为不可变快照，可预览、下载并跳回来源运行；不扫描整个项目冒充成果。
- **恢复与记录**：SQLite 保存消息、运行、审批和事件；SSE 断线补齐；重启后保留历史并区分 interrupted。会话可以续接，旧的在途操作不会自动批准。
- **计划与用量**：仅显示 Agent 实际调用结构化计划工具产生的步骤；显示真实可得 token 数据。费用未知时明确显示未知，SDK 估算不冒充账单。
- **长内容**：会话/全局列表分页，工具输出保留预览并支持完整内容分页及下载；不靠等待时间生成进度。

## 项目智能体

打开侧栏「智能体」，选择项目并使用「资料整理助手」模板，或自己填写任务说明和开场任务。按需选择内置能力、项目 Skill 和具体 MCP 工具。新建智能体默认只读，创建时也可选择「受控修改」。从卡片的「开始会话」进入绑定版本的会话。会话以只读开始，允许受控修改的智能体可在输入框切换模式。

编辑保存会创建新版本，已有会话保留原配置。依赖升级、停用或撤销授权后，在智能体编辑器中检查依赖并保存新版本。受控修改模式中的文件操作、命令和需审批的 MCP 工具沿用逐次审批。

## 扩展与对话调用

在侧栏打开「扩展」并选择项目。Skills 和 Commands 分别管理 `SKILL.md` 与 Markdown 指令模板。导入时可预览内容。保存并启用后，在对话输入框输入 `/` 选择，或直接发送 `/summarize src/` 这类已经登记的指令。模板中的 `$ARGUMENTS` 会替换为用户输入的参数。

「从公开来源导入」支持 GitHub 仓库或文件链接。Skills 与 Commands 标签可以浏览相应 Markdown 文件。MCP 标签还可以搜索官方 MCP Registry，或从 GitHub 导入 `.mcp.json`、`mcp.json` 和 `server.json`。预览并导入后，卡片上的「检查更新」会按原来源检查新版本，预览后可以应用更新。

在扩展页打开「Skill 市场」可浏览 SkillHub 的推荐和分类，搜索并预览后导入当前项目。

已启用且允许自动调用的 Skill 会按项目提供给 Agent SDK。模型根据名称和描述决定是否使用，调用时读取本地固定版本的正文。可在 Skill 卡片上改为仅手动调用，或使用 `/` 明确选择。执行轨迹会分别显示候选情况和实际调用版本。Skill 沿用本轮项目权限。

桌面工作台右侧「浏览器设置」可开启「允许 Agent 使用内置浏览器」。项目授权一次后，桌面对话可使用网页导航、读取和截图。让 Agent 点击网页时保持右侧浏览器面板打开。受控修改模式下，点击与输入按操作审批。人工接管优先，交还时 Agent 接续所选的标签。

输入区可为一条消息选择「全工具自动化」。本轮已授权的文件写入、删除、沙箱命令、Skill、MCP 和浏览器操作由工作台自动审批，可从执行轨迹查看。计费 Skill 搜索以发送前填写的单笔上限为准，默认额度为零。下一条消息使用普通模式。

MCP 页支持 Streamable HTTP 和 stdio。导入 MCP 配置后可核对地址、启动参数及凭据环境变量，再测试连接、选择允许的工具并启用。输入 `#` 选取本轮要用的工具。需审批的工具可在「受控修改」模式中使用。

SkillHub 支持预览并安装完整技能包。安装后点「到对话中使用」，或在输入框用 `/` 选中。读取包内文档可在只读模式使用。执行包内 Python 需要 Linux bubblewrap、受控修改模式和逐次审批。已审核的「全网搜索」v1.0.3 通过固定服务连接完成报价、确认并提交搜索、取回原请求结果，PDF、Markdown 和 CSV 会保存在交付物中。

## 本机配置与数据

可参考 [.env.example](.env.example)。根目录 `.env` 自动加载但不会进入 Git；不要把真实凭据提交到仓库。首次默认配置来自环境变量，之后网页保存的模型/网关设置优先。

| 配置 | 默认值 |
| --- | --- |
| ATELIER_PORT | 4317，仅监听 127.0.0.1 |
| ATELIER_GATEWAY | http://127.0.0.1:3001 |
| ATELIER_MODEL | gpt-6.1-sol |
| ATELIER_GATEWAY_TOKEN | local-placeholder，仅供当前本机 Shunt |
| ATELIER_DATA_DIR | 本项目 .data/ |

`.data/` 包含 SQLite、SDK 会话、附件、成果快照和完整工具输出，已从 Git 排除。停服后可备份整个目录。会话删除会删除其应用历史与关联文件，但不会删除项目源文件。不能同时用两个服务进程打开同一个数据目录。

## 当前边界

- 首版只面向本机单人使用，不提供团队账号、远程部署或后台无人值守任务。
- 附件只支持列明的 UTF-8 文本类型，单个最多 1 MiB；单轮附加上下文与附件合计最多 128 KiB。二进制、链接、凭据目录及过大文件有明确拒绝提示。
- 原生文件操作采用目录校验、单项目执行锁、审批基线复核与临时文件替换。它不是整机 OS 沙箱，也不保证与任意外部编辑器之间的文件竞争绝对原子。
- 同权限与相同模型配置下使用 SDK resume。切换权限范围/模型时，新建 SDK 上下文并带入应用保存的历史，避免沿用旧工具范围；历史超过限制会明确要求新建会话，不静默截断。
- 停止不回滚已经发生的修改。重试入口会新建一个只读分析 Run，避免直接重放写入。
- 默认每轮最多 16 个 Agent 轮次、5 分钟，并设置 1 USD 的 SDK 估算软预算；它不是实际账单上限。轮数与时间可在页面设置中调整。
- 当前会话使用完整消息快照刷新；超长会话的虚拟列表、性能调优和更细致的工程质量建设留到后续。
- Anthropic 不提供经网关运行非 Claude 模型的官方支持。本项目的兼容结论限定于记录的实际组合；ChatGPT 套餐的真实费用无法从 SDK 估算可靠推出。

## 代码格式化

```sh
npm run format        # 一键整理项目源码
npm run format:check  # 检查格式
```

格式化范围包括 React 前端、服务端、共享类型、脚本、测试和项目 JSON 配置。

## 检查与证据

```sh
npm run check
npm run build
npm test
```

本地检查使用真实 SQLite、HTTP、临时文件系统和隔离子进程；测试中的 SDK 边界替身与真实模型验收分开记录。

以下命令会调用真实模型，需先确认使用额度，并对**独立验收服务**运行：

```sh
ATELIER_PORT=4318 ATELIER_DATA_DIR="$PWD/.local/acceptance-data" npm start
# 另一个终端：6 个真实应用场景；只操作自动建立的临时测试项目
npm run test:live -- --authorized
# 最终工具关联/结构化计划/成果的单轮复核
npm run test:live -- --authorized --final-tools
```

当前实施与验收见 [本机首版完成记录](docs/local-release.md)，逐项状态见 [开发任务清单](docs/development-tasks.md)。源码提交按功能分批保存在本地 Git；没有自动推送或部署。

## 目录

```text
frontend/src/app/                React 工作台、Redux 界面与草稿状态
frontend/src/api/                共用 API 客户端和响应类型
frontend/src/features/           对话、审批、轨迹、交付物、设置和扩展
frontend/src/components/ui/      shadcn/ui 组件与 Tailwind 样式接入
dist/client/                     Vite 前端构建产物
server/                          HTTP、SQLite、SDK、权限与文件服务
shared/types.ts                  共享实体与状态
scripts/verify-live.ts            真实 SDK 应用验收
tests/app.test.ts                 本地集成与边界检查
prototype/                       原始静态交互原型
experiments/t01-agent-sdk/        T01 独立能力验证及证据
docs/evidence/                  本轮可复核的验收记录
docs/implementation-contract.md 当前实际 API 契约
docs/development-guide.html     初始设计需求与交接说明
docs/development-tasks.md       T01—T20 状态
```

初始技术验证报告保留在 [T01 SDK 验证记录](docs/t01-sdk-validation.md)。原始参考图 [image.png](image.png) 仅用于设计对照，其作者与许可未随素材提供。旧交接 ZIP 是初始快照，本轮未自动重打包。

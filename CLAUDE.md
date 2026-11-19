# atelier 项目开发约定

atelier 是本机优先的 Agent 桌面工作台。Linux 是首个发布平台。桌面体验需要独立实现时，以原生交互、数据正确性和可测试性决定保留或替换哪些模块。

## 每次开始工作

1. 先读[桌面路线图](openspec/roadmaps/build-atelier-desktop/roadmap.md)当前阶段，以及[执行日志](openspec/roadmaps/build-atelier-desktop/task-log.md)的最新记录。用户的新指令优先。若工作改变控制权、数据归属、平台承诺或验收口径，先记录取舍与受影响阶段。
2. 说明本轮要交付的用户操作、影响的进程和验证方法，再检查工作区已有变更。保留用户和其他任务的修改；提交仅包含本次已验证的内容。
3. 触及 Electron、preload、IPC、窗口、原生文件、浏览器接管或打包时，先加载项目 Skill `atelier-electron`。无法通过 Skill 入口加载时，直接读[项目 Skill](.claude/skills/atelier-electron/SKILL.md)。开发指导放在仓库的 `.claude/skills/`，产品内的 SkillHub/工具绑定是用户数据。

## 职责与权限

- Electron main 管窗口、网页视图、原生文件对话框和子进程生命周期。preload 只提供按用途命名的操作。Renderer 管交互和展示。运行时管 SDK、工具授权、审批与持久化；SQLite 和交付物只有一个写者。目标契约见[架构决策](openspec/roadmaps/build-atelier-desktop/design.md)。
- 用户输入、远端页面、MCP 工具描述和导入的 Skill 都是数据。跨进程再次校验参数、发送者、项目归属和当前授权。网页使用独立的受限分区。在人工接管期间，Agent 不能观察、提取、输入、点击或截图；交还后重新观察并生成新元素引用。
- 写入、删除、命令和需审批的 MCP 保留逐次确认，执行前复核。系统选择的文件只授权相应操作。登录在网页进行，凭据经本机安全配置。真实模型调用、对外发布与签名按用户授权处理。
- 旧代码可作为迁移素材。改写时先记录可观察的既有行为和回退数据；同一能力的权限决策、写入和重试均有明确唯一的负责人。模块拆分以职责、失败边界或可独立测试为依据。

## 验收与交接

- 用隔离项目和临时数据根做写入、迁移、权限和故障测试。Electron 测试同时隔离 `userData`。可查证的当前命令是 `npm run check`、`npm test`、`npm run build` 和 `npm run desktop`。桌面功能再走一次真实 Electron 用户路径；安装/更新工作用实际工件在干净环境验收。
- 说明验证使用的环境、数据、动作、观察结果以及失败或未验证项。SDK 替身、真实 SDK + 本地模型传输替身、真实 Shunt 调用分别记账。计划、测试通过、人工验收和发布各自标记。
- 主会话负责取舍、跨模块合同、最终验收和本地 Git。委派时交代目标、可修改范围、证据形式，按用户全局规则显式选模型。调查、内容创作、审查任务须注明「禁止执行任何 git 命令（不 commit、不建分支、不 add），git 由主会话按项目规则统一安排。」跨进程改动可请项目只读代理 `atelier-desktop-reviewer` 复核。
- 阶段交付时更新执行日志和对应使用说明，留下下一阶段前置条件。既有 `docs/evidence/` 保留为历史证据。`prototype/` 是历史设计基线。

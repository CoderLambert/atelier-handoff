# 本机 Skill 继承与会话可用范围

## 背景与目标

用户确认按 `prototype/atelier-skill-settings.html` 实现。原扩展页管理项目安装的 Skill，但本机信任下，`mountHostSkills` 另将用户和工作目录的 `.claude/skills` 整目录交给 SDK；本机项既不可见，也不能逐项关闭。保留项目扩展全部操作，将「本机继承 · 全局」作为并列入口，并在输入区提供「本会话 Skills」。

## 依据与取舍

- [Claude Agent SDK Skills](https://code.claude.com/docs/en/agent-sdk/skills)：`settingSources: []` 隔离隐式来源，`plugins` 挂载显式来源；`skills` 名单只约束主会话模型调用，不约束斜杠或子代理，`init.skills` 也不是自动调用名单。不能只做 UI 过滤或仅靠 SDK 名单。
- [Codex `skills_config.rs`（9f3cb25）](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/config/src/skills_config.rs)：区分名称与路径规则，在加载之前解析；Atelier 采用来源+稳定身份，避免同名项互相覆盖。[OpenCode `tool/plugin/skill.ts`（ea8aa5b）](https://github.com/anomalyco/opencode/blob/ea8aa5b05ef49af86d6c78dad0a19e2877e034e0/packages/core/src/tool/plugin/skill.ts)：列出与按 ID 调用校验分开；Atelier 同样由运行时校验而非信任 UI。
- 复用现有运行时、SQLite `settings` 键空间、扩展选择与运行队列，不引入依赖、数据库迁移或 Electron IPC。默认不继承用户目录，打开总开关只恢复逐项明确选择；项目可拒绝本机来源，会话可以降级或禁用、不能提高权限。项目 `.claude/skills/` 保留原有本机模式范围，独立标注。本机设置不改变系统文件权限、原有 workspace 路径、SDK 子代理调度或内嵌浏览器。
- 仅挂载本轮自动可用的文件系统 Skill，保留各来源的 SDK 命名空间和自动调用语义；启动时固定 `SKILL.md`，附属文件保留原路径的引用，不提供系统级隔离。仅手动项不挂载；用户显式选择时由工作台校验并加入本轮输入，保留对原目录附属文件的引用。依赖 SDK 调用前展开动态命令、fork 或 hooks 的文件系统 Skill 不承诺工作台手动等价，UI 显示不可手动。继续会话可能仍含历史中已读取的内容。
- 设置保存后，下一次新运行读取结果。运行中的 Skill 清单不会中途替换；消息入队时保存范围指纹，出队和插入边界复核，变化时保留未发送的消息。旧项目/草稿及历史兼容，源文件不改写。

## 验证与回退

临时 home、项目、工作树和数据根覆盖首次默认、切换、两会话、重启、同名、手动范围和队列。使用锁定 SDK 和回环模型检查实际请求及 Skill 回执，再从隔离 Electron 核对中英文和原项目管理入口。回退代码可忽略新增设置键，无需迁移或删除本机文件；旧版会恢复原来整目录继承行为，回退前须告知用户。

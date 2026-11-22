@AGENTS.md

# Claude Code 工作方式

通用技术决策规则在 `.claude/rules/technical-decisions.md` 中始终加载，其他领域规则按 `paths` 匹配。涉及 Electron 时，使用 `atelier-electron`，入口不可用时直接读 `.claude/skills/atelier-electron/SKILL.md`。设计或修改组件时读取 `.claude/skills/shadcn/SKILL.md` 及其按主题引用的规则。跨进程或发行变更的独立评审可交给只读代理 `atelier-desktop-reviewer`。

将新的长期约束写回 `AGENTS.md` 或对应领域规则，阶段进展与验证证据写入路线图执行日志。

<!-- OPENWIKI:START -->

## OpenWiki

@AGENTS.md

<!-- OPENWIKI:END -->

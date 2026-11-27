# 架构护栏收紧与遗留查询边界清零决策

## 背景

C1–C10 完成后，核心大文件均已按领域边界完成拆分，[check-query-boundaries.mts](../../scripts/check-query-boundaries.mts) 的遗留清单也从最初 12 个文件缩减至仅剩 `features/agents/{api,editor,index}.tsx` 3 个文件；但 `scripts/check-import-boundaries.mts` 目前仅限制 `server/app.ts` 与 `server/http/*` 的行数，循环依赖检查仅覆盖 `desktop/host/`，且 `server/modules/runs/mcp-tools/` 仍存在 `index.ts <-> *-tools.ts` 仅类型桶循环。

## 决策

1. **清零 `scripts/query-legacy.json`**：
   - 将 `features/agents/*` 的查询、刷新与会话开启请求迁入 `frontend/src/use-query/agents/`（`keys.ts`、`use-agents.ts`、`use-agent-mutation.ts`、`use-start-agent-session.ts`），并在 `frontend/src/use-query/extensions/use-extensions.ts` 增加 `useFetchFreshExtensions`；`features/agents/api.tsx` 退化为纯兼容重导出。
   - 清空 `scripts/query-legacy.json` 为 `{}`，使 `npm run check:query` 达到 `0 legacy files tracked for migration`。
2. **打破 `mcp-tools` 类型桶循环并扩展循环检查范围**：
   - 将 `RunMcpToolHost` 与 `ToolRegistration` 抽至无反向依赖的 `server/modules/runs/mcp-tools/types.ts`，消除 `mcp-tools/index.ts <-> {browser,builtin,extension,checked-mcp}-tools.ts` 循环。
   - 在 `scripts/check-import-boundaries.mts` 将循环检查扩展到 `desktop/host`、`shared` 与 `server/modules` 三个作用域。
3. **建立热点文件行数棘轮上限**：
   - 在 `scripts/check-import-boundaries.mts` 中配置 `FILE_LINE_LIMITS`，将已完成拆分的 13 个关键文件当前行数加上适度冗余设为硬上限（含 `server/app.ts <= 300`、`shared/types.ts <= 300`、`server/agent.ts <= 1500`、`workspace.tsx <= 960`、`conversation.tsx <= 300`、`editor.tsx <= 80` 等），防止后续迭代重新膨胀。

## 验证与回退

- **验证**：`npm run check`（验证 `Query boundaries checked; 0 legacy files tracked for migration.` 及 3 作用域无环与行数上限）、`npm run check:headers`、`npm run build`、`npm run build:desktop`；在 `tests/architecture-boundaries.test.ts` 补充 `shared` 环、`server/modules` 环和行数上限断言并运行 `npm test`。
- **回退**：若合理重构暂需上浮某个文件行数阈值，需在对应变更中显式评审并调整 `FILE_LINE_LIMITS`，不建议放开 `query-legacy.json` 或关闭循环检查。

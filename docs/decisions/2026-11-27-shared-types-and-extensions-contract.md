# C7 · 拆分 `shared/types.ts` 并统一扩展校验契约

## 问题与范围

1. `shared/types.ts`（475 行）被约 270 个文件导入，混合核心工作台类型、扩展、智能体、网关模型 Zod schema 与 `AppError`/`now`。五十余个文件只为 `AppError`/`now` 就引入整个桶与 `zod`。`types.ts` 与 `public-extensions.ts` 还互相导入。
2. 扩展校验在 `server/extensions.ts` 与 `frontend/src/features/extensions/editor.tsx` 之间漂移：名称长度与字符集（64 小写 ASCII vs 100 含 Unicode/冒号/句点）、环境变量（仅大写 vs 允许小写）、描述上限（500 vs 2000）、HTTP URL（仅本机 http vs 任意 http）；前端又用中文原文查表做诊断本地化。
3. `ExtensionEditor` 单组件 23 个 `useState`，把 Markdown 与 MCP 两套表单揉在一起；`features/extensions/{api.ts,editor.tsx,picker.tsx,skillhub-market.tsx}` 仍在 `scripts/query-legacy.json`。

不改变 HTTP 契约、SQLite 记录格式与扩展的存储形状。

## 取舍

- 拆出零依赖的 `shared/errors.ts`（`AppError`/`now`）与 `shared/agents.ts`，仅依赖 `zod` 的 `shared/models.ts`、`shared/extensions.ts`；`GithubSkillVersion` 迁入 `extensions.ts` 并由 `public-extensions.ts` 重导出，使 `shared/` 为无环图。`shared/types.ts` 保留 `export *` 兼容层，只含核心工作台类型；仅用 `AppError`/`now` 的调用方直接改到 `errors`。
- `shared/extensions.ts` 成为前后端唯一校验契约：常量、名称/环境变量/工具名正则、`mcpTransportSchema`、`extensionInputSchema`，并提供浏览器安全的 `isAbsoluteExecutablePath`、`checkMcpHttpUrl`、`validateExtensionInput`（返回结构化 `ExtensionValidationCode`）。以服务端现行规则为准（名称 `^[a-z0-9][a-z0-9_-]{0,63}$`、环境变量大写、描述 500、HTTP 仅 HTTPS 或本机 HTTP），前端表单据此收紧并给出双语提示。
- 诊断字符串在 `extensionDiagnosticMessages` 中定义一次，服务端引用；`classifyExtensionDiagnostic` 返回结构化诊断码（含参数），前端 `extensionDetail` 按码映射到 i18n，不再维护中文原文查表。
- `ExtensionEditor` 拆为 `MarkdownExtensionForm` 与 `McpExtensionForm`，`editor.tsx` 仅分派。工具绑定、MCP 测试与缓存更新、picker 目录、SkillHub 搜索迁入 `frontend/src/use-query/extensions/` 具名 hook，并从 `query-legacy.json` 清除对应四项。

## 验证与回退

新增 `tests/shared-extensions-contract.test.ts`（模块依赖、兼容导出、校验矩阵、诊断分类）并扩展前端 `extension-detail.test.ts`；再运行 `npm run check`、`check:headers`、`build`、`build:desktop`、完整 `npm test` 与隔离 Electron 烟测。无数据迁移，回退为单次 revert。已存的旧扩展记录不重新校验，仅在再次保存时按统一契约检验。

---
paths:
  - "server/**/*.ts"
  - "shared/**/*.ts"
  - "frontend/src/**/*.{ts,tsx}"
  - "tests/**/*.test.ts"
---

# API 与 TanStack Query

## 前端目录和粒度

- 每个前端使用的 API 操作，在 `frontend/src/use-query/<领域>/` 下有一个独立 `.ts` 文件。一个操作以 HTTP 方法、路由和业务语义确定，例如项目目录列表 `projects/use-project-files.ts`、项目文件内容 `projects/use-project-file.ts`、绑定项目 `projects/use-bind-project.ts`。两个页面需要同一操作时，直接复用同一个 hook。
- 读取由 `useQuery` / `useInfiniteQuery` 封装，提交、修改、删除和具有副作用的 POST 由各自的 `useMutation` 封装。服务端约定使用 POST 的只读查询也按查询语义封装。命名体现具体操作，如 `useProjectFile`、`useBindProject`。每个文件持有参数和响应类型、URL/参数编码、传输调用、查询或 mutation options 及对外 hook。需要预取、并行查询或非 React 调用时，从这个文件导出可复用的 options 或请求函数。
- 同一领域的 `keys.ts` 管理 query key。key 包含决定结果的项目、会话、实体、过滤或分页参数。查询把 TanStack 提供的 `signal` 传给请求客户端，依赖缺失用 `enabled` / `skipToken`，明确定义重试、缓存和轮询策略。列表/详情变化由对应 mutation 更新精准 key，或沿用领域的 SSE 同步规则。避免全局失效和两处维护同一个 key。
- `frontend/src/api/client.ts` 持有传输、CSRF、响应解码和统一错误。订阅在专用事件适配层持有连接与析构。浏览器下载链接、图片源和 Electron IPC 各有各自契约。

## 组件与业务 hook 的边界

- 页面或组件只调用具名领域 hook，读取数据和 pending/error 状态，绑定语义化动作，负责展示与局部交互。组件内不得 `fetch`、调用 `api()`、组装 API 路径、声明 `queryFn` / `mutationFn`，也不得以 `useEffect` 实现请求。不要用 `useApi(url, method)` 或 `useResource<T>(path)` 把接口定义重新推给组件。
- 多 API 编排、保存草稿/重试、取消、联动选择、跨会话切换等逻辑放到 `features/<领域>/hooks/use-<用例>.ts`；由用例 hook 组合上面的 API hooks。纯转换或校验写成可独立测试的函数。单个输入焦点、展开开关等简单视图状态由组件持有。
- `scripts/query-legacy.json` 已清零，不得新增豁免条目；所有前端服务端读写均通过 `use-query/<领域>/` 完成，由 `npm run check:query` 门禁强制检查。评审时给出操作文件、所有消费者和实际失效范围。

## 服务端与验证

- 路由解析并校验外部输入，领域服务核对项目/会话归属、运行模式和有效版本，执行端在副作用发生前复核授权。采用共享 schema/DTO、结构化错误、可取消的 I/O 和明确的幂等或冲突行为。
- 共享契约在 `shared/` 按业务域分文件（如 `models.ts`、`extensions.ts`、`git-multi-commit.ts`），`shared/types.ts` 仅作聚合入口；模块共享类型独立放入 `types.ts`，禁止子模块反向从同目录 `index.ts` 桶文件导入类型。`npm run check:architecture` 强制校验 `desktop/host`、`shared`、`server/modules` 无循环依赖及热点文件行数棘轮上限。
- 查询验证成功、空数据、失败与取消；mutation 验证重复点击、失败保留编辑和成功后的相关缓存。使用隔离项目覆盖跨项目拒绝、旧版本与权限撤销。凭据、文件内容和模型上下文的披露遵循 `AGENTS.md`。

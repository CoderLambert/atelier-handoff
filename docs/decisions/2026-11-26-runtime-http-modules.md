# 运行时组合入口与 HTTP 领域路由

## 问题与范围

`2218b97` 的 `server/app.ts` 有 2,646 行，同时负责运行时组装、请求检查、约 1,600 行路由、Git 提交编排、会话生命周期和消息调度。`abe5632` 新增了 Git 监听实现和前端订阅，却没有注册 `/changes`；后续提交才接通入口。这不是文件长度单独造成的，但该功能的 HTTP 入口和实现不在可一起复核的模块中。目标是让维护者由 API 路径找到适配器，由修改的业务状态找到其用例，不改变用户操作或进程划分。

## 依据与取舍

- [Node.js HTTP 官方接口](https://nodejs.org/api/http.html)的 `createServer` 请求回调不接管应用 Promise；`ServerResponse` 的 `close` 既覆盖正常结束也覆盖提前断连，`headersSent` 之后不能重发 JSON 错误。`server.close`、HTTP 连接和升级后的 WebSocket 各有各的释放路径。继续由组合入口管理关停和在途请求，HTTP 领域代码保留各自的断连语义。
- [expressjs/express 5.1.0 的 `lib/application.js`](https://cdn.jsdelivr.net/npm/express@5.1.0/lib/application.js)：`app.init` 延迟构造 router，`app.use` 注册中间件，`app.handle` 将未匹配和错误交给回调或 `finalhandler`。借鉴统一入口和有序路由，不采用它的 path matching、原型扩展、默认响应或新增运行时依赖。
- [fastify/fastify 5.6.2 `lib/plugin-override.js`](https://github.com/fastify/fastify/blob/v5.6.2/lib/plugin-override.js) 的 `override` 通过子实例封装插件的 hooks、前缀和 schema；[`lib/handle-request.js`](https://github.com/fastify/fastify/blob/v5.6.2/lib/handle-request.js) 的 `preValidationCallback`、`validationCompleted` 和 `preHandlerCallbackInner` 将校验/处理异常统一交给回复层。实际读取 npm 发行包的对应源码。借鉴明确的领域依赖，不引入可覆盖安全检查的插件作用域，也不替换既有 Zod 解析。
- 本仓终端已采用「公共校验后交给领域处理器，未知路径返回未处理」，[ORM 目录决策](2026-11-21-orm-architecture.md#目录和依赖)已约定 `server/http/<领域>/` 与 `server/modules/<领域>/`。复用这个约定和现有实现。只有存在明确的协议或路由能力缺口时才重新评估框架。

## 选择

- `server/app.ts` 是组合入口：持有一组运行时服务和关停顺序，显式注册领域路由；不接收各 API 的输入、执行会话或访问 SQL。`server/http/` 的通用层只认识请求、匹配结果和响应，统一执行原来的同源、令牌、桌面配对、错误处理及静态资源回落。路由按原优先级使用已解码片段或精确 pathname；处理器明确表示是否已消费请求，不能靠是否已写 header 判断取消或 SSE。
- `server/http/<领域>/` 解析输入、调用用例、保持原状态码与响应，并管理连接相关的取消或流。`server/modules/<领域>/` 持有用例、内部类型、调度和状态；接收业务数据及最小能力，不反向导入 HTTP 或组合入口。既有共享 DTO 继续复用，应用内部 schema 留在所属领域。复杂 Git 提交计划、会话生命周期、运行创建与消息队列不搬进另一个通用长文件。终端 WebSocket 仍由原 transport 持有。
- 运行创建和队列调度通过具名回调协作，保留事务、活动运行限制、原生 SDK 调用参数和发事件/唤醒时机。会话删除与附件上传共用同一个在途状态所有者。运行幂等回执和会话事件清理用具名仓储访问，仍在同一 SQLite 连接及既有事务上执行；只映射原表、不增加迁移。
- 将依赖方向与入口体积纳入既有 `check:architecture`，不另启检查框架。组合入口上限 300 行，HTTP 源文件上限 350 行；按职责拆分，不以压缩格式凑行数。本轮不清理无关领域的历史长文件。

## 实现定位

| 查找内容 | 文件 |
| --- | --- |
| 到底注册了哪些领域，怎么关停 | [`server/app.ts`](../../server/app.ts)，HTTP 连接由 [`server/http/server.ts`](../../server/http/server.ts) 跟踪 |
| 请求前置检查、JSON 错误与静态资源回落 | [`server/http/request-handler.ts`](../../server/http/request-handler.ts) 与同级请求、响应辅助函数 |
| Git 读写和 `/changes` | [`server/http/git/routes.ts`](../../server/http/git/routes.ts) 分发至读写适配器；[`changes.ts`](../../server/http/git/changes.ts) 持有 SSE 和监听清理；提交计划用例在 `server/modules/git/` |
| 会话归档、删除和上传互斥 | [`server/modules/sessions/lifecycle.ts`](../../server/modules/sessions/lifecycle.ts) 与 [`operations.ts`](../../server/modules/sessions/operations.ts) |
| 运行授权、接收消息与排队 | [`prepare-run-scope.ts`](../../server/modules/runs/prepare-run-scope.ts)、[`create-run.ts`](../../server/modules/runs/create-run.ts) 和 [`scheduler.ts`](../../server/modules/message-queue/scheduler.ts)，由 [`message-runtime.ts`](../../server/runtime/message-runtime.ts) 组装 |
| 新增模块反向导入或文件增长 | [`scripts/check-import-boundaries.mts`](../../scripts/check-import-boundaries.mts)，由 `npm run check:architecture` 执行 |

## 验证与回退

运行隔离的真实 HTTP/SQLite 测试，覆盖入口校验与错误、项目与会话归属、上传与删除、运行幂等、排队插入和原生 SDK 回环、Git 读写与 SSE、终端连接以及退出清理；运行 `npm run check`、`npm test`、`npm run build`。用独立数据与 profile 跑 Electron 的 Git 烟测（系统 Git、锁定 SDK、回环模型）；没有发行变更，不把开发态烟测记为实际安装件验收。实际结果登记在[阶段日志](../../openspec/roadmaps/build-atelier-desktop/task-log.md)。回退为一并撤销入口、模块和仓储绑定，不需要迁移、数据转换或重建项目。发现 HTTP 匹配、授权、事件、回执或 shutdown 顺序变化时停止切换并以原实现对照。

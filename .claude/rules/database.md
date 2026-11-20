---
paths:
  - 'server/**/*.ts'
  - 'shared/**/*.ts'
  - 'frontend/src/**/*.{ts,tsx}'
  - 'desktop/**/*.{mts,cts,ts}'
  - 'server/db/migrations/**/*'
  - 'drizzle.config.*'
  - 'scripts/**/*.mts'
  - 'tests/**/*.test.ts'
---

# SQLite 与 ORM

持久化选用 Drizzle ORM，数据库由 Node 运行时持有。驱动选择、目录树、v5 过渡方式和验收步骤见[架构决策](../../docs/decisions/2026-11-21-orm-architecture.md)。新功能从具名仓储操作开始。

## 文件的归属

| 位置 | 负责的事 |
|---|---|
| `shared/`、`server/http/` | 定义外部 DTO、运行时校验、HTTP 状态及响应。数据库行经 mapper 或显式投影转成 DTO。 |
| `server/modules/<领域>/` | 领域类型、状态机、业务错误、仓储接口及用例。用例协调授权、版本判定和事务。 |
| `server/db/schema/` | Drizzle 表、列、外键、唯一约束、索引和存储层推导类型，按领域拆文件。 |
| `server/db/repositories/`、`server/db/mappers/` | 用类型化查询实现仓储接口，校验 JSON，映射精度、空值和领域对象。 |
| `server/db/connection.ts`、`unit-of-work.ts` | 初始化和关闭唯一业务连接，提供事务绑定的仓储。 |
| `server/db/migrations/`、`maintenance/` | 不可变迁移、数据回填、备份、租约、完整性检查与修复。 |

运行时组合入口注入具体实现。HTTP、领域服务、SDK 工具、Electron、renderer 和 shared 对 ORM 客户端、列定义、驱动和 `$client` 均无直接依赖。业务层暴露 `claimNext`、`confirmDelivery` 这样的操作。仓储把授权所需的项目、会话和状态作为必需参数，避免通用 CRUD 或 `query(table, where)` 将数据库细节推回业务层。

## 编写与评审

1. 普通读写使用 Drizzle 类型化构造器、绑定值和 schema 中的列。动态排序、字段和表使用静态映射。新写的手工 SQL、`sql` 模板、`.prepare()` 或 `$client` 只能进入已记录的例外。固定的迁移 SQL 和特定 SQLite 运维语句由对应目录管理。特殊仓储查询写明 ORM 表达限制、参数化、索引与真实 SQLite 测试，在架构检查中逐处登记。
2. 业务经常过滤、排序、关联或比较的字段使用具名列和相应索引。灵活 payload 用版本化 JSON，读取时以 schema 校验。`$type<T>()` 仅提供静态类型。列表在数据库内完成过滤、投影和分页，排序含唯一平局键。列表关联数据批量读，评审时检查无界读取、N+1 和不必要的大字段加载。
3. 跨仓储原子操作由用例发起。事务回调使用传入的仓储和同一连接，保持同步且短小。领取、撤回、幂等与审批使用唯一约束、状态谓词及受影响行数。先提交业务记录与持久事件，再通知 SSE 或交给 SDK。失败时回滚，重放只限幂等操作。
4. 新迁移需同时覆盖空库和受支持旧库。在副本上检查行数、关系、旧顺序、索引与中断恢复。生产启动只执行发行包内固定且已评审的迁移。升级先做一致性备份，保留恢复路径。运行时依赖与迁移资源进入许可证和打包清单，开发工具留在构建环境。
5. 新仓储或状态转换使用临时 SQLite 验证成功、冲突、重复和回滚。只对查询热点检查 `EXPLAIN QUERY PLAN`。生产日志记录操作名、耗时和错误码，省略绑定值、消息、令牌和附件内容。

运行 `npm run check:architecture` 检查新增数据库依赖和 SQL 字面量。历史清单按路径、语句指纹及次数冻结。迁走旧语句时删减对应条目。逐项检查报告出的新增位置。`scripts/database-legacy.json` 只减不增。新增的必要特例在 `scripts/database-exceptions.json` 单独登记 `file`、`key`、`decision`、`test`，关联决策记录和真实 SQLite 用例。评审同时核对例外内容和两项依据。静态检查覆盖生产源码中的常见直接调用，脚本、迁移内容以及动态构造仍需代码评审。

# Atelier 的 ORM 与持久化边界

状态为已选型、已验证驱动组合、分批接入。适用于负责写入 `atelier.sqlite` 的 Node 运行时。开发和评审时以[数据库规则](../../.claude/rules/database.md)为准。

## 选择与依据

采用 **Drizzle ORM + SQLite**。本次核验的稳定组合是 `drizzle-orm@0.45.4` 和 `better-sqlite3@13.2.0`。首次接入时精确锁定运行时依赖。`drizzle-kit@0.31.11` 是配套开发工具候选，先验证生成的迁移和快照，再纳入 devDependencies。桌面程序只执行随包交付、经过评审的迁移。

| 候选 | 对本项目的取舍 |
|---|---|
| Drizzle 的稳定 `better-sqlite3` 适配器 | 有同步的类型化查询、条件更新、批量操作和 `immediate` 事务，可以沿用当前短事务的控制流。代价是发行包需要针对目标平台携带并测试原生驱动。 |
| Drizzle 直接接 `node:sqlite` | 官方文档已介绍这个入口，但本次核验的稳定版 0.45.4 并未导出 `drizzle-orm/node-sqlite`。未来稳定版提供该入口时，用同一套契约测试重新评估驱动。 |
| Prisma 7 的 SQLite 适配器 | 提供 schema 和生成客户端，官方 SQLite 路径也使用 `better-sqlite3`。当前项目重视同步事务、直接控制条件更新及桌面发行，Drizzle 的接入面更小。 |

已查阅稳定包的[导出清单](https://registry.npmjs.org/drizzle-orm/0.45.4)、[驱动实现](https://unpkg.com/drizzle-orm@0.45.4/better-sqlite3/driver.js)、[事务实现](https://unpkg.com/drizzle-orm@0.45.4/better-sqlite3/session.js)、[Prisma SQLite 文档](https://www.prisma.io/docs/orm/overview/databases/sqlite)和 [Node SQLite 备份 API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsource-db-path-options)。

**兼容性实测。** 2026-11-21，用 `dist/linux/atelier/resources/runtime/bin/node`（24.21.0，Linux x64）加载上述稳定版本。临时 WAL 数据库由 `node:sqlite` 创建，含 STRICT 表和索引。Drizzle 完成插入与按会话查询。第一次领取在 `immediate` 事务中抛错并回滚，重新领取影响 1 行，重复领取影响 0 行。连接打开期间用 Node 的只读连接进行在线备份，重开副本时结果一致，`quick_check` 返回 `ok`。这是驱动兼容性实验。正式验收还包括原 v5 库、安装包内的驱动加载、迁移和恢复。

### 首批接入的实现与验收

会话快照通过一个同步读仓储装配。v6 在 runs、messages、tools、permissions、artifacts、attachments 六张既有记录表上增加由 `data.sessionId` 派生的 VIRTUAL 列与索引；附件另有派生可见标志。`ALTER TABLE` 保留历史 rowid，仓储显式按 rowid 排序，与原来的 `Store.list` 顺序一致。事件按索引读取当前会话最近 500 条，返回全局 SSE 游标。快照的队列与智能体信息继续调用各自的领域服务。可见性、游标和历史顺序在真实 SQLite 上做旧版对照。

`Store` 在过渡期是数据库基础设施的兼容入口。它通过 `db/connection.ts` 取得一个 better-sqlite3 句柄，既有写事务与 Drizzle 读仓储共享该连接。v6 迁移使用版本固定的 SQL 资源。租约数据库及在线备份沿用 `node:sqlite`。实际切换前备份 v5，验证迁移及数据一致性，再用随包 Node 在隔离环境加载目标平台驱动。

## 目录和依赖

以下是接入后的目录约定。按功能迁入，有实际用途时创建文件。

```text
server/
  app.ts                            # 组合入口，创建连接、仓储和用例，注册路由
  http/sessions/                    # 请求校验、会话身份、响应 DTO 和状态码
  modules/sessions/
    session.ts                      # 领域值和状态转换规则
    session-repository.ts           # 用例需要的最小读写契约
    get-session-snapshot.ts         # 查询用例
  modules/message-queue/
    queue-entry.ts                  # 允许的队列状态转换
    queue-repository.ts             # 队列意图、领取和确认契约
    confirm-live-input.ts           # 写用例，负责业务决策与事务边界
  db/
    connection.ts                   # 唯一业务写连接，配置、装配与关闭
    unit-of-work.ts                 # 绑定同一事务的仓储集合
    schema/                         # 按会话、运行、队列等领域拆分表、索引和关系
    repositories/                   # 用 Drizzle 实现具名查询及写入
    mappers/                        # 有差异时做持久化行、JSON 和领域对象转换
    migrations/                     # 版本化 SQL、快照、回填及校验说明
    maintenance/                    # 数据库租约、在线备份、完整性检查
shared/                             # 前后端共用 DTO 和验证契约
```

HTTP 适配器把已校验的请求交给用例。用例依赖仓储接口以及需要的时钟、ID 或事务能力。Drizzle 仓储依赖 schema 和数据库会话，必要时调用 mapper。组合入口负责注入具体实现。领域规则和 IPC/HTTP DTO 可以独立测试，公共签名中只出现业务类型。简单操作可以由一个具名函数实现，按实际依赖拆分，避免每张表都搭一套空的 Service、DAO 和 Mapper。

**例子：确认实时插入。** 路由解析会话、运行和消息标识。`confirmLiveInput` 判定允许确认的运行和投递状态，再通过 `uow.write` 取得事务绑定的 `queue`、`receipts` 与 `events`。`queue.consumeSending(sessionId, runId, itemId)` 在一次带归属、状态条件的写入中返回受影响行数。影响 1 行时在同一事务记录唯一幂等回执和持久事件。影响 0 行时根据现有回执返回幂等成功或状态冲突。提交后再通知 SSE。重复确认、撤回竞争、写回执失败回滚是该用例的三个验收场景。现有行为可对照 [MessageQueue](../../server/message-queue.ts)。

## 数据和查询约定

- **schema 负责数据库约束。** 优先把身份、归属、状态、时间、顺序和幂等键建成具名列，按需要设置非空、外键、唯一、CHECK 和索引。业务生命周期决定级联策略。可变配置、冻结的 Run 输入、附件解析元数据可以保留版本化 JSON。对磁盘读出的 JSON 解析和校验后再进入领域层。
- **Repository 负责访问方式。** 以 `listBySession`、`findReceipt`、`claimNext` 表达意图。读取明确列投影，所有用户指定的排序字段走白名单。会话、项目归属约束写进同一次查询或更新。列表采用稳定顺序和唯一平局键。以消息时间线为例，可以用 `(session_id, created_at, id)` 对应游标翻页。对现有依赖 `rowid` 表示插入顺序的历史，先建立并回填稳定序号，确保相同时间戳下旧顺序可还原。
- **查询预算按真实路径确定。** 当前快照先读取全表再按 `sessionId` 过滤。首批将过滤下推 SQLite，按会话批量查询所需集合，通过查询计划确认使用既有索引。读模型明确暴露所需字段，避免逐消息查询工具和附件。对常用分页路径测试相同时间戳、跨页遗漏和重复。 [当前快照](../../server/app.ts) · [现有表及索引](../../server/store.ts)
- **Service 决定一个事务包含哪些动作。** 写事务使用同一连接和同步回调，领域操作使用注入的事务仓储。事务中只做必须原子完成的数据库操作。SDK、文件解析、网络、系统命令及 SSE 通知在事务外工作。并发领取、撤回和幂等必须依赖数据库约束或条件更新，检查影响行数。读取整份 JSON、合并再写回的路径应有事务或版本条件保护。
- **错误和观测。** Repository 将预期约束冲突转为稳定结果，Service 决定返回已接受、冲突或资源不存在，HTTP 层映射状态码。记录操作名、耗时、行数和脱敏错误码。生产默认关闭携带绑定值的 SQL 日志，保证消息正文、附件内容和凭据留在既有披露边界内。

## 原生 SQL 的使用边界

普通增删改查、分页、聚合和状态变更使用 Drizzle 的列、操作符及绑定参数。手写 SQL 只允许在三个有明确责任人的位置出现：已评审的数据库迁移、SQLite 运维适配器、经仓库决策记录论证的特殊查询。特殊查询归入对应 repository，必须注明 ORM 表达受限的具体原因、参数绑定、索引及 SQLite 回归用例。不能把 `sql.raw()`、直接暴露 `$client` 或通用 `executeSql(string)` 当作业务入口。

已有 v1–v5 语句是迁移基线。涉及该用例时逐步迁入新结构。新增业务查询从仓储接口开始；首次使用新 ORM 的功能需同时完成下述连接和发行验收。架构检查会报告新出现的 SQL 字面量及数据库依赖越界，例外按规则逐处审查。

## 实施顺序和升级条件

1. **连接和发行。** 用空库及合成 v5 数据库验证驱动、列映射、参数绑定、立即事务和备份。为 `better-sqlite3` 的 Linux x64 预构建文件、运行时依赖和许可证建立发行清单，使用随包 Node 冷启动。现有 Store 过渡为同一业务连接的兼容层，切换时由组合入口统一接管，防止事务跨越两个写连接。独立的租约数据库和只读备份连接归 maintenance。Windows/macOS 按项目的候选计划分别验证目标平台原生文件。
2. **先迁会话快照。** 从 `list().filter()` 抽出会话范围查询，验证旧库与新实现对相同输入返回相同内容和顺序。有表达式索引的旧 JSON 路径，过渡期可在迁移中声明生成列或逐表回填。每个字段指定唯一权威来源，完成切换后删除重复写入路径。
3. **再迁队列、回执和审批。** 在临时数据根验证 FIFO、优先执行、领取与撤回竞争、相同幂等键不同请求、回执确认、审批失效、重启后未知投递状态。事务内写事件，事务提交后发布通知。保留现有不重放未知副作用的语义。
4. **最后迁其余表并关闭旧入口。** 按功能迁入扩展、工具绑定、附件和设置。删除对应的旧查询及门禁基线条目。最终移除 `Store.db` 对业务模块的可见性。

**迁移发布。** v1–v5 的历史迁移冻结。统一迁移器先读取 `user_version`，拒绝未知的更新版本。空库和旧库都必须有确定性升级路径。每次仅选择一套版本账本作为权威来源，建议继续使用 `PRAGMA user_version`，将 Drizzle Kit 作为生成 SQL 和差异核对工具，应用启动执行仓库内固定的迁移。已有迁移文件发布后不可改写，CI 校验历史和迁移结果。禁止对实际工作区执行 `drizzle-kit push`。

修改表结构前按本机既有流程等待写者退出，做 WAL 一致性备份。使用副本测试旧版本升级、回填前后数量与关键关系、`foreign_key_check`、`quick_check`、中断重开与重复启动。回退时旧程序打开升级前副本，新库保留用于取回升级后的数据。性能验收记录典型会话大小、查询计划和延迟，同一工件还需通过 Linux 安装态烟测。 [迁入与备份约定](2026-11-20-desktop-data-migration.md)

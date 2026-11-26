# 工作台面板接入

本次以人工终端作为第三个内置面板，将 Browser、Git 和 Terminal 接到同一套类型化面板合同。实现基于 `main@f48da53d`，保留该版本的 Git 文件阅读/引用、原生 Bash 操作和同目录并行 Agent 会话。

## 当前范围

`frontend/src/panel-sdk.ts` 是受信、随应用编译的面板 API。它规定描述信息、作用域、实例身份、加载入口以及隐藏/展开回调。`app/panels/registry.ts` 静态登记面板，`PanelHost` 统一处理懒加载、渲染异常和重试。

这使本机或周边 Agent 可以按确定的目录和接口生成面板代码，通过类型、边界和行为检查后接入工作台。当前新增面板仍需修改注册表与工作区导航，重新构建应用；没有运行时上传 JS、外部 bundle 安装、插件市场或不受信代码沙箱。

| 层 | 职责 | 不应持有 |
| --- | --- | --- |
| `panel-sdk.ts` | 可序列化 manifest、项目/会话 target、实例和 view props | Shell、WebSocket、数据库或 Electron 对象 |
| `app/panels/registry.ts` | 静态 manifest、图标、`load()` | 加载时副作用 |
| `app/panels/use-workspace-panel.ts` | 用户操作、路由、返回位置、宽度、展开和焦点 | PTY/终端输出 |
| `app/panels/panel-host.tsx` | 懒加载及按实例隔离的渲染错误 | 业务请求、进程清理策略 |
| `features/<name>/` | 界面、业务编排、资源生命周期 | 其他 feature 的内部实现 |
| `use-query/<name>/` | 每个 HTTP 操作及其元数据缓存 | 高频字节流和原生句柄 |
| 运行时业务模块 | 授权、资源归属、执行、释放和协议校验 | React/Redux/Query 对象 |

## 新增一个面板

1. 在 `features/<name>/` 创建业务入口，以 `PanelViewProps<PanelInstance<...>>` 作为公共部分。项目工具使用 `ProjectPanelTarget`；需要会话归属的工具使用 `SessionPanelTarget`。
2. 为标题、按钮、状态及错误补齐中英文类型化词条。manifest 的 `titleKey` 必须是已有词条。
3. 在静态注册表增加 `PanelDefinition<Props>`：`apiVersion: 1`、唯一 `id`、正确 `scope`、`slot: 'right'`、宽度约束、图标和 `load()`。
4. 在工作区编排 hook 中提供命名的打开、关闭和导航动作；在工具栏或对应业务入口接入。需要可恢复路由时，同时更新路由定义和 `shared/workspace-location.ts` 的白名单。
5. 经 `PanelHost` 渲染并传入 ID 化 target。异步操作必须校验点击时捕获的目标，过期完成不能切换新会话的面板或焦点。
6. 有后端资源时，先定义共享 schema、明确能力查询与资源唯一所有者，再实现 API。增加覆盖实际副作用和关键失败路径的测试；在真实 Electron 窗口验收布局、键盘和原生 Browser 遮挡。

Git 和 Browser 保留各自的适配器 props。Git 的 busy/关闭保护按实例生效；Browser 隐藏仍通过现有原生视图通路处理。公共 Host 不推断某个面板的业务资源是否应该销毁。

### Agent 接入任务模板

为 Agent 提供下面这些输入，通常比只要求“添加一个侧栏”更容易得到可检查的结果：

```text
面板 ID / 标题词条：
作用域：project 或 session
用户入口与返回位置：
允许的业务操作：
资源所有者：
隐藏、切会话、重连、显式关闭、应用退出时的行为：
后端能力及所需授权：
错误与重试语义：
可修改目录和禁止跨越的依赖：
实际验收步骤：
```

后续要支持 Agent 生成并即时安装外部插件，需要另行建立安装包 schema、版本兼容、宿主能力授权、隔离执行、升级回退和禁用机制。当前合同可以作为 UI 接入层复用；不能将静态 `load()` 当作外部代码的安全边界。

## Terminal 参考实现

### 用户行为

在已配对的 Linux x64 桌面会话点击“终端”。首次显式打开且该会话没有终端时创建一个 shell；也可通过面板的“新建终端”增加实例。初始目录由服务端解析为会话绑定目录，包含独立开发工作树。

关闭面板只是隐藏。切换面板或会话后，当前应用中的 shell 和终端解析器保留；重新打开继续显示同一资源。关闭一个终端会结束对应 shell；自然退出保留屏幕和退出码，仍计入保留实例数，关闭后释放该名额。

页面刷新或连接中断可以恢复到同一 sidecar 中的现有终端。恢复使用服务端屏幕快照，不重放未确认输入。应用退出会关闭终端；重开应用后不会复活上一运行时的 shell。普通浏览器、Windows/macOS 候选或关闭本机执行的桌面显示不可用原因。

### 分层与接口

| 入口 | 行为 |
| --- | --- |
| `GET /api/terminals/capabilities` | 返回 runtime ID、支持状态、shell 名称和限制 |
| `GET /api/sessions/:sessionId/terminals` | 当前运行时的会话终端元数据 |
| `POST /api/sessions/:sessionId/terminals` | 按客户端生成的 terminal ID 幂等预留；不接受 command/cwd/env |
| `POST /api/sessions/:sessionId/terminals/:terminalId/attach-ticket` | 使用当前 Origin 签发短效、单次连接票据 |
| `DELETE /api/sessions/:sessionId/terminals/:terminalId` | 结束终端；清理未完成时保留占用并允许重试 |
| `/api/terminals/stream` | 认证升级后的输入、输出、尺寸、ACK 与屏幕恢复 |

HTTP 继承现有配对、Host/Origin 和 CSRF 校验。WebSocket 使用固定子协议与单次票据；票据不放在 URL。连接只能接管已存在且归属于当前会话的终端。所有数据形状由 `shared/terminal.ts` 的严格 schema 定义。

每个点击动作冻结 runtime/session/workspace/terminal 身份。服务端先同步登记预留，再准备工作目录和原生依赖；收到首个有效 `ready` 才启动 PTY。创建重试使用同一 ID，关闭保留 tombstone，过期 runtime 请求失败，避免网络重试产生重复进程。

`TerminalManager` 是 PTY 的唯一所有者，`TerminalScreen` 串行解析输出与尺寸变更。浏览器中的 `TerminalClientSession` 持有 xterm、DOM 和 WebSocket，视口组件仅获取挂载租约。隐藏视口不会销毁解析器，也不会因为关闭键盘输入而同时禁止终端设备应答。

恢复先发送屏幕快照，客户端完成解析后发送 `ready`。output、resized、state 共享递增序列；客户端处理完成后 ACK。输入使用独立序列，只发送一次。输出、未确认窗口、快照、输入和保留终端均有限额；慢连接断开后可以重新恢复屏幕。

每个 sidecar 最多保留 8 个终端，每会话最多 4 个。默认等待首次连接 30 秒，快照就绪最多 10 秒。显式关闭先 SIGHUP，2 秒后 TERM，3 秒后 KILL，总观察窗口 6 秒；只有实际退出并排空已接收输出才释放目录保留。清理失败显示状态并保留归属，稍后可重试或由迟到的退出事件完成收敛。

### 与现有行为的关系

人工终端直接使用登录用户的本机权限，独立于 Agent 的原生 Bash/审批/运行并发。它不占 Agent 执行槽，不经模型生成命令，也不向聊天事件流或 SQLite 写入终端字节。

工作树增加独立的终端保留，仅阻止目录回收和相关会话归档/删除。Git 浏览、暂存、提交，以及已有 Agent 的同目录并行语义继续使用原有通路。关闭终端后可正常归档或删除会话。

## 验收与发布

运行常规 `npm run check`、`npm test`、`npm run build`、`npm run build:desktop`。Linux 显示环境可额外执行：

```sh
node node_modules/electron/install.js
xvfb-run -a node --import tsx scripts/smoke-terminal.mts
```

开发态烟测使用隔离数据根、项目、Electron profile 和本地目录接口，不调用模型。它检查实际 TTY、输入、尺寸、隐藏/恢复、Ctrl-C、大量输出、刷新保留 shell、显式关闭、自然退出，以及应用退出后的所属进程身份。结果与截图默认写入 `.local/terminal-workbench/electron/`。系统中文输入法和交互式全屏程序仍应在真实桌面单独核对。

Linux packager 对目标 PTY 二进制的 ELF 架构、唯一性和 hash 做检查，并使用随包 Node 从 staged runtime 执行真实探针。安装态 p1 复用终端 UI 场景；仅允许已观察到且 PID/startTicks/executable 均匹配的所属 shell 作为系统二进制例外。Windows/macOS 候选排除完整 node-pty 运行时并明确标记能力不可用。

开发态探针、实际 Electron 和实际安装件是不同证据。缺少显示环境、固定 Node 或系统打包工具时，需记录阻塞，不能以类型检查或依赖子集探针代替发行验收。当前实现的选择与回退见 [技术决策](decisions/2026-11-26-terminal-workbench.md)，适配清单见 [实施方案](superpowers/plans/2026-11-26-terminal-workbench.md)。

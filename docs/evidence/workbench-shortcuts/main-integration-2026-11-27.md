# 快捷操作合入最新 main 验收

日期：2026-11-27（Asia/Shanghai）。合并目标为 `main@7d4047409ffdb62ae142d44bf2fae3c0b9e9eca3`，来源为 `feat/compact-workbench-layout@7e7467ba94adc9ea71f58f1c42fd2687e730ba72`，共同基线为 `909d3b8`。

## 合并处理

- 保留 main 的全部 8 个后续提交，包括 HTTP 领域拆分、Git 实时同步、子代理与长任务处理、输入性能和滚动条、精确 Git 合并引用。
- `server/app.ts` 保留主干组合入口，仅注入快捷偏好仓储。GET/PATCH `/api/settings/shortcuts` 移至 `server/http/settings/shortcuts.ts`，设置分发器仍经过统一同源、CSRF 和桌面配对检查。组合入口保持 300 行。
- `SessionChat` / `Chat` 合并焦点请求及回执，保留主干的窄订阅、稳定回调、按需 `getDraft` 和 `Conversation memo`。没有改写 Composer、Conversation、SDK 调度及 Git 实时同步实现。
- 两侧阶段日志均保留。独立源码审查未发现 Critical / Important 问题；文件说明按本次实际适配的 7 份源码哈希进行一批只读复核。

## 本轮通过的验证

| 验证 | 结果与范围 |
| --- | --- |
| 核心、HTTP、SQLite、会话切换 | 10/10；新增路由回归先确认主干组合入口下接口返回 404，再验证完整请求保护、精确路径与方法、无效配置不写入、重启恢复。 |
| 原生 Electron 桥接 | 2/2；实际 main/preload、可信注册、原生网页按键及焦点归属。 |
| Electron 快捷模块 | 7/7；模态、录制、保存失败、过期命令、输入法事件、重复键及焦点。 |
| 原有消息与输入性能测试 | 5/5；保留原测试的全部断言，覆盖 60 条历史下连续输入不重渲染历史、输入框原生自动高度、草稿和后续回复更新。 |
| 实际工作台交互 | 11 场景，0 页面错误、0 模型请求；见[交互结果](main-integration-results.json)。 |
| 数据迁移独立复跑 | 74/74；不使用 `--test-force-exit`，无取消。 |
| 静态检查 | 架构、Query、i18n、UI 自测与检查、四组 TypeScript 检查通过。 |
| 构建 | renderer 和 Electron main/preload 构建通过。 |

工作台场景包括左右栏、Git 文本保留、终端恢复后 ID 不变、浏览器显示与恢复、连续键入后切换会话的两份草稿保留、全窗口 Git 下切换会话、输入聚焦、IME Escape、窄窗口及快捷键保存后重载。新增验证：Git 隐藏期间发生的修改在恢复后刷新，恢复后再次写文件仍能实时更新差异。

## 全量检查的实际限制

没有将本轮结果记为全量测试全绿：

- `npm run check` 在 Markdown 预构建的 tsx CLI Unix socket 阶段遇到 `EPERM`。相同 CSS 类型生成和检查脚本改由 `node --import tsx` 运行，全部通过；未修改生产保护或检查规则。
- `npm test` 在 180 秒边界超时。随后使用有界的 `--test-force-exit --test-concurrency=4` 完整诊断：742 项，719 通过、1 失败、2 取消、20 跳过。唯一失败是既有 detached shell / grandchild 回收用例；此前在未修改的 `909d3b8` 基线已复现，本轮确认其源码与测试在 `909d3b8`、最新 main 和合并候选之间均没有改动。两个取消均来自迁移用例的未完成 Promise，去掉强制退出参数独立复跑 74 项全部通过。
- 前端完整诊断为 147 项，131 通过、15 失败、1 跳过；逐项核对 15 个失败均为 `/usr/lib/chromium/chromium` 缺失。没有改成跳过以隐藏失败。
- 对本次必须保留的 `message-actions.test.ts`，使用仅位于 `.local/shortcuts-main-integration/` 的启动器适配：将该文件的 Playwright Chromium 启动替换为项目锁定的真实 Electron，测试源码和断言保持不变，5 项通过。这不能替代其余 14 项独立 Chromium 场景。
- 完整工作台使用已提交的隔离测试宿主，实际 RuntimeSupervisor、HTTP、SQLite、Git、PTY 和浏览器控制器照常运行；因容器 Unix socket 限制，未验收生产单实例锁、物理键盘、真实 IME 候选窗口或安装件。没有切换用户日用桌面实例。

## 复跑入口

```sh
node --import tsx --test tests/shortcuts.test.ts tests/runtime-http.test.ts tests/session-switcher.test.ts
ATELIER_TEST_DESKTOP_SHORTCUTS=1 node --import tsx --test tests/desktop-shortcuts.test.ts
ATELIER_TEST_DESKTOP_SHORTCUTS=1 TSX_TSCONFIG_PATH=frontend/tsconfig.json \
  node --import tsx --test frontend/src/features/shortcuts/shortcut-host.test.ts frontend/src/features/shortcuts/shortcut-interaction.test.ts
TSX_TSCONFIG_PATH=frontend/tsconfig.json \
  node --import tsx --test frontend/src/features/chat/message-actions.test.ts
ATELIER_SHORTCUT_FIXTURE=1 node --import tsx scripts/smoke-shortcuts.mts
node --import tsx --test tests/data-migration.test.ts
```

消息测试标准入口需要可用 Chromium；本环境适配命令另外增加 `--import ./.local/shortcuts-main-integration/electron-fixture-loader.mts`。原始日志、启动适配器、截图和文件哈希位于 `.local/shortcuts-main-integration/`。本轮复用现有依赖，仅补齐 main 已锁定的 chokidar 4.0.3 / readdirp 4.1.2，并逐个验证 tarball 与 lockfile 的 SHA-512 完全一致。

## 开发过程 review

先核对真实提交关系和主干差异，再让 HTTP 与输入适配按文件所有权并行；独立审查聚焦被自动合并覆盖的风险。保留主干测试断言，并通过实际目标 Electron 引擎弥补关键浏览器场景的环境缺口。全量测试首轮已设有界超时，诊断只对迁移取消做独立复跑，没有扩展修改无关进程清理或浏览器安装逻辑。

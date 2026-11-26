# 工作台快捷操作验收

日期：2026-11-26，Asia/Shanghai。功能分支：`feat/workbench-shortcuts`；基线：`main@909d3b87b0c23bc2ec025341b280ce47e28ca554`。

## 功能范围

现有布局上新增可配置快捷入口：左右栏显隐、会话搜索及相邻切换、Git/终端/浏览器面板访问、会话输入聚焦。共享配置/精确匹配器、React 命令宿主、工作台适配、SQLite 偏好和受信 Electron 桥接分别持有职责；没有新增快捷键依赖。

## 通过的验证

| 验证 | 结果与证据范围 |
| --- | --- |
| 共享配置、SQLite/HTTP 与会话模型 | 7 项通过，覆盖修饰键、输入法、默认继承、禁用、保留/重复组合、真实设置重启恢复和损坏回退、最近更新排序及归档/创建中的会话过滤。 |
| 原生桌面桥接 | 2 项通过；实际 Electron 45.4.1、WebContentsView、preload 与 controller，核对可信主 frame/origin、原生网页无桥接、当前 revision、焦点交还、键盘透传、持按抑制、重载清注册、原网页复用和 Agent CDP 输入。 |
| 快捷模块 renderer | 7 项通过；真实 Electron renderer，配置 HTTP 与 native 回调为受控替身。覆盖默认入口、方向/字母导航、IME、持按、模态暂停、禁用、设置冲突、保存失败保留与重试、中英文、过期 revision。 |
| 真实工作台完整交互 | 10 个场景通过；实际 client 构建、RuntimeSupervisor、配对 HTTP/WS、Git、PTY 与浏览器。0 个页面异常、0 次模型请求。 |
| 静态与构建 | 架构、Query、i18n、UI 语义及自检；root/frontend/desktop/tools 四组 TypeScript；前端和桌面构建。43 份变更源码的文件说明集中核对。 |

完整工作台场景：

1. 从输入框打开快捷导航，收起与恢复左栏。
2. 右栏隐藏后恢复 Git 未提交的文本。
3. xterm 中快捷键可用；终端隐藏恢复及再次打开保持同一个终端 ID。
4. 浏览器面板打开、隐藏、恢复。
5. 从交付物页面返回会话并聚焦输入，草稿保留。
6. 会话选择器按项目搜索、键盘选中和 J/K 切换，两个会话的草稿分别保留。
7. 合成 IME Escape 不关闭选择器；结束组合输入后 Escape 正常取消并归还输入焦点。
8. 全窗口 Git 下切换会话，新会话可见且中心不再 inert。
9. 720px 窗口打开导航抽屉、从浏览器返回输入框。
10. 录制并保存单个直接快捷键，重载后仍生效。

## 复跑

```bash
node --import tsx --test tests/shortcuts.test.ts tests/session-switcher.test.ts

ATELIER_TEST_DESKTOP_SHORTCUTS=1 node --import tsx --test tests/desktop-shortcuts.test.ts

ATELIER_TEST_DESKTOP_SHORTCUTS=1 TSX_TSCONFIG_PATH=frontend/tsconfig.json \
  node --import tsx --test frontend/src/features/shortcuts/shortcut-host.test.ts \
  frontend/src/features/shortcuts/shortcut-interaction.test.ts

# 已完成前端与桌面构建的开发环境：默认验证实际启动器。
node --import tsx scripts/smoke-shortcuts.mts

# 本次受限环境的隔离测试组合入口；生产启动器和权限保持原样。
ATELIER_SHORTCUT_FIXTURE=1 node --import tsx scripts/smoke-shortcuts.mts
```

完整交互脚本在临时目录创建自己的 Git 项目、数据库和 Chromium profile，完成后关闭其运行时。测试组合入口位于 `tests/fixtures/workbench-shortcuts-app.ts`，不属于生产宿主依赖；不更改生产单实例保护或配对/CSRF。结果 JSON 和截图默认写入 `.local/workbench-shortcuts/`。

## 全量门禁与环境限制

- 已尝试 `npm run check`：预构建中的 tsx CLI 监听 Unix socket 时返回 `EPERM`。使用 `node --import tsx` 执行同一组架构、Query、i18n 和 UI 检查，并执行同一组 TypeScript 命令，均通过。markdown 的 Vite/tsc 构建已执行，其 CSS 类型生成脚本改用相同 Node loader 完成。前端预览资源准备后，使用 `npm --ignore-scripts run build`；桌面构建使用 `node --import tsx scripts/build-desktop.mts`。没有改写项目命令。
- 已尝试 `npm test`：既有进程生命周期用例失败后留下句柄，常规运行未退出。诊断运行增加 Node 的 `--test-force-exit`，未跳过断言：运行时 730 项，706 通过、2 失败、2 取消、20 跳过。失败包括 Codex 目录恢复的短超时和 detached shell 回收；两个取消项属于迁移子测试。
- 随后独立重跑 `tests/codex-model-catalog.test.ts` 与 `tests/data-migration.test.ts`，83 项全部通过。detached shell 回收用例在全新的基线 `909d3b8` 检出中也失败（该文件 10 通过、1 失败），没有为本功能修改进程回收逻辑。
- 前端全量诊断运行 147 项：131 通过、15 失败、1 跳过。15 项既有浏览器用例均因 `/usr/bin/chromium` 所指向的 `/usr/lib/chromium/chromium` 缺失而无法启动。本功能的 renderer 与完整交互使用已有真实 Electron 二进制独立验证，未把它们表述为全量 Chromium 回归通过。
- 生产桌面启动器的 `requestSingleInstanceLock` 同样因当前环境的 Unix socket 限制无法启动；实际界面与运行时通过隔离测试组合入口验收。未验证安装包、实体键盘、系统热键自定义、浏览器扩展占用、Wayland 合成器及真实 IME 候选窗口。输入法测试使用真实 Electron 内的合成事件。

## 独立审查与修正

独立审查没有留下 Critical / Important 问题。修正了全窗口 Git 遮挡切换后的会话、选择器取消后焦点丢失、持按 Enter/Escape 泄漏，以及 Radix capture 阶段的 IME Escape 误关闭。最后一项通过临时内存构建红绿对照：移除防护时浮层 1→0，当前源码维持 1→1 且默认关闭被阻止。普通 Escape 的行为另有完整交互断言。

文件说明按单批 43 份源码哈希审阅，集中补充 9 个必要头说明，并核对本轮新写时间的时区。测试组合入口随后归入测试目录，生产架构检查保持不变。

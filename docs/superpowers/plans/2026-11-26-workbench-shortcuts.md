# 工作台快捷操作实现计划

> 执行方式：当前会话内按文件所有权并行实现独立模块，由主会话集成、评审、验证并统一管理 Git。

**目标：** 基于最新 main 增加可配置快捷入口，覆盖左右栏、会话、功能面板和输入框，不修改基础布局。

**规范：** [技术决策与交互边界](../../decisions/2026-11-26-workbench-shortcuts.md)。React/Radix 负责交互，shared 负责纯配置匹配，现有工作台负责业务，Electron 只转发受信命令。

## 任务与文件边界

1. **配置与持久化**：`shared/shortcuts.ts`、仓储、设置 API、Query hooks；先建立默认/覆盖/冲突与真实 HTTP/SQLite 失败用例，再完成实现。
2. **通用快捷模块**：`features/shortcuts`、独立 i18n namespace；精确捕获、命令可用性、浮层、设置录制/保存、native revision 同步，验证 IME/重复键/模态暂停。
3. **桌面桥接**：`shared/desktop-shortcuts.ts`、preload/main/browser controller；只认可可信 frame 和当前命令注册，保持 Agent 输入与人工控制边界，真实 Electron 探针验证。
4. **工作台适配**：在原 owner 接入左右栏、会话切换和面板幂等打开；会话焦点请求绑定实际 composer 生命周期；新增设置路由和分类。业务不导入匹配器实现。
5. **集成与验证**：检查保持面板状态、窄窗口、草稿、加载/失败/归档、终端与原生网页焦点；运行 check/test/build/desktop gates。独立评审发现的实际问题修正后复验。
6. **交付**：统一维护变更文件头，记录 task-log、证据与简短开发复盘；提交和推送 `feat/workbench-shortcuts`，不合入 main。

## 公共契约

`ShortcutPreferences={version:1,enabled,bindings,navigation}`；bindings 中省略继承、null 禁用。绑定 `{code,modifiers}`，支持 Mod/Control/Meta/Alt/Shift；命令采用稳定字符串 ID。`ShortcutHost` 接收 `{id,label,description?,icon?,available,run}` 数组，自带导航命令。设置使用同一 schema 和已保存 Query 缓存。native `update({revision,bindings})` 与 `onCommand({revision,commandId})` 不携带业务参数或脚本。

## 验证日志

- 基线 `npm run check` 已尝试：markdown 的 tsx CLI 创建 `/tmp/tsx-1000/101.pipe` 被环境拒绝（EPERM）。后续使用等价 `node --import tsx` 启动脚本或独立 TMPDIR 继续验证，保留原始结果。
- 实现、独立审查与验收完成。完整工作台交互 10 场景通过；命令结果、环境限制和全量失败的基线复现见[验收记录](../../evidence/workbench-shortcuts/verification.md)。用户明确授权后，已上传为 `7e7467b`，并快进合入 `feat/compact-workbench-layout`。用户随后要求合入最新 main，按[后续合并计划](2026-11-27-merge-shortcuts-main.md)保留新主干的 HTTP 拆分与输入性能优化。

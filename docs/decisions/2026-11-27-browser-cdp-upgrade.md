# 内置浏览器 CDP 封装升级（Phase 1 + Phase 2）

## 问题与范围

当前 `desktop/browser/cdp-driver.mts` 与 `desktop/browser/controller.mts` 仅提供最小可用的 5 个工具（`browser_navigate`、`browser_snapshot`、`browser_take_screenshot`、`browser_click`、`browser_type`），在真实网页自动化场景中存在以下明确短板：

1. **无障碍树快照信息丢失**：`Accessibility.getFullAXTree` 被拍平并按角色重排后截断 200 条，丢失父子层级上下文，且过滤掉了 `value`/`checked`/`selected`/`expanded`/`disabled`/`focused`/`placeholder`/`level` 等状态属性，并漏判 `combobox`/`spinbutton`/`radio`/`switch`/`tab`/`menuitem`/`option` 等常见控件。
2. **输入与点击准确度不足**：
   - `executeCdpClick` 仅用 `DOM.getBoxModel` 中心点、不派发 `mouseMoved`、在页面缩放（zoom ≠ 1）下 `before-mouse-event` 的 `< 1px` 校验可能静默误拦截；
   - `executeCdpType` 硬编码 `Ctrl+A`（macOS 下不生效），且 `text === ''` 时 `Input.insertText` 无法清空已选中文本。
3. **多步操作效率低**：每次 click/type 后强制 `tab.refs.clear()`，连续填表每一步都被迫重新拉取全量 AXTree。
4. **弹窗阻塞与新窗口丢弃**：未监听 `Page.javascriptDialogOpening`，网页弹出 `alert`/`confirm`/`prompt` 会挂起 CDP 命令直到 30 秒超时触发替身标签；Agent 模式下 `setWindowOpenHandler` 直接拒绝所有 `target="_blank"` 链接。
5. **高频交互缺口**：缺少滚动（`browser_scroll`）、按键（`browser_press_key`）、悬停（`browser_hover`）、原生下拉选择（`browser_select_option`）、等待（`browser_wait_for`）、历史导航（`browser_navigate_history`）、JS 弹窗决策（`browser_handle_dialog`），以及 `fullPage` 截图支持。

## 查阅来源

- [Chrome DevTools Protocol — Accessibility Domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)（`Accessibility.getFullAXTree` 的 `nodeId`/`childIds`/`properties`/`value` 结构）
- [Chrome DevTools Protocol — DOM / Input / Page Domains](https://chromedevtools.github.io/devtools-protocol/tot/Page/)（`DOM.getContentQuads`、`Input.dispatchMouseEvent` `mouseMoved`/`mouseWheel`、`Page.captureScreenshot`、`Page.javascriptDialogOpening` / `Page.handleJavaScriptDialog`）
- [Electron Debugger API](https://www.electronjs.org/docs/latest/api/debugger)（`debugger.on('message', ...)` 接收 CDP 事件、`sendCommand`）
- `microsoft/playwright`（Aria Snapshot 紧凑树形格式与噪声容器剪枝思路、DOM quad 中心点点击）
- `ChromeDevTools/chrome-devtools-mcp`（挂起 JS 弹窗转交 Agent 通过 `handle_dialog` 主动决策的模式，避免静默自动取消）

## 候选对比与取舍

1. **快照输出格式**：
   - 保留平铺 JSON：无法表达表格/列表/表单分组上下文，token 冗余高。
   - **选用紧凑缩进树形文本（`cdp-snapshot.mts`）**：按 `nodeId`/`childIds` 重建树，剪枝无语义 `generic`/`none`/`InlineTextBox` 容器，输出 `role "name" [ref=rN-M] [value=...] [checked] [disabled]`，兼顾可读性、上下文完整度与低 token 消耗。
2. **JS 原生弹窗处理**：
   - 自动默认取消：违背 Agent 自主决策，遇到需要确认的业务弹窗（如“确认提交”）无法推进任务。
   - **选用非阻塞挂起 + `browser_handle_dialog`**：监听 `Page.javascriptDialogOpening`，立刻解除触发该弹窗的 `click`/`type`/`navigate` 的等待并将弹窗类型、文案与默认输入返回给 Agent；Agent 根据任务语义调用 `browser_handle_dialog` 决定 `accept` / `promptText`。若挂起期间 Agent 误调其他页面工具，直接返回弹窗提示避免 30s 死锁。
3. **只读与审批分层**：
   - 只读免审批（`readOnly: true`，取消即刻撤退）：`browser_snapshot`、`browser_take_screenshot`、`browser_scroll`、`browser_hover`、`browser_wait_for`。
   - 导航（同 `browser_navigate`，受 `allowedOrigins` 约束）：`browser_navigate`、`browser_navigate_history`。
   - 受控修改（`run.mode === 'edit'` 且走审批流）：`browser_click`、`browser_type`、`browser_press_key`、`browser_select_option`、`browser_handle_dialog`。
4. **同文档 `ref` 生命周期**：
   - 取消每次 click/type 后强制清空 `tab.refs`，仅在 `did-start-navigation`、页面崩溃、人工交还、下一次 `browser_snapshot` 时清空；节点实际失效时捕获 CDP `Could not find node` 错误提示重新快照。
5. **模块边界**：
   - `desktop/browser/controller.mts` 保持在 `scripts/check-import-boundaries.mts` 的 700 行上限以内；新增 `desktop/browser/cdp-snapshot.mts`、`desktop/browser/cdp-keys.mts` 与 `desktop/browser/tool-executor.mts`，其余底层 CDP 动作集中在 `desktop/browser/cdp-driver.mts`。
6. **对标成熟方案补充的 4 项强化（2026-11-28 追加）**：
   - **重型站点导航等待策略**：`browser_navigate` 支持 `waitUntil?: 'domcontentloaded' | 'load'`（默认 `'domcontentloaded'`），在 `dom-ready` 后等待 400ms 稳态即返回，避免被广告、统计埋点与慢资源拖死 60 秒超时；空白标签首次导航不预先调用 `Page.enable`，避免未创建渲染进程时挂起。
   - **视口滚动感知与 `includeSnapshot`**：快照头部附加 `viewport: WxH scroll: Y/TotalH`；导航与交互工具支持可选 `includeSnapshot: true`，一次调用直接带回最新无障碍树，减少 LLM 往返。
   - **居中滚动与防遮挡检测**：点击/悬停前优先 `scrollIntoView({ block: 'center', inline: 'center' })` 避开 sticky 顶栏，并通过 `elementFromPoint` 校验目标是否被弹窗/遮罩遮挡，被遮挡时直接返回明确提示。
   - **批量填表 (`browser_fill_form`)**：支持单次审批批量填写多组输入框与原生 `<select>` 字段。

## 验证与回退条件

- **验证**：
  - 单元测试覆盖树形快照裁剪与状态属性、跨平台键码、`getContentQuads` 优先/回退、`mouseMoved` 顺序、zoom 坐标容差、同页 `ref` 复用与失效、JS 弹窗非阻塞回报与 `browser_handle_dialog` 决策、所有新工具的 schema 与审批边界。
  - 更新 `scripts/p1-smoke/contracts.mts`、`scripts/p1-smoke/fixtures.mts`、`tests/fixtures/desktop-shortcuts-app.ts` 以适配树形快照格式。
  - 全仓运行 `npm run check`、`npm test`、`npm run build`。
- **回退**：
  - `desktopBrowserProtocolVersion` 保持向后兼容扩展（新增工具名与可选字段）；若某项新工具出现兼容异常，可在 `server/modules/runs/mcp-tools/browser-tools.ts` 单独下线注册而不影响原有 5 个核心工具与现有数据格式。

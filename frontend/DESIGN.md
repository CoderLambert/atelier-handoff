# Atelier 前端统一设计规范

Atelier 工作区面向在同一窗口内管理项目、推进对话、核对执行结果、操作 Git/终端与配置自动化任务的桌面用户。默认面向中、大尺寸桌面（`1280×800`、`1440×900`、`1920×1080`），窄窗口通过抽屉与单栏访问同一能力。

本规范是前端视觉与组件设计的**唯一事实源**，由 `scripts/check-ui.mts` 提供静态门禁防回退。

---

## 一、设计令牌单轨制（Tokens）

主题色板与基础刻度统一定义在 `frontend/src/styles.css`（支持 Obsidian Studio、Atelier Classic、Warm Parchment、Nordic Frost、Rosé Pine Dawn、Midnight Slate 六套主题），通过 `@theme inline` 暴露为 Tailwind 语义类。

### 1. 表面与色彩角色（禁止新增旧别名）

- 业务样式仅允许使用 `--ui-*` 变量或对应的语义类（`bg-card`、`text-muted-foreground`、`border-border` 等），**停止新增** `--fg`、`--muted`、`--surface`、`--accent`、`--border-soft` 等旧别名。
- 业务样式表与 TSX 中**禁止硬编码色值**（`#hex`、`rgb()`、`hsl()`、`bg-slate-*` 等），统一由 `check:ui` 的 `color` 规则拦截。
- 页面严格遵守三层表面层级：
  1. **导航轨表面**：`--ui-sidebar`（左侧栏、辅助轨）
  2. **画布底表面**：`--ui-background`（主内容底面）
  3. **内容与浮层表面**：`--ui-card` / `--ui-popover`（表单容器、卡片、弹窗、下拉菜单）
- 状态语义色（`info`、`success`、`warning`、`destructive`）均配有 `*-soft` 浅底与 `*-border` 描边，文字对比度满足 WCAG AA（≥ 4.5:1），且必须同时提供文字或图标。

### 2. 字号与排版阶梯（锁定 6 档）

使用系统本机中英文无衬线字体（`--font-body` / `--font-display`）与等宽字体（`--font-mono`）。业务样式仅允许使用以下 6 档字号变量，**禁止裸写 `10.5px`、`11.5px`、`12.5px` 等零散像素字号**：

| 变量 | 尺寸 | 适用场景 |
| --- | --- | --- |
| `--text-xs` | `12px` (`0.75rem`) | 元信息、时间戳、副标题、辅助说明、表头 |
| `--text-sm` | `13px` (`0.8125rem`) | 密集列表项、侧边栏会话、菜单项、标签页 |
| `--text-ui` | `14px` (`0.875rem`) | 常规按钮、输入框、下拉选择器、表单值 |
| `--text-base` | `15px` (`0.9375rem`) | 会话正文、文档预览、说明段落 |
| `--text-xl` | `20px` (`1.25rem`) | 区块标题、弹窗主标题 |
| `--text-2xl` | `24px` (`1.5rem`) | 全页管理视图主标题 |

### 3. 控件高度、间距与圆角

- **控件高度（4 档）**：`--ui-size-xs`（28px）、`--ui-size-sm`（32px）、`--ui-size-md`（36px，默认）、`--ui-size-lg`（40px）。同一行内的 `Input`、`Select`、`Button` 必须保持同档高度。
- **间距栅格（4px 基准）**：控件内部 `4 / 8 / 12px`，表单字段间距 `16px`，区块分组间距 `24px`，管理页主容器内边距 `28px 32px`。
- **圆角（4 档）**：`--radius-sm`（6px，小标签与列表项）、`--radius-md`（8px，输入框与按钮）、`--radius-lg`（12px，卡片、弹窗与浮层）、`--radius-pill`（9999px，徽标与滚动条滑块）。
- **阴影（2 档）**：轻量边界使用 `1px solid var(--ui-border)` 与 `--ui-shadow`，所有浮层（Dialog / Popover / DropdownMenu / Select）统一使用 `--ui-shadow-overlay`。

### 4. 焦点态与选中态分层规范

- **表单输入与按钮**：聚焦时采用柔和焦点环（`border-ring` + `ring-[3px] ring-ring/20` 或 `ring-ring/25`），普通元素键盘 `:focus-visible` 由 `styles.css` 全局规则提供轻柔细焦环（`1.5px solid var(--ui-focus-outline)`）。
- **菜单项、下拉选项与列表行**：**严禁画 `2px solid` 实线外框**；悬停/高亮使用 `bg-accent`，当前选中项使用 `bg-selected` 配合主色勾选图标或左侧指示条。
- **门禁约束**：业务 CSS 中**禁止手写 `outline: 2px solid`**（由 `check:ui` 的 `focus-outline` 规则强制拦截）。

### 5. 全局滚动条规范

- 滚动条样式仅在 `frontend/src/styles.css` 单点定义（`8px` 细轨、透明轨道、圆角悬浮滑块），业务 CSS 中禁止编写 `::-webkit-scrollbar*`、`scrollbar-color` 或非 `none` 的 `scrollbar-width`（由 `check:ui` 的 `scrollbar` 规则强制拦截）。

---

## 二、页面骨架与容器宽度

| 页面类型 | 典型页面 | 容器最大宽度 | 骨架规范 |
| --- | --- | --- | --- |
| **阅读流视图** | 主会话对话流 | `80ch`（居中） | 正文限宽，代码块与表格在容器内横向滚动 |
| **管理配置页** | 自动化任务、扩展、智能体、设置、运行记录 | `1160px`（居中） | 统一使用 `PageHeader` + 统一 `Tabs` + `Field` 表单 + `EmptyState` |
| **全宽工作台** | Git Workbench、内置浏览器、终端 | `100%` | 顶部工具条固定高度，右侧分栏统一头部与边框分隔 |

---

## 三、共享 UI 原语体系（`frontend/src/components/ui/`）

业务模块（`features/`、`app/`）负责布局与业务状态，**不重复实现基础控件外观**：

- **已有基础原语**：`Button`、`Badge`、`Input`、`Textarea`、`Select`、`Switch`、`Dialog`、`Popover`、`DropdownMenu`。
- **骨架与表单组合原语**：
  - `Tabs` / `TabsList` / `TabsTrigger` / `TabsContent`：提供 `underline`（页内主切换）与 `pill`（紧凑分段切换）两种变体，内置键盘左右/Home/End 导航。
  - `Field` / `FieldLabel` / `FieldDescription` / `FieldError`：统一表单字段的标签（`13px / 500`）、辅助说明（`12px` 次级色）与错误提示（`destructive`）。
  - `PageHeader`：统一管理页顶部标题区（可选图标徽章 + 主标题 + 一句话副标题 + 右侧筛选与主操作区）。
  - `EmptyState`：统一空数据状态（图标 + 标题 + 说明 + 可选主操作按钮）。
  - `Separator`：统一水平/垂直细分隔线（`bg-border-subtle`）。
- **浮层默认值**：`DropdownMenuContent` 与 `PopoverContent` 统一 `rounded-lg`、`sideOffset={8}`、`collisionPadding={12}`、内缩 `bg-border-subtle` 分隔线与柔和悬停态。
- **图标约定**：统一使用 Lucide 具名图标（常规 `16px`，关键导航 `18px`）；纯装饰图标标 `aria-hidden="true"`，独立图标按钮必须提供本地化 `aria-label`（由 `check:ui` 的 `icon-label` 规则强制拦截）。

---

## 四、动效与验收

- 悬停与按下 `120ms`（`--motion-feedback`），选中与局部过渡 `160ms`（`--motion-fast`），较大反馈 `220ms`（`--motion-base`），统一缓动 `--ease-standard`。系统开启 `prefers-reduced-motion` 时立即呈现。
- 每次 UI 变更需通过 `npm run format:check`、`npm run check`（含 `check:ui`、`check:i18n`、`tsc`）与 `npm run build`，并在 `1280×800` 与 `1440×900` 视口下核查浅/深色主题与键盘焦点。

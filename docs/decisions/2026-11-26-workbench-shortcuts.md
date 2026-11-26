# 可配置工作台快捷操作

日期：2026-11-26。基线：`main@909d3b87b0c23bc2ec025341b280ce47e28ca554`。

## 需求与边界

在现有布局上补充左右栏显隐、会话切换、Git/终端/浏览器面板访问和会话输入聚焦。业务状态仍由原有工作台、面板和 Chat 持有。快捷模块只识别输入、展示可用命令、校验配置并调用语义化动作。不加入页面元素标签、AI 推断、全局系统热键或布局改版。

入口默认是 `Mod+;`（会话切换）和 `Mod+Shift+;`（快捷导航），其中 Mod 在 macOS 为 Command，其他平台为 Control。导航打开后 H/L 切左右栏、S 切换会话、K/J 上下会话、G/T/B 访问 Git/终端/浏览器、I 聚焦输入、逗号访问快捷设置。普通字母仅在浮层中生效；各操作的直接组合键与导航键可配置、禁用和恢复。

## 成熟实现评估

1. [react-hotkeys-hook 5.4.0](https://github.com/JohannesKlauss/react-hotkeys-hook/blob/152a04d908cf6f1183dd1a8b291583a6fccb0595/packages/react-hotkeys-hook/src/lib/useHotkeys.ts)（MIT）：支持 React 生命周期和 DOM 作用域；仍需项目实现配置持久化、系统保留组合校验、输入法保护与 Electron 原生输入匹配。该版本的监听器依赖 DOM，匹配和取消默认的顺序也不足以替代本项目的可用性仲裁。
2. [Lumino commands 2.3.4 / v2026.10.8](https://github.com/jupyterlab/lumino/blob/f1868620d0f364eb8013cd26dc77fe38b2a3da83/packages/commands/src/index.ts)（BSD-3-Clause）：命令注册与绑定分离适合扩展；完整选择器、序列重放与七个运行依赖超出本期需求，并不能直接处理 Electron Input。
3. [xterm.js 6.0.0](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/browser/CoreBrowserTerminal.ts)：目标阶段会处理并发送终端数据，普通冒泡监听无法可靠拦截工作台动作。只在 document capture 阶段消费准确命中的、已启用工作台组合，其余交给终端。
4. [Electron 45.4.1 before-input-event](https://github.com/electron/electron/blob/v45.4.1/docs/api/web-contents.md#event-before-input-event)：原生网页与工作台是独立 WebContents。使用现有输入仲裁点和受信 IPC；不用系统 globalShortcut。
5. [React 19.3 Activity](https://react.dev/reference/react/Activity)：本仓已有 React 19.3.1。隐藏子树时保留 UI/DOM 状态并清理 Effects，恢复时重新启用 Effects，适合右栏暂停原生布局订阅而保留表单状态。复用现有能力，不新增 keep-alive 框架。

决定不新增热键依赖。共享薄层仅负责版本化配置、有限的键位表达式、精确匹配和冲突校验；React 层复用已有 Radix Dialog、Button、Switch 和 typed i18n。命令 ID 与 run/available 回调分离，桌面层只认识注册的 ID 与绑定，不导入工作台业务。

## 状态、持久化和安全边界

- 偏好是独立 settings 键，通过共享 Zod schema、Drizzle 仓储、`/api/settings/shortcuts` 与具名 Query hooks 读取/保存。仅保存成功后替换运行配置；损坏的存量配置退回默认。省略项继承默认，null 禁用该入口。支持未来命令 ID。
- 已知浏览器、系统和现有应用保留组合不能录入；检查有效默认项与覆盖项的重复。不能枚举用户安装的扩展及系统自定义占用，提供更改入口与总开关，不声称全面探测系统热键。
- 精确匹配全部修饰键；IME、Dead/Process、AltGraph、重复键、composition end 边界、普通模态框及录制界面不启动动作。已消费按键到 keyup 之前不泄漏重复输入。普通键盘输入及既有编辑器/终端快捷键保持其作用域。
- 原生桥接只接受可信工作台主 frame 的已启用/可用命令，注册含 revision。只处理当前可见、聚焦、人工控制且未交接的原生标签；Agent 预期输入先按原有仲裁处理。命中后将焦点交回可信工作台，不更改网页控制权。过期命令在 renderer 再校验。
- 右栏显隐由现有 panel owner 管理，保持面板实例、展开状态和连接；折叠不等同于关闭路由/新建终端。保留 React 状态并暂停隐藏视图副作用，原生网页布局隐藏仍走原有契约。
- 会话切换复用 `openSession` 与已有 draft 生命周期，按最近更新排序，展示项目名；不把内容页前进/后退误作切会话。输入焦点通过目标会话绑定的请求和实际组件挂载交接，不能靠一次 DOM 查询或定时猜测。

## 验收

纯函数与真实 SQLite/HTTP 测试覆盖默认/覆盖/禁用、重复和保留键、IME、精确匹配和持久化。交互验收覆盖导航与会话选择、窄窗口、右栏折叠恢复、跨内容页聚焦、模态框、终端不泄漏及原生网页焦点。使用隔离 profile/data root 的真实 Electron headless 验证；实体键盘、系统配置及 IME 候选窗口与程序注入事件的差异明确记录。最终执行项目 check/test/build 及桌面构建，记录环境阻碍和实际证据。

# 前端设计语义与局部动效

## 问题与范围

atelier 的工作区继承了原型基础样式，又在页面和共享控件添加现代 UI。`styles/atelier.css` 多次重定义聊天、输入与执行轨迹规则。`Button` 的 CVA 依赖全局 `.btn-*`，`Select` 需要强制优先级覆盖全局控件样式。检视器状态标签另用原始 Tailwind 调色板。统一主题和控件能让页面消费同一套语义，也让旧覆盖按使用点移除。范围为可信 renderer 的界面、样式和验收。

## 依据与比较

- 项目沿用 `shadcn-ui/ui@f50887ae68d0fdcbfbe86b57be08af94a4c88a68` 的组件约定。已查产品内 Button、Dialog、Select、Popover 和本地 Skill 的样式与图标规则。shadcn 用颜色角色及 `-foreground` 配对，CVA 管按钮外观，Radix 管键盘、焦点和浮层。沿用本地封装可保留交互钩子和业务样式覆盖。[Theming](https://ui.shadcn.com/docs/theming) · [Button](https://ui.shadcn.com/docs/components/radix/button)
- `primer/primitives@v11.0.0` 的 `src/tokens/functional/color/fgColor.json5` 将默认、次要、禁用、强调、成功、警告和危险分配到具体角色，状态可在主题中调整。借用角色划分，继续使用 atelier 自己的配色与 Tailwind 映射。[源码](https://github.com/primer/primitives/blob/v11.0.0/src/tokens/functional/color/fgColor.json5)
- `motiondivision/motion@v14.14.0` 的 `LazyMotion` 根据同步 bundle 或异步加载器补充 Motion 功能。异步加载可延后动画代码，React 内容先渲染。14.14.0 的 npm 元数据声明 MIT、React/React DOM 18 或 19，Remix 是可选 peer。简单反馈继续走 CSS。短时局部反馈使用 Motion 的轻量组件与 `domAnimation`。Radix Portal 及焦点保留现有生命周期，原生网页遮挡继续通过 `bridge.layout` 同步。[源码](https://github.com/motiondivision/motion/blob/v14.14.0/packages/framer-motion/src/components/LazyMotion/index.tsx) · [LazyMotion](https://motion.dev/docs/react-lazy-motion) · [Accessibility](https://motion.dev/docs/react-accessibility)

## 决策

在 `frontend/src/styles.css` 维护主题角色和 shadcn 映射。公共控件持有外观变体与图标规范，应用和功能模块持有自己的布局。先迁移消费点和测试，再清理旧选择器。按钮、导航、状态、弹层使用同一主题，分隔条和 BrowserSlot 继续即时更新。动效遵从系统偏好，减少动效时主动跳过局部反馈动画。

UI 门禁沿用已有 Babel AST 解析方式，并声明 Vite 已锁定的 PostCSS 8.5.33 作为直接开发依赖。检查使用静态展示层入口。迁移后扫描结果无历史违规，门禁可以直接阻止新增命中。设计约定见 [atelier 前端设计规范](../../frontend/DESIGN.md)。

## 验证和回退

测量生产构建的首屏 JS 和动效分块。运行仓库检查、测试与前端、桌面构建。用隔离 Electron 核查三种桌面视口、窄窗、两种语言、原生网页遮挡、弹层焦点、聊天滚动、长内容和异常路径。在 [桌面执行日志](../../openspec/roadmaps/build-atelier-desktop/task-log.md) 追加实测条件和结果。可按主题、控件、页面及动效分别回退，现有数据、路由、运行时与 IPC 契约沿用。

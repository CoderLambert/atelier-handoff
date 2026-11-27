# C2 · 输入框与补全的键盘分工

## 问题与范围

补全组件在捕获阶段接管整个输入框的 Enter，还需要输入框将草稿模式映射后传入。运行可用性和引用校验分散在多个渲染层调用点。本轮覆盖[桌面工作台](../../openspec/roadmaps/build-atelier-desktop/roadmap.md)中的输入、引用和队列交互，沿用现有渲染进程、草稿格式及运行时接口。

## 取舍

- React 19 的 [textarea 事件](https://react.dev/reference/react-dom/components/textarea)、[回调 ref](https://react.dev/reference/react-dom/components/common#ref-callback)和 [useImperativeHandle](https://react.dev/reference/react/useImperativeHandle)可用于输入事件与实际节点绑定。
- [MUI v7.3.5 的 useAutocomplete](https://github.com/mui/material-ui/blob/v7.3.5/packages/mui-material/src/useAutocomplete/useAutocomplete.js#L738)在输入键盘处理器中组合外部回调，IME 未稳定时跳过选择，确认键在弹层有高亮选项时阻止表单动作。[Downshift v9.0.10 的 useCombobox](https://github.com/downshift-js/downshift/blob/v9.0.10/src/hooks/useCombobox/index.js)通过 `getInputProps` 合并键盘处理，并在候选确认时检查 IME。两者的事件分工可复用为设计依据。现有候选还涉及项目作用域、权限、光标令牌和缓存复核，采用通用补全库需要重写这些边界。
- 保留现有弹层和候选查询。Composer 处理 IME 与提交，并显式询问 Picker 是否消费普通键。有候选时 Enter 和 Tab 选中候选。空列表时 Escape 关闭弹层，Enter 和 Tab 沿用输入框的行为。Picker 随实际 textarea 节点绑定光标监听与 ARIA，外部正文变化时重新同步。Picker 接收有效权限模式并返回其负责的草稿字段。
- 共享策略保留活动运行与队列运行的筛选差异，快捷插话只接受运行中或等待审批的运行。共享引用追加函数保留三种去重键、条数优先级、格式化长度和文件引用的 schema 校验，调用方继续映射各自的错误提示。

## 验证与回退

使用 Node 纯内存测试验证模式、目录、运行、引用边界和键盘分派。Chromium 验证候选选用、Escape、IME、草稿外部更新和节点替换，真实 Electron 补验中英文输入及插话。若出现误送、候选光标失准或队列插入回归，整体回退 C2 的渲染层模块、调用方与测试即可，草稿和存储无需迁移。

```sh
TSX_TSCONFIG_PATH=frontend/tsconfig.json node --import tsx --test --test-isolation=none frontend/src/features/chat/composer-policy.test.ts
```

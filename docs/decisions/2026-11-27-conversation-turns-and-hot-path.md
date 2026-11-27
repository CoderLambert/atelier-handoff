# C3 · 对话轮次归并与流式渲染

## 问题与范围

[桌面工作台](../../openspec/roadmaps/build-atelier-desktop/roadmap.md)每次合并 SSE 快照时会重算消息顺序。有序运行逐条查找首次出现位置并扫描助手正文，且整份快照和内联渲染函数会传给历史轮次。旧历史与有序记录各自构建用户气泡、消息操作和运行结果。本轮覆盖渲染进程的对话、滚动与轨迹弹层，沿用当前 API 和持久化格式。

## 取舍

- [React memo](https://react.dev/reference/react/memo)要求比较器覆盖影响渲染和行为的 props，包括函数。[React v19.2.0 的 updateMemoComponent](https://github.com/facebook/react/blob/v19.2.0/packages/react-reconciler/src/ReactFiberBeginWork.js#L457)在没有组件更新或上下文变化时使用比较结果跳过子树工作。沿用 React 的比较入口，保留本地展开状态和语言切换。
- [TanStack Query 的结构共享说明](https://tanstack.com/query/latest/docs/framework/react/guides/render-optimizations)和其 [replaceEqualDeep 实现](https://github.com/TanStack/query/blob/main/packages/query-core/src/utils.ts#L360)说明更新后的集合可以保留未变实体的引用。轮次使用这些引用比较数组元素。对话层无需深比较内容、缓存合成记录或引入新的数据依赖。
- 纯函数按运行建立索引，再按原消息顺序发出轮次。旧历史延续占位和末条助手归属，有序记录延续首次出现位置。末条真实消息和末条显示消息各自决定消息操作与 DOM 标记。相同运行内的回复增量不会改动其他轮次的操作标记。
- 消息操作在点击时读取最近一次提交的父级回调，回退仍按当前会话和真实消息头校验。操作的可用性变化和末条标记转移仍会更新受影响的轮次。
- 共用气泡、页脚、运行结果与弹窗宿主。展开触发元素标记滚动保留意图，滚动 hook 沿用现有的底部阈值和尺寸观察逻辑。轨迹与对话保留各自的加载反馈。

## 验证与回退

以纯内存测试覆盖混合排序、占位、按运行切片、末条标记以及流式追加时的历史比较结果。浏览器验收覆盖折叠和滚动锚定、时间戳与操作、审批及输出弹窗、流式渲染次数。比较器测试可以证明相同 props 的比较结果，实际渲染次数和延迟需要浏览器测量。若出现有序记录的位置、消息操作或滚动回归，整体回退 C3 的渲染模块和调用方即可，已有记录无需迁移。

```sh
NODE_OPTIONS=--test-isolation=none TSX_TSCONFIG_PATH=frontend/tsconfig.json node --import tsx --test frontend/src/features/chat/conversation-turns.test.ts
```

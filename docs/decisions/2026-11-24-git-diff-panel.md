# Git 差异面板与语法高亮

## 问题与范围

Git 看板原先在居中弹窗中显示补丁原文。桌面窗口需要和会话并排核对变动，查看原行、新行和代码语法，也要能让差异临时占满工作台。变更位于 renderer。补丁继续由运行时生成，Git 操作权限与数据格式沿用当前方案。[Git 开发会话决策](2026-11-24-git-development-sessions.md)

## 查阅与取舍

- [shadcn resizable](https://ui.shadcn.com/docs/components/resizable) 使用 react-resizable-panels。检查项目锁定的 4.24.1 中 Group、Panel 和 Separator 的源码，现有工作区分隔条已支持鼠标和键盘调整。复用它，单独记住 Git 的本次窗口宽度。把 Git 内容保留在同一个面板节点，用覆盖工作台的布局扩展，切换时保留列表选择和滚动。新建开发会话仍使用共享 Radix Dialog。
- [Git 补丁格式](https://git-scm.com/docs/diff-format) 定义扩展头、普通分块和合并差异。[GitHub Desktop 的 DiffParser](https://github.com/desktop/desktop/blob/development/app/src/lib/diff-parser.ts) 在解析分块时分别维护原文件和新文件行号。检查锁定的 jsdiff 9.0.0 的 parsePatch 和 parseHunk，已处理引号路径、重命名和分块计数。复用解析器并从分块生成显示行，逐文件保留无法结构化的原文。
- [Streamdown code 插件](https://streamdown.ai/docs/plugins/code) 按语言延迟加载 Shiki 词法规则。实测锁定的 2.0.1 对 TypeScript 同时返回颜色和暗色变量。复用 Markdown 的高对比主题及插件实例，分别对可见分块的原文和新文着色。React 将词素作为文本渲染。未知语言、加载失败和超过高亮预算的补丁继续显示内容。

## 验证与回退

用普通、多文件、二进制、合并和超长补丁核对行号及原文回退。在隔离的 Electron 窗口验证拖动、全屏与复位、文件选择、Git 与浏览器切换和两种界面语言。需要回退时恢复 Git 原看板与补丁展示，运行时与存储无需回滚。

安装态复核中，左栏设为 408px 时把 Git 分隔条向左拖到边界，分栏库会继续把左栏压缩到 190px。Git 的最大宽度据左栏和会话最小空间计算，并只保存实际调过的导航宽度。启动和拖动边界用同一设置回归。

# @atelier/markdown

面向 React 18 / 19 的 Markdown 组件，内置流式渲染、Shiki 代码高亮、KaTeX 公式、Mermaid 和中日韩标点处理。包提供 ESM、TypeScript 类型、预编译 CSS 和本地公式字体。

在 atelier 仓库运行 `npm run pack:markdown`。将生成的 `.tgz` 安装到目标项目：

```sh
npm install ./atelier-markdown-0.1.0.tgz
```

```tsx
import { Markdown } from '@atelier/markdown';
import '@atelier/markdown/style.css';

<Markdown text={reply} streaming={isGenerating} />;
```

`streaming` 默认为 `false`。生成中，Mermaid 保留为源码，完成后转换成可缩放的图表。独立的 `mindmap` 文本也能渲染。行内公式使用 `$…$`，独立公式使用 `$$…$$`。

通过 `className` 添加容器样式，可设置 `--markdown-bg`、`--markdown-fg`、`--markdown-border`、`--markdown-muted`、`--markdown-muted-fg` 和 `--markdown-link`。样式入口已经包含所需工具类，使用方只需导入一次。

通过 `renderers` 注册宿主提供的 React 组件，按自定义代码围栏的语言匹配。包导出 `CustomRenderer` 和 `CustomRendererProps` 类型。组件收到 `code` 和 `isIncomplete` 等字段，应校验模型提供的数据。`mermaid` 为内置保留语言。

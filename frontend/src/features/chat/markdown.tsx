import { memo } from 'react';
import {
  defaultRehypePlugins,
  Streamdown,
  type Components,
  type DiagramPlugin,
  type MermaidErrorComponentProps,
} from 'streamdown';

const safePlugins = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== 'raw')
  .map(([, plugin]) => plugin);

const components: Components = {
  strong: ({ children }) => <strong>{children}</strong>,
  img: ({ alt }) => <span>{alt || '图片'}</span>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

const mermaid: DiagramPlugin = {
  name: 'mermaid',
  type: 'diagram',
  language: 'mermaid',
  getMermaid() {
    return {
      initialize() {},
      async render(id, source) {
        if (source.length > 24_000) throw new Error('图表源码超过显示上限。');
        if (/^\s*---(?:\r?\n|$)|%%\s*\{/.test(source)) throw new Error('图表包含自定义运行配置。');
        const { mermaid } = await import('@streamdown/mermaid');
        return mermaid
          .getMermaid({
            securityLevel: 'strict',
            startOnLoad: false,
            suppressErrorRendering: true,
            fontFamily: 'system-ui, sans-serif',
          })
          .render(id, source);
      },
    };
  },
};
const plugins = { mermaid };
const controls = {
  code: { copy: true, download: false },
  table: false,
  mermaid: { copy: true, download: false, fullscreen: false, panZoom: true },
};

function DiagramError({ chart }: MermaidErrorComponentProps) {
  return (
    <div className="chat-diagram-error">
      <p>图表暂时无法渲染，可以查看 Mermaid 源码。</p>
      <pre>
        <code>{chart}</code>
      </pre>
    </div>
  );
}
const diagramOptions = { errorComponent: DiagramError };

function standaloneMindmap(text: string) {
  const trimmed = text.trim();
  const [first, ...lines] = trimmed.split(/\r?\n/);
  if (
    first !== 'mindmap' ||
    !lines.length ||
    !lines.every((line) => !line.trim() || /^\s+\S/.test(line))
  )
    return text;
  return `\`\`\`mermaid\n${trimmed}\n\`\`\``;
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  // Show diagram source until the reply finishes to avoid parsing partial diagrams.
  return (
    <Streamdown
      className="markdown-body chat-markdown min-w-0"
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      skipHtml
      rehypePlugins={safePlugins}
      components={components}
      urlTransform={(url) => (/^(https?:\/\/|mailto:)/i.test(url) ? url : '')}
      controls={controls}
      mermaid={diagramOptions}
      plugins={streaming ? undefined : plugins}
    >
      {standaloneMindmap(text)}
    </Streamdown>
  );
});

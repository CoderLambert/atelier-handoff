import { memo, useEffect, useMemo, useState } from 'react';
import { cjk } from '@streamdown/cjk';
import {
  defaultRehypePlugins,
  Streamdown,
  type Components,
  type CustomRenderer,
  type DiagramPlugin,
  type MermaidErrorComponentProps,
  type PluginConfig,
} from 'streamdown';

export type { CustomRenderer, CustomRendererProps } from 'streamdown';

export interface MarkdownProps {
  text: string;
  streaming?: boolean;
  className?: string;
  renderers?: CustomRenderer[];
}

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

let mathLoader: Promise<PluginConfig['math']> | undefined;
function loadMath() {
  return (mathLoader ??= import('@streamdown/math').then(({ createMathPlugin }) =>
    // The official plugin uses KaTeX's untrusted mode (`trust: false`) by default.
    createMathPlugin({ singleDollarTextMath: true, errorColor: 'currentColor' }),
  ));
}
const controls = {
  code: { copy: true, download: false },
  table: false,
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
};
const translations = {
  viewFullscreen: '全屏查看',
  exitFullscreen: '退出全屏',
  zoomIn: '放大',
  zoomOut: '缩小',
  resetView: '重置视图',
};
const rawLanguages = ['mermaid'];
const urlTransform = (url: string) => (/^(https?:\/\/|mailto:)/i.test(url) ? url : '');

function DiagramError({ chart }: MermaidErrorComponentProps) {
  return (
    <div className="atelier-markdown-diagram-error">
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
  // Match a fence longer than any runs of backticks already present in the source.
  const length =
    (trimmed.match(/`{3,}/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2) + 1;
  const fence = '`'.repeat(length);
  return `${fence}mermaid\n${trimmed}\n${fence}`;
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  className,
  renderers,
}: MarkdownProps) {
  const [code, setCode] = useState<PluginConfig['code']>();
  const [math, setMath] = useState<PluginConfig['math']>();
  const needsCode = !code && /`{3,}|~{3,}/.test(text);
  const needsMath = !math && text.includes('$');

  useEffect(() => {
    if (!needsCode) return;
    let active = true;
    void import('@streamdown/code').then(
      ({ createCodePlugin }) => {
        if (active) {
          setCode(
            createCodePlugin({
              themes: ['github-light-high-contrast', 'github-dark-high-contrast'],
            }),
          );
        }
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [needsCode]);

  useEffect(() => {
    if (!needsMath) return;
    let active = true;
    void loadMath().then(
      (plugin) => {
        if (active) setMath(plugin);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [needsMath]);

  const plugins = useMemo<PluginConfig>(
    () => ({
      cjk,
      code,
      math,
      mermaid: streaming ? undefined : mermaid,
      renderers: renderers?.filter(({ language }) => ![language].flat().includes('mermaid')),
    }),
    [code, math, streaming, renderers],
  );

  return (
    <div className={className ? `atelier-markdown ${className}` : 'atelier-markdown'}>
      <Streamdown
        prefix="am"
        mode={streaming ? 'streaming' : 'static'}
        isAnimating={streaming}
        skipHtml
        rehypePlugins={safePlugins}
        components={components}
        urlTransform={urlTransform}
        controls={controls}
        translations={translations}
        mermaid={diagramOptions}
        plugins={plugins}
        codeBlockRawLanguages={rawLanguages}
      >
        {standaloneMindmap(text)}
      </Streamdown>
    </div>
  );
});

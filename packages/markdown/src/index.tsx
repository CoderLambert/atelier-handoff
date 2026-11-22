/**
 * @file 提供可嵌入的流式 Markdown 渲染。
 * @implementation 组合 Streamdown、格式插件及 URL 过滤，支持调用方接管网页链接的打开行为。
 * @updated 2026-11-20T17:57:00+08:00
 */
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
} from 'react';
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

import { markdownMessages, type MarkdownLocale, type MarkdownMessages } from './messages.js';

export { markdownMessages } from './messages.js';
export type { MarkdownLocale, MarkdownMessages } from './messages.js';
export type { CustomRenderer, CustomRendererProps } from 'streamdown';

const MessageContext = createContext<MarkdownMessages>(markdownMessages['zh-CN']);
function ImageFallback({ alt }: { alt?: string }) {
  const messages = useContext(MessageContext);
  return <span>{alt || messages.imageFallback}</span>;
}

export interface MarkdownProps {
  text: string;
  locale?: MarkdownLocale;
  messages?: Partial<MarkdownMessages>;
  streaming?: boolean;
  className?: string;
  renderers?: CustomRenderer[];
  onLinkClick?: (url: string, event: MouseEvent<HTMLAnchorElement>) => void;
}

const safePlugins = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== 'raw')
  .map(([, plugin]) => plugin);

const components: Components = {
  strong: ({ children }) => <strong>{children}</strong>,
  img: ({ alt }) => <ImageFallback alt={alt} />,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

function createMermaid(messages: MarkdownMessages): DiagramPlugin {
  return {
    name: 'mermaid',
    type: 'diagram',
    language: 'mermaid',
    getMermaid() {
      return {
        initialize() {},
        async render(id, source) {
          if (source.length > 24_000) throw new Error(messages.diagramTooLarge);
          if (/^\s*---(?:\r?\n|$)|%%\s*\{/.test(source))
            throw new Error(messages.diagramCustomConfig);
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
}

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
const rawLanguages = ['mermaid'];
const urlTransform = (url: string) => (/^(https?:\/\/|mailto:)/i.test(url) ? url : '');

function DiagramError({ chart }: MermaidErrorComponentProps) {
  const messages = useContext(MessageContext);
  return (
    <div className="atelier-markdown-diagram-error">
      <p>{messages.diagramError}</p>
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
  locale = 'zh-CN',
  messages,
  className,
  renderers,
  onLinkClick,
}: MarkdownProps) {
  const translations = useMemo<MarkdownMessages>(
    () => ({ ...markdownMessages[locale], ...messages }),
    [locale, messages],
  );
  const mermaid = useMemo(() => createMermaid(translations), [translations]);
  const linkComponents = useMemo<Components>(() => {
    if (!onLinkClick) return components;
    return {
      ...components,
      a: ({ href, children }) => {
        if (!href) return <span>{children}</span>;
        const activate = /^https?:\/\//i.test(href)
          ? (event: MouseEvent<HTMLAnchorElement>) => {
              if (event.defaultPrevented || event.button > 1) return;
              event.preventDefault();
              onLinkClick(href, event);
            }
          : undefined;
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={activate}
            onAuxClick={activate}
          >
            {children}
          </a>
        );
      },
    };
  }, [onLinkClick]);
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
    [code, math, streaming, renderers, mermaid],
  );

  return (
    <MessageContext.Provider value={translations}>
      <div className={className ? `atelier-markdown ${className}` : 'atelier-markdown'}>
        <Streamdown
          prefix="am"
          mode={streaming ? 'streaming' : 'static'}
          isAnimating={streaming}
          skipHtml
          rehypePlugins={safePlugins}
          components={linkComponents}
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
    </MessageContext.Provider>
  );
});

/**
 * @file 渲染工作台的会话 Markdown。
 * @implementation 复用流式渲染组件，应用聊天样式并转发可选的链接打开入口。
 * @updated 2026-11-20T17:57:00+08:00
 */
import { useUiTranslation } from '@/i18n';
import { Markdown as RichMarkdown, type MarkdownProps } from '@atelier/markdown';
import '@atelier/markdown/style.css';

export function Markdown({
  text,
  streaming,
  onLinkClick,
}: Pick<MarkdownProps, 'text' | 'streaming' | 'onLinkClick'>) {
  const { locale } = useUiTranslation('chat');
  return (
    <RichMarkdown
      locale={locale}
      text={text}
      streaming={streaming}
      onLinkClick={onLinkClick}
      className="markdown-body chat-markdown"
    />
  );
}

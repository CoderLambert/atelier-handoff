import { Markdown as RichMarkdown, type MarkdownProps } from '@atelier/markdown';
import '@atelier/markdown/style.css';

export function Markdown({ text, streaming }: Pick<MarkdownProps, 'text' | 'streaming'>) {
  return <RichMarkdown text={text} streaming={streaming} className="markdown-body chat-markdown" />;
}

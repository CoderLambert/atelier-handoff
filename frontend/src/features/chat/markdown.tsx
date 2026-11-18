import { memo, useMemo, useState, type MouseEvent } from 'react';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });
const escape = markdown.utils.escapeHtml;

// Model output must not load remote images or navigate to local/active URLs.
markdown.validateLink = (url) => /^(https?:\/\/|mailto:)/i.test(url);
markdown.renderer.rules.image = (tokens, index) => escape(tokens[index].content || '图片');
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
const renderFence = markdown.renderer.rules.fence!;
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const language = tokens[index].info.trim().split(/\s+/)[0] || '代码';
  return `<div class="code-panel"><div class="code-toolbar"><span>${escape(language)}</span><button type="button" data-copy-code>复制代码</button></div>${renderFence(tokens, index, options, env, renderer)}</div>`;
};
markdown.renderer.rules.table_open = () =>
  '<div class="table-scroll" tabindex="0" role="region" aria-label="表格"><table>';
markdown.renderer.rules.table_close = () => '</table></div>';

export function renderMarkdown(text: string) {
  return markdown.render(text);
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const [feedback, setFeedback] = useState('');

  async function copyCode(event: MouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button[data-copy-code]');
    if (!button || !event.currentTarget.contains(button)) return;
    const code = button.closest('.code-panel')?.querySelector('pre code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent || '');
      setFeedback('代码已复制');
    } catch {
      setFeedback('复制失败，请选择代码后手动复制。');
    }
  }

  return (
    <div>
      <div
        className="markdown-body"
        onClick={copyCode}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <span className="sr-only" role="status">
        {feedback}
      </span>
    </div>
  );
});

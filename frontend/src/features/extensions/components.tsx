import {
  Braces,
  ChartNoAxesColumnIncreasing,
  FileText,
  Layers3,
  Palette,
  Sparkles,
} from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { messageOf } from './api';

const marketIcons = {
  'design-media': { icon: Palette, tone: 'design' },
  'dev-programming': { icon: Braces, tone: 'development' },
  'content-creation': { icon: FileText, tone: 'writing' },
  'office-efficiency': { icon: FileText, tone: 'writing' },
  'data-analysis': { icon: ChartNoAxesColumnIncreasing, tone: 'data' },
  'ai-agent': { icon: Sparkles, tone: 'development' },
} as const;

export function MarketCategoryIcon({ category }: { category?: string }) {
  const entry = marketIcons[category as keyof typeof marketIcons];
  const Icon = entry?.icon ?? Layers3;
  return (
    <span className="market-category-icon" data-tone={entry?.tone ?? 'default'} aria-hidden="true">
      <Icon size={18} strokeWidth={1.8} />
    </span>
  );
}

export function FeatureDialog({
  title,
  description,
  busy = false,
  className = '',
  onClose,
  children,
}: {
  title: string;
  description?: string;
  busy?: boolean;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className={`ext-dialog max-h-[90dvh] w-[calc(100%-32px)] overflow-y-auto sm:max-w-[960px] ${className}`}
        aria-busy={busy}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? '管理当前项目的扩展。'}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function ActionButton({
  children,
  primary,
  danger,
  className = '',
  ...props
}: React.ComponentProps<typeof Button> & { primary?: boolean; danger?: boolean }) {
  return (
    <Button
      type="button"
      {...props}
      className={`ext-button ${primary ? 'ext-button-primary' : ''} ${danger ? 'ext-button-danger' : ''} ${className}`}
    >
      {children}
    </Button>
  );
}
export function ErrorMessage({ error }: { error: unknown }) {
  return error ? (
    <p className="ext-form-error" role="alert">
      {typeof error === 'string' ? error : messageOf(error)}
    </p>
  ) : null;
}
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="ext-field">
      <span>{label}</span>
      {children}
      {help ? <small>{help}</small> : null}
    </label>
  );
}
export function safeHref(url?: string) {
  try {
    const parsed = new URL(url ?? '');
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function SourceLink({ url, children }: { url?: string; children: ReactNode }) {
  const href = safeHref(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}
let markdownRenderer: Promise<(body: string) => string> | undefined;
function renderMarkdown(body: string) {
  markdownRenderer ??= import('markdown-it').then(({ default: MarkdownIt }) => {
    const renderer = new MarkdownIt({ html: false, linkify: false });
    renderer.renderer.rules.image = (tokens, index) =>
      renderer.utils.escapeHtml(tokens[index]?.content ?? '图片');
    renderer.renderer.rules.link_open = (tokens, index, options, _env, self) => {
      tokens[index]?.attrSet('target', '_blank');
      tokens[index]?.attrSet('rel', 'noopener noreferrer');
      return self.renderToken(tokens, index, options);
    };
    return (text: string) => renderer.render(text);
  });
  return markdownRenderer.then((render) => render(body));
}
export function MarkdownPreview({
  body,
  label = '预览内容',
  initiallyOpen = false,
  standalone = false,
}: {
  body: string;
  label?: string;
  initiallyOpen?: boolean;
  standalone?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen || standalone);
  const [html, setHtml] = useState<{ body: string; html: string }>();
  useEffect(() => {
    if (!open) return;
    let active = true;
    void renderMarkdown(body)
      .then((value) => {
        if (active) setHtml({ body, html: value });
      })
      .catch(() => {
        /* Plain text remains available. */
      });
    return () => {
      active = false;
    };
  }, [body, open]);
  const content =
    html?.body === body ? (
      <div className="ext-prose" dangerouslySetInnerHTML={{ __html: html.html }} />
    ) : (
      <pre className="ext-body-preview">{body || '暂无内容'}</pre>
    );
  if (standalone) return content;
  return (
    <details
      className="ext-preview"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{label}</summary>
      {open ? content : null}
    </details>
  );
}
export function BackupActions({
  body,
  name,
  version,
}: {
  body: string;
  name: string;
  version: number;
}) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  async function copy() {
    setError('');
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error('当前浏览器无法复制，请下载 Markdown 备份。');
      await navigator.clipboard.writeText(body);
      setStatus('已复制本地正文。');
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  function download() {
    setError('');
    try {
      const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name.replace(/[^\p{L}\p{N}_-]/gu, '-')}-local-v${version}.md`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('已发起 Markdown 备份下载。');
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <>
      <div className="ext-backup-actions">
        <ActionButton onClick={() => void copy()}>复制本地正文</ActionButton>
        <ActionButton onClick={download}>下载 Markdown 备份</ActionButton>
      </div>
      <p className="ext-help" role="status">
        {status}
      </p>
      <ErrorMessage error={error} />
    </>
  );
}
export function Switch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: () => void;
}) {
  const id = useId();
  return (
    <button
      id={id}
      type="button"
      className="ext-switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

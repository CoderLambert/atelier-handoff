/**
 * @file 提供扩展管理界面的共享组件。
 * @implementation 组合对话框、字段、来源链接和 Markdown 预览，并提供本地内容复制与下载操作。
 * @updated 2026-11-23T04:52:50+08:00
 */
import { getTranslator, useUiTranslation } from '@/i18n';
import {
  Braces,
  ChartNoAxesColumnIncreasing,
  Copy,
  Download,
  FileText,
  Layers3,
  Palette,
  Plug,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import type { ExtensionKind } from './api';
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
      <Icon aria-hidden="true" />
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
  const { t } = useUiTranslation('extensions');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className={cn(
          'ext-dialog max-h-[90dvh] w-[calc(100%-32px)] overflow-y-auto sm:max-w-[960px]',
          className,
        )}
        aria-busy={busy}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? t('preview.dialogDescription')}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function ActionButton({
  className,
  variant = 'outline',
  ...props
}: React.ComponentProps<typeof Button>) {
  return <Button variant={variant} {...props} className={cn('ext-button', className)} />;
}
export function ErrorMessage({ error }: { error: unknown }) {
  useUiTranslation('extensions');
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
      renderer.utils.escapeHtml(
        tokens[index]?.content ?? getTranslator('extensions')('preview.image'),
      );
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
  label,
  initiallyOpen = false,
  standalone = false,
}: {
  body: string;
  label?: string;
  initiallyOpen?: boolean;
  standalone?: boolean;
}) {
  const { t, locale } = useUiTranslation('extensions');
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
  }, [body, open, locale]);
  const content =
    html?.body === body ? (
      <div className="ext-prose" dangerouslySetInnerHTML={{ __html: html.html }} />
    ) : (
      <pre className="ext-body-preview">{body || t('preview.empty')}</pre>
    );
  if (standalone) return content;
  return (
    <details
      className="ext-preview"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{label ?? t('preview.label')}</summary>
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
  const { t } = useUiTranslation('extensions');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  async function copy() {
    setError('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t('preview.copyUnsupported'));
      await navigator.clipboard.writeText(body);
      setStatus(t('preview.copied'));
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
      setStatus(t('preview.downloadStarted'));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <>
      <div className="ext-backup-actions">
        <ActionButton size="sm" onClick={() => void copy()}>
          <Copy data-icon="inline-start" aria-hidden="true" />
          {t('preview.copy')}
        </ActionButton>
        <ActionButton size="sm" onClick={download}>
          <Download data-icon="inline-start" aria-hidden="true" />
          {t('preview.backup')}
        </ActionButton>
      </div>
      <p className="ext-help" role="status">
        {status}
      </p>
      <ErrorMessage error={error} />
    </>
  );
}
const extensionIcons = { skill: Sparkles, command: Terminal, mcp: Plug } as const;

export function ExtensionKindIcon({ kind }: { kind?: ExtensionKind }) {
  const Icon = kind ? extensionIcons[kind] : Layers3;
  return <Icon data-icon="inline-start" aria-hidden="true" />;
}

/**
 * @file 展示输入草稿中的上下文、附件及引用。
 * @implementation 沿用草稿预览、上传反馈和移除操作的 DOM、无障碍名称与样式。
 * @updated 2026-11-27T18:34:46+08:00
 */
import { File as FileIcon, Paperclip, Quote, X } from 'lucide-react';
import { fileQuoteLocation, type MessageQuote } from '@shared/message-quotes';
import type { Attachment } from '@shared/types';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import { AttachmentPreview } from './attachment-preview';

export function ComposerContextChips({
  contextPaths,
  attachmentIds,
  stagedAttachments,
  attachments,
  uploads,
  removing,
  disabled,
  onRemoveContext,
  onRemoveAttachment,
  onDismissUpload,
}: {
  contextPaths: readonly string[];
  attachmentIds: readonly string[];
  stagedAttachments?: ReadonlyMap<string, string>;
  attachments: readonly Attachment[];
  uploads: readonly { id: string; name: string; error?: string }[];
  removing: readonly string[];
  disabled: boolean;
  onRemoveContext: (path: string) => void;
  onRemoveAttachment: (id: string) => void;
  onDismissUpload: (id: string) => void;
}) {
  const { t } = useUiTranslation('chat');
  if (!contextPaths.length && !attachmentIds.length && !uploads.length) return null;
  const byId = new Map(attachments.map((item) => [item.id, item]));
  return (
    <div className="composer-chips-bar" aria-label={t('composer.draftContext')}>
      {contextPaths.map((path) => {
        const lastSlash = path.lastIndexOf('/');
        const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
        const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
        return (
          <Button
            key={path}
            type="button"
            variant="secondary"
            size="xs"
            className="context-chip"
            disabled={disabled}
            aria-label={t('composer.removeContext', { path })}
            title={path}
            onClick={() => onRemoveContext(path)}
          >
            <FileIcon className="size-3 text-muted-foreground shrink-0" aria-hidden="true" />
            <span className="truncate">
              {dir ? <span className="opacity-60 font-mono text-[11px]">{dir}</span> : null}
              <strong className="font-semibold text-foreground">{name}</strong>
            </span>
            <X data-icon="inline-end" aria-hidden="true" />
          </Button>
        );
      })}
      {attachmentIds.map((id) => {
        const item = byId.get(id);
        const name = item?.name ?? stagedAttachments?.get(id) ?? id;
        const isRemoving = removing.includes(id);
        return (
          <div key={id} className="context-chip attachment-chip">
            {item ? (
              <AttachmentPreview attachment={item}>
                <Paperclip data-icon="inline-start" aria-hidden="true" />
                <span className="truncate" title={name}>
                  {name}
                </span>
              </AttachmentPreview>
            ) : (
              <span>{name}</span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="attachment-remove"
              disabled={disabled || isRemoving}
              aria-label={t('composer.removeAttachment', { name })}
              title={isRemoving ? t('composer.removing') : t('composer.removeAttachmentTitle')}
              onClick={() => onRemoveAttachment(id)}
            >
              <X data-icon="inline-start" aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      {uploads.map((entry) =>
        entry.error ? (
          <Button
            key={entry.id}
            type="button"
            variant="outline"
            size="xs"
            className="context-chip chat-upload-error"
            aria-label={t('composer.dismissUpload', { name: entry.name, error: entry.error })}
            onClick={() => onDismissUpload(entry.id)}
          >
            {t('composer.failedUpload', { name: entry.name, error: entry.error })}
            <X data-icon="inline-end" aria-hidden="true" />
          </Button>
        ) : (
          <span key={entry.id} className="context-chip" role="status">
            {t('composer.uploadingFile', { name: entry.name })}
          </span>
        ),
      )}
    </div>
  );
}

export function ComposerQuotes({
  quotes,
  disabled,
  onRemoveQuote,
}: {
  quotes?: readonly MessageQuote[];
  disabled: boolean;
  onRemoveQuote: (id: string) => void;
}) {
  const { t } = useUiTranslation('chat');
  if (!quotes?.length) return null;
  return (
    <ul
      className="composer-quotes"
      aria-label={t(quotes.some(({ file }) => file) ? 'composer.fileQuotes' : 'composer.quotes')}
    >
      {quotes.map((item, index) => (
        <li key={item.id} className="composer-quote">
          <Quote data-icon="inline-start" className="composer-quote-mark" aria-hidden="true" />
          {item.file ? (
            <div className="composer-file-quote">
              <code className="composer-file-quote-location" title={fileQuoteLocation(item.file)}>
                {fileQuoteLocation(item.file)}
              </code>
              <span className="composer-quote-excerpt">{item.text}</span>
            </div>
          ) : (
            <span className="composer-quote-excerpt">{item.text}</span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label={t('composer.removeQuoteNumber', { number: index + 1 })}
            title={t('composer.removeQuote')}
            onClick={() => onRemoveQuote(item.id)}
          >
            <X data-icon="inline-start" aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

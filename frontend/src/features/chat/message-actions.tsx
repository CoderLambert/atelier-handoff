/**
 * @file 提供消息的复制、编辑、引用与历史导航操作。
 * @implementation 为每条消息维护剪贴板反馈及手动复制入口，向会话输入区传递引用动作，并在取消编辑或回退后归还焦点。
 * @updated 2026-11-22T14:32:13+08:00
 */
import { useUiTranslation, getTranslator, translateError } from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, GitFork, Pencil, Quote, RotateCcw } from 'lucide-react';
import { activeStatuses, type Message } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  hasMessageForkAnchor,
  rewindUnavailableReason,
  type CopyFeedback,
  type MessageDraftAction,
} from './message-actions-model';
import { Textarea } from '@/components/ui/textarea';

export {
  hasMessageForkAnchor,
  rewindUnavailableReason,
  type CopyFeedback,
  type MessageDraftAction,
} from './message-actions-model';

export function MessageActions({
  message,
  disabled,
  onEdit,
  onQuote,
  onFork,
  forking,
  forkDisabled,
  onRewind,
  subsequentMessageCount = 0,
  rewindDisabledReason,
}: {
  message: Message;
  disabled: boolean;
  onEdit?: MessageDraftAction;
  onQuote?: MessageDraftAction;
  onFork?: (messageId: string) => void;
  forking?: boolean;
  forkDisabled?: boolean;
  onRewind?: MessageDraftAction;
  subsequentMessageCount?: number;
  rewindDisabledReason?: string;
}) {
  const { t } = useUiTranslation('chat');
  const active = useRef(true);
  const copying = useRef(false);
  const [feedback, setFeedback] = useState<CopyFeedback>();
  const assistant = message.role === 'assistant';
  const copyLabel = assistant ? t('message.copyMarkdown') : t('message.copy');

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function copy() {
    if (!active.current || copying.current) return;
    const text = message.text;
    copying.current = true;
    setFeedback({ status: 'pending', text });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (active.current) setFeedback({ status: 'copied', text });
    } catch {
      if (active.current) setFeedback({ status: 'error', text });
    } finally {
      copying.current = false;
    }
  }

  return (
    <div
      className="message-actions"
      data-feedback={feedback?.status}
      data-forking={forking || undefined}
    >
      <div className="message-action-buttons" role="group" aria-label={t('message.actions')}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={copyLabel}
          title={feedback?.status === 'copied' ? t('message.copiedAtClick') : copyLabel}
          disabled={feedback?.status === 'pending'}
          onClick={() => void copy()}
        >
          {feedback?.status === 'copied' ? (
            <Check data-icon="inline-start" aria-hidden="true" />
          ) : (
            <Copy data-icon="inline-start" aria-hidden="true" />
          )}
        </Button>
        {assistant && onQuote ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('message.quote')}
            title={t('message.quote')}
            disabled={disabled}
            onClick={(event) => onQuote(message, event.currentTarget)}
          >
            <Quote data-icon="inline-start" aria-hidden="true" />
          </Button>
        ) : !assistant && onEdit ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('message.editAndSend')}
            title={t('message.editAndSend')}
            disabled={disabled}
            onClick={(event) => onEdit(message, event.currentTarget)}
          >
            <Pencil data-icon="inline-start" aria-hidden="true" />
          </Button>
        ) : null}
        {hasMessageForkAnchor(message) && onFork ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('message.fork')}
            title={forking ? t('message.forking') : t('message.fork')}
            disabled={forkDisabled}
            onClick={() => onFork(message.id)}
          >
            <GitFork data-icon="inline-start" aria-hidden="true" />
          </Button>
        ) : null}
        {hasMessageForkAnchor(message) && onRewind && subsequentMessageCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('message.rewind')}
            title={rewindDisabledReason || t('message.rewind')}
            disabled={Boolean(rewindDisabledReason)}
            onClick={(event) => onRewind(message, event.currentTarget)}
          >
            <RotateCcw data-icon="inline-start" aria-hidden="true" />
          </Button>
        ) : null}
        <span className="message-copy-status" role="status">
          {feedback?.status === 'pending'
            ? t('message.copying')
            : feedback?.status === 'copied'
              ? t('message.copied')
              : forking
                ? t('message.forking')
                : ''}
        </span>
      </div>
      {feedback?.status === 'error' ? (
        <div className="message-copy-fallback">
          <p role="alert">{t('message.copyFailed')}</p>
          <Textarea
            aria-label={assistant ? t('message.markdownToCopy') : t('message.textToCopy')}
            readOnly
            rows={3}
            value={feedback.text}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}
    </div>
  );
}

export function RewindMessageDialog({
  message,
  subsequentMessageCount,
  projectPath,
  trigger,
  disabledReason,
  onConfirm,
  onClose,
  onConfirmedFocus,
}: {
  message: Message;
  subsequentMessageCount: number;
  projectPath: string;
  trigger: HTMLButtonElement;
  disabledReason?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  onConfirmedFocus: () => void;
}) {
  const { t } = useUiTranslation('chat');
  const cancel = useRef<HTMLButtonElement>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  const confirmed = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ cause: unknown }>();

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  function close() {
    if (inFlight.current) return;
    active.current = false;
    onClose();
  }

  async function confirm() {
    if (!active.current || inFlight.current || disabledReason) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onConfirm();
      if (active.current) {
        confirmed.current = true;
        active.current = false;
        onClose();
      }
    } catch (failure) {
      if (active.current) {
        setError({ cause: failure });
      }
    } finally {
      inFlight.current = false;
      if (active.current) setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="flex max-h-[85dvh] flex-col gap-4 overflow-y-auto"
        showCloseButton={!pending}
        onEscapeKeyDown={(event) => {
          if (inFlight.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (inFlight.current) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (confirmed.current || !trigger.isConnected) onConfirmedFocus();
          else trigger.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('rewind.title')}</DialogTitle>
          <DialogDescription>
            {t('rewind.description', { count: subsequentMessageCount })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <p>
            {t('rewind.selectedMessage', {
              author: message.role === 'assistant' ? 'atelier' : t('conversation.you'),
            })}
          </p>
          <blockquote className="max-h-40 overflow-y-auto whitespace-pre-wrap wrap-anywhere">
            {message.text.trim() ? message.text.slice(0, 600) : t('rewind.noText')}
            {message.text.length > 600 ? '…' : ''}
          </blockquote>
          <p>{t('rewind.projectDirectory')}</p>
          <p className="wrap-anywhere" dir="ltr">
            {projectPath}
          </p>
          <p>{t('rewind.environmentHelp')}</p>
        </div>
        {disabledReason ? <p role="alert">{disabledReason}</p> : null}
        {error ? (
          <div className="text-destructive wrap-anywhere" role="alert">
            <p>{translateError(error.cause, t('rewind.failed'))}</p>
            {error.cause instanceof Error && error.cause.message ? (
              <details>
                <summary>{t('message.errorDetails')}</summary>
                <pre className="whitespace-pre-wrap wrap-anywhere">{error.cause.message}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
        {pending ? <p role="status">{t('rewind.rewinding')}</p> : null}
        <DialogFooter>
          <Button ref={cancel} type="button" variant="outline" disabled={pending} onClick={close}>
            {t('message.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || Boolean(disabledReason)}
            onClick={() => void confirm()}
          >
            {t('rewind.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReplaceDraftDialog({
  trigger,
  disabled,
  onConfirm,
  onClose,
  onConfirmedFocus,
}: {
  trigger: HTMLButtonElement;
  disabled: boolean;
  onConfirm: () => boolean;
  onClose: () => void;
  onConfirmedFocus: () => void;
}) {
  const { t } = useUiTranslation('chat');
  const cancel = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (confirmed.current) onConfirmedFocus();
          else if (trigger.isConnected) trigger.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('draft.replaceTitle')}</DialogTitle>
          <DialogDescription>{t('draft.replaceDescription')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button ref={cancel} type="button" variant="outline">
              {t('draft.keep')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (!onConfirm()) return;
              confirmed.current = true;
              onClose();
            }}
          >
            {t('draft.replace')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

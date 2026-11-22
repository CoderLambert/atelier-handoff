/**
 * @file 提供会话网页链接的打开位置选择。
 * @implementation 复用 Dialog 展示目标地址，通过回调打开网页，隔离已关闭弹窗的异步结果并恢复原链接焦点。
 * @updated 2026-11-20T17:55:38+08:00
 */
import { useUiTranslation, translateError } from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Globe } from 'lucide-react';
import { desktopBrowserUrlSchema } from '@shared/desktop-browser';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type ChatLinkOpener = (url: string, destination: 'internal' | 'external') => Promise<void>;

export function ChatWebLinkDialog({
  url,
  trigger,
  onOpenLink,
  onClose,
}: {
  url: string;
  trigger: HTMLAnchorElement;
  onOpenLink: ChatLinkOpener;
  onClose: () => void;
}) {
  const { t } = useUiTranslation('chat');
  const active = useRef(true);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ cause: unknown }>();
  const valid = desktopBrowserUrlSchema.safeParse(url).success;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  function close() {
    active.current = false;
    onClose();
  }

  async function open(destination: 'internal' | 'external') {
    if (!active.current || inFlight.current || !valid) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onOpenLink(url, destination);
      if (active.current) close();
    } catch (reason) {
      if (active.current) {
        setError({ cause: reason });
      }
    } finally {
      if (active.current) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent
        className="flex flex-col gap-4"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.isConnected) trigger.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('link.title')}</DialogTitle>
          <DialogDescription>{t('link.description')}</DialogDescription>
        </DialogHeader>
        <p className="max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere" dir="ltr">
          {url}
        </p>
        {!valid || error ? (
          <p className="text-sm text-destructive wrap-anywhere" role="alert">
            {valid
              ? t('link.openFailedHelp', {
                  message: translateError(error?.cause, t('link.openFailed')),
                })
              : t('link.invalid')}
          </p>
        ) : null}
        {pending ? <p role="status">{t('link.opening')}</p> : null}
        <DialogFooter className="flex flex-wrap gap-2">
          <Button disabled={pending || !valid} onClick={() => void open('internal')}>
            <Globe data-icon="inline-start" aria-hidden="true" />
            {t('link.internal')}
          </Button>
          <Button
            variant="outline"
            disabled={pending || !valid}
            onClick={() => void open('external')}
          >
            <ExternalLink data-icon="inline-start" aria-hidden="true" />
            {t('link.external')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

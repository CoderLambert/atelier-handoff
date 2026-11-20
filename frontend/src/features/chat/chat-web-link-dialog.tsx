/**
 * @file 提供会话网页链接的打开位置选择。
 * @implementation 复用 Dialog 展示目标地址，通过回调打开网页，隔离已关闭弹窗的异步结果并恢复原链接焦点。
 * @updated 2026-11-20T17:55:38+08:00
 */
import { useEffect, useRef, useState } from 'react';
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
  const active = useRef(true);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
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
        const message =
          reason instanceof Error && reason.message ? reason.message : '打开链接失败。';
        setError(`${message} 请重试，或选择另一种打开方式。`);
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
          <DialogTitle>打开网页链接</DialogTitle>
          <DialogDescription>选择打开位置</DialogDescription>
        </DialogHeader>
        <p className="max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere" dir="ltr">
          {url}
        </p>
        {!valid || error ? (
          <p className="text-sm text-destructive wrap-anywhere" role="alert">
            {valid ? error : '链接地址无效。请使用不含用户名或密码的 HTTP 或 HTTPS 网页地址。'}
          </p>
        ) : null}
        {pending ? <p role="status">正在打开链接…</p> : null}
        <DialogFooter className="flex flex-wrap gap-2">
          <Button disabled={pending || !valid} onClick={() => void open('internal')}>
            在内置浏览器打开
          </Button>
          <Button
            variant="outline"
            disabled={pending || !valid}
            onClick={() => void open('external')}
          >
            在外部浏览器打开
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

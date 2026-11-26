/**
 * @file 挂载可见终端并提供标题栏连接提醒。
 * @implementation 视口租约独立于终端连接。异常详情和重连入口放在弹层里，不改变视口尺寸。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useUiTranslation } from '@/i18n';
import type { TerminalClientSession } from './terminal-client';
import { terminalErrorMessage } from './terminal-errors';

export function TerminalConnectionStatus({ client }: { client: TerminalClientSession }) {
  const { t } = useUiTranslation('terminal');
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const trigger = useRef<HTMLButtonElement>(null);
  const reconnectable = ['disconnected', 'failed', 'replaced'].includes(state.phase);
  if (!reconnectable && !state.inputUnconfirmed) return null;
  const message = reconnectable
    ? state.errorCode && state.phase === 'failed'
      ? terminalErrorMessage(state.errorCode)
      : t(`connection.${state.phase}`)
    : undefined;
  return (
    <Popover>
      <span className="sr-only" role="status">
        {message ?? t('inputUnconfirmed')}
      </span>
      <PopoverTrigger asChild>
        <Button
          ref={trigger}
          size="icon-sm"
          variant="ghost"
          aria-label={t('connectionNotice')}
          title={t('connectionNotice')}
        >
          <TriangleAlert aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        aria-label={t('connectionNotice')}
        className="w-72 space-y-3 text-sm"
        onCloseAutoFocus={(event) => {
          if (!trigger.current?.isConnected) {
            event.preventDefault();
            client.focus();
          }
        }}
      >
        {message && <p>{message}</p>}
        {state.inputUnconfirmed && <p>{t('inputUnconfirmed')}</p>}
        <div className="flex flex-wrap gap-2">
          {reconnectable && (
            <Button size="xs" onClick={() => client.reconnect()}>
              {t('reconnect')}
            </Button>
          )}
          {state.inputUnconfirmed && (
            <Button size="xs" variant="ghost" onClick={() => client.acknowledgeInputWarning()}>
              {t('dismissNotice')}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function TerminalViewport({
  client,
  focusRequest,
}: {
  client: TerminalClientSession;
  focusRequest: number;
}) {
  const { t, locale } = useUiTranslation('terminal');
  const element = useRef<HTMLDivElement>(null);
  const lease = useRef<ReturnType<TerminalClientSession['attachView']> | undefined>(undefined);
  const requestedFocus = useRef(0);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    const current = client.attachView(target);
    lease.current = current;
    const observer = new ResizeObserver(current.fit);
    observer.observe(target);
    window.addEventListener('resize', current.fit);
    document.addEventListener('visibilitychange', current.fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', current.fit);
      document.removeEventListener('visibilitychange', current.fit);
      current.release();
      if (lease.current === current) lease.current = undefined;
    };
  }, [client]);
  useLayoutEffect(() => {
    if (focusRequest > 0 && requestedFocus.current !== focusRequest) {
      requestedFocus.current = focusRequest;
      lease.current?.focus();
    }
  }, [client, focusRequest]);
  useLayoutEffect(() => {
    element.current?.querySelector('textarea')?.setAttribute('aria-label', t('screen'));
  }, [state.phase, locale, t]);
  return (
    <div className="terminal-screen-area">
      <div
        ref={element}
        className="terminal-viewport"
        tabIndex={-1}
        role="region"
        aria-label={t('screen')}
        data-terminal-id={state.record.terminalId}
      />
    </div>
  );
}

/**
 * @file 将终端资源的 DOM 租用到当前可见区域。
 * @implementation ResizeObserver 仅请求可见尺寸，卸载释放视图租约而不销毁解析器或 WebSocket。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import type { TerminalClientSession } from './terminal-client';
import { terminalErrorMessage } from './terminal-errors';

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
  const reconnectable = ['disconnected', 'failed', 'replaced'].includes(state.phase);
  return (
    <div className="terminal-screen-area">
      <div className="terminal-connection" role="status">
        <span>
          {state.errorCode && state.phase === 'failed'
            ? terminalErrorMessage(state.errorCode)
            : t(`connection.${state.phase}`)}
        </span>
        {reconnectable && (
          <Button size="xs" variant="outline" onClick={() => client.reconnect()}>
            {t('reconnect')}
          </Button>
        )}
      </div>
      {state.inputUnconfirmed && (
        <p className="terminal-notice" role="status">
          {t('inputUnconfirmed')}
        </p>
      )}
      {state.restored && <p className="terminal-notice">{t('restoreNotice')}</p>}
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

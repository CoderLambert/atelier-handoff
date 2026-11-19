/**
 * @file 提供桌面浏览器控件与网页显示区域。
 * @implementation 订阅浏览器状态、发送操作并同步视图位置和可见性。
 * @updated 2026-11-20T02:00+08:00
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';

import type {
  DesktopBrowserAction as BrowserAction,
  DesktopBrowserBridge,
  DesktopBrowserState as DesktopState,
} from '@shared/desktop-browser';

declare global {
  interface Window {
    atelierDesktop?: DesktopBrowserBridge;
  }
}

export function useDesktopBrowser(projectId: string | undefined) {
  const [state, setState] = useState<DesktopState>();
  useEffect(() => {
    const bridge = window.atelierDesktop;
    if (!bridge || !projectId) return;
    const cleanup = bridge.subscribe((current) => {
      if (current.projectId === projectId) setState(current);
    });
    void bridge.command(projectId, 'state').catch(() => {});
    return cleanup;
  }, [projectId]);
  return state?.projectId === projectId ? state : undefined;
}

export function DesktopBrowser({ projectId, state }: { projectId: string; state?: DesktopState }) {
  const slot = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState<string>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const bridge = window.atelierDesktop!;

  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    let pendingFrame = 0;
    const send = () => {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        const { x, y, width, height } = element.getBoundingClientRect();
        const covered = [...document.querySelectorAll('[role="dialog"]')].some(
          (dialog) => !dialog.contains(element) && dialog.getBoundingClientRect().width > 0,
        );
        bridge.layout(
          projectId,
          width > 0 && height > 0 && !covered && !document.hidden ? { x, y, width, height } : null,
        );
      });
    };
    const observer = new ResizeObserver(send);
    observer.observe(element);
    const dialogs = new MutationObserver(send);
    dialogs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    window.addEventListener('resize', send);
    window.addEventListener('scroll', send, true);
    document.addEventListener('visibilitychange', send);
    send();
    return () => {
      cancelAnimationFrame(pendingFrame);
      observer.disconnect();
      dialogs.disconnect();
      window.removeEventListener('resize', send);
      window.removeEventListener('scroll', send, true);
      document.removeEventListener('visibilitychange', send);
      bridge.layout(projectId, null);
    };
  }, [bridge, projectId]);

  async function command(action: BrowserAction, url?: string) {
    setError('');
    setPending(true);
    try {
      await bridge.command(projectId, action, url);
      if (action === 'navigate') setAddress(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '浏览器操作失败。');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="desktop-browser" aria-label="桌面浏览器">
      <form
        className="desktop-browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const value = (address ?? state?.url ?? '').trim();
          if (value)
            void command('navigate', /^https?:\/\//i.test(value) ? value : `https://${value}`);
        }}
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="后退"
          disabled={!state?.control || pending}
          onClick={() => void command('back')}
        >
          <ArrowLeft size={16} />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="前进"
          disabled={!state?.control || pending}
          onClick={() => void command('forward')}
        >
          <ArrowRight size={16} />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="刷新网页"
          disabled={!state?.control || pending}
          onClick={() => void command('reload')}
        >
          <RotateCw size={15} />
        </Button>
        <input
          aria-label="网页地址"
          placeholder="输入网址后按 Enter"
          value={address ?? state?.url ?? ''}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant={state?.control ? 'default' : 'outline'}
          disabled={pending || state?.busy}
          onClick={() => void command(state?.control ? 'release' : 'take')}
        >
          {state?.control ? '交还控制' : '人工接管'}
        </Button>
      </form>
      {state?.control ? (
        <p className="desktop-browser-status" role="status">
          人工接管中。完成登录后，点击「交还控制」。
        </p>
      ) : null}
      {error ? (
        <p className="desktop-browser-status" role="alert">
          {error}
        </p>
      ) : null}
      <div className="desktop-browser-slot" ref={slot} aria-label={state?.title || '网页区域'} />
    </section>
  );
}

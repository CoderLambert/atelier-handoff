/**
 * @file 提供桌面浏览器控件与网页显示区域。
 * @implementation 订阅浏览器状态、发送操作并同步视图位置和可见性。
 * @updated 2026-11-20T02:00+08:00
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowLeft, ArrowRight, Bot, Globe, Plus, RotateCw, X } from 'lucide-react';

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
  const selectedTab = useRef<HTMLButtonElement>(null);
  const newTab = useRef<HTMLButtonElement>(null);
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState<BrowserAction | null>(null);
  const bridge = window.atelierDesktop!;
  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const agentTab = state?.tabs.find((tab) => tab.id === state.agentTabId);
  const differentAgentTab = agentTab && agentTab.id !== state?.activeTabId;
  const transferring = state?.transferring || pending === 'take' || pending === 'release';
  const disabled = !state || Boolean(pending) || transferring;
  const address = activeTab ? (addresses[activeTab.id] ?? state?.url ?? '') : '';

  useEffect(() => {
    selectedTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [state?.activeTabId]);

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

  async function command(action: BrowserAction, value?: string) {
    if (disabled) return;
    const tabId = activeTab?.id;
    setError('');
    setPending(action);
    try {
      await bridge.command(projectId, action, value);
      if ((action === 'navigate' && tabId) || (action === 'close-tab' && value)) {
        const draftId = action === 'close-tab' ? value : tabId;
        setAddresses((current) => {
          const next = { ...current };
          if (draftId) delete next[draftId];
          return next;
        });
      }
      if (action === 'close-tab') {
        requestAnimationFrame(() => (selectedTab.current ?? newTab.current)?.focus());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '浏览器操作失败。');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="desktop-browser" aria-label="桌面浏览器" aria-busy={Boolean(transferring)}>
      <div className="desktop-browser-tabbar">
        <div className="desktop-browser-tabs" role="group" aria-label="网页标签">
          {state?.tabs.map((tab) => {
            const active = tab.id === state.activeTabId;
            const label = tab.title || tab.url || '新标签页';
            const agent = tab.id === state.agentTabId;
            return (
              <div className="desktop-browser-tab" key={tab.id} data-active={active}>
                <Button
                  ref={active ? selectedTab : undefined}
                  type="button"
                  size="sm"
                  variant={active ? 'secondary' : 'ghost'}
                  className="desktop-browser-tab-select"
                  aria-label={agent ? `${label}，Agent 工作标签` : label}
                  aria-pressed={active}
                  title={[label, tab.url].filter(Boolean).join('\n')}
                  disabled={disabled}
                  onClick={() => {
                    if (!active) void command('select-tab', tab.id);
                  }}
                >
                  {agent ? (
                    <Bot size={16} data-icon="inline-start" />
                  ) : (
                    <Globe size={16} data-icon="inline-start" />
                  )}
                  <span className="truncate">{label}</span>
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`关闭标签：${label}`}
                  title={`关闭标签：${label}`}
                  disabled={disabled || state.busy}
                  onClick={() => void command('close-tab', tab.id)}
                >
                  <X size={16} data-icon="inline-start" />
                </Button>
              </div>
            );
          })}
        </div>
        <Button
          ref={newTab}
          type="button"
          size="sm"
          variant="ghost"
          className="desktop-browser-new-tab"
          aria-label="新建标签页"
          disabled={disabled}
          onClick={() => void command('new-tab')}
        >
          <Plus size={16} data-icon="inline-start" />
          新标签
        </Button>
      </div>
      <form
        className="desktop-browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const value = address.trim();
          if (!disabled && activeTab && value)
            void command('navigate', /^https?:\/\//i.test(value) ? value : `https://${value}`);
        }}
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="后退"
          disabled={!state?.control || disabled || !activeTab}
          onClick={() => void command('back')}
        >
          <ArrowLeft size={16} />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="前进"
          disabled={!state?.control || disabled || !activeTab}
          onClick={() => void command('forward')}
        >
          <ArrowRight size={16} />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="刷新网页"
          disabled={!state?.control || disabled || !activeTab}
          onClick={() => void command('reload')}
        >
          <RotateCw size={15} />
        </Button>
        <input
          aria-label="网页地址"
          placeholder="输入网址后按 Enter"
          value={address}
          disabled={disabled || !activeTab}
          onChange={(event) => {
            if (activeTab) {
              const value = event.target.value;
              setAddresses((current) => ({ ...current, [activeTab.id]: value }));
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant={state?.control ? 'default' : 'outline'}
          disabled={disabled || (state?.control && state.busy)}
          onClick={() => void command(state?.control ? 'release' : 'take')}
        >
          {transferring
            ? '交接中…'
            : state?.control
              ? differentAgentTab
                ? '交还当前标签'
                : '交还控制'
              : '人工接管'}
        </Button>
      </form>
      <div className="desktop-browser-status" role="status">
        {transferring ? (
          <p>正在交接浏览器控制权，请稍候…</p>
        ) : !state ? (
          <p>正在连接浏览器…</p>
        ) : state.tabs.length === 0 ? (
          <p>暂无网页标签。点击「新标签」打开网页。</p>
        ) : state.control ? (
          <p>
            人工接管中，Agent 已暂停网页操作。
            {differentAgentTab
              ? `原工作标签为「${agentTab.title || agentTab.url || '新标签页'}」。`
              : ''}
            交还后 Agent 将继续当前标签。
          </p>
        ) : differentAgentTab ? (
          <>
            <p>
              Agent 正在使用「{agentTab.title || agentTab.url || '新标签页'}」，当前显示其他标签。
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void command('select-tab', agentTab.id)}
            >
              查看 Agent 标签
            </Button>
          </>
        ) : (
          <p>
            {agentTab ? 'Agent 工作标签与当前标签相同。' : ''}
            需要操作网页时，点击「人工接管」。
          </p>
        )}
      </div>
      {error ? (
        <p className="desktop-browser-status" role="alert">
          {error}
        </p>
      ) : null}
      <div className="desktop-browser-slot" ref={slot} aria-label={state?.title || '网页区域'} />
    </section>
  );
}

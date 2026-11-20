/**
 * @file 提供桌面浏览器控件与网页显示区域。
 * @implementation 组合项目工具授权查询与人工控制，订阅宿主状态并同步网页视图位置和可见性。
 * @updated 2026-11-20T11:57:56+08:00
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useDesktopBrowserAccess } from '@/use-query/browser/use-desktop-browser-access';
import { useUpdateDesktopBrowserAccess } from '@/use-query/browser/use-update-desktop-browser-access';
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
  const access = useDesktopBrowserAccess(projectId);
  const updateAccess = useUpdateDesktopBrowserAccess();
  const accessDescriptionId = useId();
  const accessPending = updateAccess.isPending && updateAccess.variables?.projectId === projectId;
  const accessError = updateAccess.variables?.projectId === projectId ? updateAccess.error : null;
  const agentEnabled = access.data?.enabled === true;
  const agentAvailable = access.data?.available === true && !access.isError;
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
      <div className="desktop-browser-status">
        <p role="status">
          {access.isPending
            ? '正在读取 Agent 浏览器授权…'
            : access.isError
              ? '无法确认 Agent 浏览器授权状态。'
              : !agentAvailable
                ? `内置浏览器工具当前不可用。${agentEnabled ? '本项目授权仍为启用，可停用。' : ''}`
                : agentEnabled
                  ? '本项目已启用 Agent 浏览器，点击、输入需要逐次审批。'
                  : '本项目已停用 Agent 浏览器，Agent 无法读取或操作网页。'}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="允许 Agent 使用内置浏览器"
          aria-pressed={agentEnabled}
          aria-describedby={accessDescriptionId}
          disabled={
            !access.data || access.isError || accessPending || (!agentAvailable && !agentEnabled)
          }
          onClick={() => {
            if (!access.data || accessPending) return;
            updateAccess.mutate({
              projectId,
              enabled: !access.data.enabled,
              revision: access.data.revision,
            });
          }}
        >
          {accessPending ? '正在保存…' : agentEnabled ? '停用 Agent 浏览器' : '启用 Agent 浏览器'}
        </Button>
      </div>
      <div className="desktop-browser-status">
        <p id={accessDescriptionId}>
          启用后，具备浏览器能力的 Agent
          可以读取网页和截图。点击、输入需要逐次审批。网页内容可能发送给模型。 人工接管期间暂停
          Agent 的网页观察与操作；交还控制不会启用项目授权。
        </p>
      </div>
      {access.isError || accessError ? (
        <div className="desktop-browser-status" role="alert">
          <p>{(access.error || accessError)?.message}</p>
          {access.isError ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void access.refetch()}>
              重试浏览器授权状态
            </Button>
          ) : null}
        </div>
      ) : null}
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
            {access.isError || !access.data
              ? '交还仅结束人工接管；请先确认项目浏览器授权状态。'
              : !agentEnabled
                ? '交还仅结束人工接管；项目浏览器工具仍停用。'
                : !agentAvailable
                  ? '交还仅结束人工接管；内置浏览器工具当前不可用。'
                  : '交还后，Agent 可以读取当前标签和截图，点击、输入仍需逐次审批。'}
          </p>
        ) : differentAgentTab ? (
          <>
            <p>
              Agent 工作标签为「{agentTab.title || agentTab.url || '新标签页'}」，当前显示其他标签。
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

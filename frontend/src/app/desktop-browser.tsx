/**
 * @file 提供桌面浏览器控件与网页显示区域。
 * @implementation 组合项目工具授权查询与人工控制，订阅宿主状态并同步网页视图位置和可见性。
 * @updated 2026-11-20T11:57:56+08:00
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useDesktopBrowserAccess } from '@/use-query/browser/use-desktop-browser-access';
import { useUpdateDesktopBrowserAccess } from '@/use-query/browser/use-update-desktop-browser-access';
import { ArrowLeft, ArrowRight, Bot, Globe, Plus, RotateCw, Settings, X } from 'lucide-react';

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
  const statusError = error || (access.error || accessError)?.message;
  const status = statusError
    ? statusError
    : transferring
      ? '正在交接控制权…'
      : !state
        ? '正在连接浏览器…'
        : state.control
          ? 'Agent 已暂停'
          : access.isPending
            ? '正在读取授权…'
            : !agentAvailable
              ? '浏览器工具不可用'
              : !agentEnabled
                ? 'Agent 浏览器已停用'
                : state.tabs.length === 0
                  ? '点击 + 新建标签'
                  : differentAgentTab
                    ? 'Agent 在其他标签'
                    : state.busy
                      ? 'Agent 正在操作'
                      : agentTab
                        ? 'Agent 工作标签'
                        : '等待 Agent';
  const showAgentTarget = differentAgentTab && !state?.control && !transferring && !statusError;

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
                  className="desktop-browser-icon"
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
          size="icon-sm"
          variant="ghost"
          className="desktop-browser-icon"
          aria-label="新建标签页"
          title="新建标签页"
          disabled={disabled}
          onClick={() => void command('new-tab')}
        >
          <Plus size={16} data-icon="inline-start" />
        </Button>
        <div
          className="desktop-browser-status"
          role={statusError ? 'alert' : 'status'}
          title={status}
        >
          {showAgentTarget ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="查看 Agent 标签"
              title={`Agent 工作标签：${agentTab.title || agentTab.url || '新标签页'}`}
              disabled={disabled}
              onClick={() => void command('select-tab', agentTab.id)}
            >
              <span className="truncate">{status}</span>
            </Button>
          ) : (
            <span className="truncate">{status}</span>
          )}
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="desktop-browser-icon"
              aria-label="浏览器设置"
              title="浏览器设置"
            >
              <Settings size={16} data-icon="inline-start" />
            </Button>
          </DialogTrigger>
          <DialogContent className="desktop-browser-settings">
            <DialogHeader>
              <DialogTitle>浏览器设置</DialogTitle>
              <DialogDescription>管理当前项目的 Agent 浏览器授权。</DialogDescription>
            </DialogHeader>
            <section className="desktop-browser-settings-section" aria-label="项目浏览器授权">
              <h3>项目授权</h3>
              <p role="status">
                {access.isPending
                  ? '正在读取 Agent 浏览器授权…'
                  : access.isError
                    ? '无法确认 Agent 浏览器授权状态。'
                    : !agentAvailable
                      ? `内置浏览器工具当前不可用。${agentEnabled ? '本项目授权仍为启用，可停用。' : ''}`
                      : agentEnabled
                        ? '本项目已启用 Agent 浏览器。'
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
                  !access.data ||
                  access.isError ||
                  accessPending ||
                  (!agentAvailable && !agentEnabled)
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
                {accessPending
                  ? '正在保存…'
                  : agentEnabled
                    ? '停用 Agent 浏览器'
                    : '启用 Agent 浏览器'}
              </Button>
              {access.isError || accessError ? (
                <div className="desktop-browser-settings-error" role="alert">
                  <p>{(access.error || accessError)?.message}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={access.isFetching || accessPending}
                    onClick={() => {
                      updateAccess.reset();
                      void access.refetch();
                    }}
                  >
                    重试浏览器授权状态
                  </Button>
                </div>
              ) : null}
            </section>
            <section
              className="desktop-browser-settings-section"
              id={accessDescriptionId}
              aria-label="浏览器使用说明"
            >
              <h3>使用说明</h3>
              <p>
                启用后，具备浏览器能力的 Agent
                可以读取网页和截图。点击、输入需要逐次审批，网页内容可能发送给模型。
              </p>
              <p>
                人工接管期间暂停 Agent 的网页观察与操作。交还控制后，Agent
                从当前标签重新观察；交还控制不会启用项目授权。
              </p>
              <p>标签上的机器人图标标记 Agent 的工作标签，可与当前查看的标签不同。</p>
            </section>
          </DialogContent>
        </Dialog>
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
          className="desktop-browser-icon"
          aria-label="后退"
          disabled={!state?.control || disabled || !activeTab}
          onClick={() => void command('back')}
        >
          <ArrowLeft size={16} data-icon="inline-start" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="desktop-browser-icon"
          aria-label="前进"
          disabled={!state?.control || disabled || !activeTab}
          onClick={() => void command('forward')}
        >
          <ArrowRight size={16} data-icon="inline-start" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="desktop-browser-icon"
          aria-label="刷新网页"
          disabled={!state?.control || disabled || !activeTab}
          onClick={() => void command('reload')}
        >
          <RotateCw size={15} data-icon="inline-start" />
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
          className="desktop-browser-control"
          aria-label={
            state?.control ? (differentAgentTab ? '交还当前标签' : '交还控制') : '人工接管'
          }
          title={
            state?.control
              ? '交还控制后，Agent 将从当前标签重新观察'
              : '人工接管并暂停 Agent 网页操作'
          }
          disabled={disabled || (state?.control && state.busy)}
          onClick={() => void command(state?.control ? 'release' : 'take')}
        >
          {transferring ? '交接中…' : state?.control ? '交还' : '人工接管'}
        </Button>
      </form>
      <div className="desktop-browser-slot" ref={slot} aria-label={state?.title || '网页区域'} />
    </section>
  );
}

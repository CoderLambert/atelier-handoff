/**
 * @file 提供桌面浏览器控件与网页显示区域。
 * @implementation 以两行组织标签、下载、布局与导航操作；结合项目授权和人工控制同步原生网页视图，并将槽位观测与状态推导拆出到独立模块。
 * @updated 2026-11-27T22:00:00+08:00
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { translateError, useUiTranslation } from '@/i18n';
import { useDesktopBrowserAccess } from '@/use-query/browser/use-desktop-browser-access';
import { useUpdateDesktopBrowserAccess } from '@/use-query/browser/use-update-desktop-browser-access';
import { ArrowLeft, ArrowRight, Bot, Globe, Home, Plus, RotateCw, Settings, X } from 'lucide-react';
import { BrowserDownloads } from './browser-downloads';
import { deriveDesktopBrowserStatus } from './desktop-browser-status';
import { useNativeBrowserSlot } from './use-native-browser-slot';
import {
  desktopBrowserDefaultUrl,
  resolveDesktopBrowserInput,
  type DesktopBrowserAction as BrowserAction,
  type DesktopBrowserState as DesktopState,
} from '@shared/desktop-browser';
import { Input } from '@/components/ui/input';

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

export function DesktopBrowser({
  projectId,
  state,
  panelActions,
}: {
  projectId: string;
  state?: DesktopState;
  panelActions: ReactNode;
}) {
  const { t } = useUiTranslation('browser');
  const slot = useRef<HTMLDivElement>(null);
  const selectedTab = useRef<HTMLButtonElement>(null);
  const newTab = useRef<HTMLButtonElement>(null);
  const shouldFocusTabAfterClose = useRef(false);
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [pending, setPending] = useState<BrowserAction | null>(null);
  const bridge = window.atelierDesktop;
  const access = useDesktopBrowserAccess(projectId);
  const updateAccess = useUpdateDesktopBrowserAccess();
  const accessDescriptionId = useId();
  const accessPending = updateAccess.isPending && updateAccess.variables?.projectId === projectId;
  const accessError = updateAccess.variables?.projectId === projectId ? updateAccess.error : null;
  const agentEnabled = access.data?.enabled === true;
  const agentAvailable = access.data?.available === true && !access.isError;
  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const agentTab = state?.tabs.find((tab) => tab.id === state.agentTabId);
  const differentAgentTab = Boolean(agentTab && agentTab.id !== state?.activeTabId);
  const transferring = Boolean(state?.transferring) || pending === 'take' || pending === 'release';
  const disabled = !state || Boolean(pending) || transferring;
  const address = activeTab ? (addresses[activeTab.id] ?? state?.url ?? '') : '';
  const accessFailure = access.error || accessError;
  const statusError = error
    ? translateError(error.cause, t('errors.operationFailed'))
    : accessFailure
      ? translateError(accessFailure, t('errors.accessFailed'))
      : '';
  const derivedStatus = deriveDesktopBrowserStatus({
    state,
    hasError: Boolean(statusError),
    transferring,
    accessPending: access.isPending,
    agentAvailable,
    agentEnabled,
    hasAgentTab: Boolean(agentTab),
    differentAgentTab,
  });
  const status = derivedStatus.key ? t(derivedStatus.key) : statusError;
  const statusTone = derivedStatus.tone;
  const showAgentTarget = derivedStatus.showAgentTarget && Boolean(agentTab);

  useEffect(() => {
    selectedTab.current
      ?.closest('.desktop-browser-tab')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (shouldFocusTabAfterClose.current) {
      shouldFocusTabAfterClose.current = false;
      requestAnimationFrame(() => (selectedTab.current ?? newTab.current)?.focus());
    }
  }, [state?.activeTabId, state?.tabs]);

  useNativeBrowserSlot(slot, projectId, bridge);

  async function command(action: BrowserAction, value?: string) {
    if (!bridge || disabled) return;
    const tabId = activeTab?.id;
    setError(null);
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
        shouldFocusTabAfterClose.current = true;
        requestAnimationFrame(() => (selectedTab.current ?? newTab.current)?.focus());
      }
    } catch (cause) {
      setError({ cause });
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      className="desktop-browser"
      aria-label={t('desktop.label')}
      aria-busy={Boolean(transferring)}
    >
      <div className="desktop-browser-tabbar">
        <div className="desktop-browser-tabs" role="group" aria-label={t('tabs.label')}>
          {state?.tabs.map((tab) => {
            const active = tab.id === state.activeTabId;
            const label = tab.title || tab.url || t('tabs.untitled');
            const agent = tab.id === state.agentTabId;
            return (
              <div className="desktop-browser-tab" key={tab.id} data-active={active}>
                <Button
                  ref={active ? selectedTab : undefined}
                  type="button"
                  size="xs"
                  variant={active ? 'secondary' : 'ghost'}
                  className="desktop-browser-tab-select"
                  aria-label={agent ? t('tabs.agentLabel', { label }) : label}
                  aria-pressed={active}
                  title={[label, tab.url].filter(Boolean).join('\n')}
                  disabled={disabled}
                  onClick={() => {
                    if (!active) void command('select-tab', tab.id);
                  }}
                >
                  {agent ? (
                    <Bot data-icon="inline-start" aria-hidden="true" />
                  ) : (
                    <Globe data-icon="inline-start" aria-hidden="true" />
                  )}
                  <span className="desktop-browser-tab-title">{label}</span>
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="desktop-browser-icon"
                  aria-label={t('tabs.close', { label })}
                  title={t('tabs.close', { label })}
                  disabled={disabled || state.busy}
                  onClick={() => void command('close-tab', tab.id)}
                >
                  <X data-icon="inline-start" aria-hidden="true" />
                </Button>
              </div>
            );
          })}
        </div>
        <Button
          ref={newTab}
          type="button"
          size="icon-xs"
          variant="ghost"
          className="desktop-browser-icon"
          aria-label={t('tabs.new')}
          title={t('tabs.new')}
          disabled={disabled}
          onClick={() => void command('new-tab')}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
        </Button>
        {bridge ? (
          <BrowserDownloads key={projectId} projectId={projectId} state={state} bridge={bridge} />
        ) : null}
        <Dialog>
          <DialogTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="desktop-browser-icon"
              aria-label={t('settings.title')}
              title={t('settings.title')}
            >
              <Settings data-icon="inline-start" aria-hidden="true" />
            </Button>
          </DialogTrigger>
          <DialogContent className="desktop-browser-settings">
            <DialogHeader>
              <DialogTitle>{t('settings.title')}</DialogTitle>
              <DialogDescription>{t('settings.description')}</DialogDescription>
            </DialogHeader>
            <section
              className="desktop-browser-settings-section"
              aria-label={t('settings.accessLabel')}
            >
              <h3>{t('settings.accessTitle')}</h3>
              <p role="status">
                {access.isPending
                  ? t('settings.readingAccess')
                  : access.isError
                    ? t('settings.accessUnknown')
                    : !agentAvailable
                      ? t(agentEnabled ? 'settings.unavailableEnabled' : 'settings.unavailable')
                      : agentEnabled
                        ? t('settings.enabled')
                        : t('settings.disabled')}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t('settings.allowAgent')}
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
                  ? t('settings.saving')
                  : agentEnabled
                    ? t('settings.disable')
                    : t('settings.enable')}
              </Button>
              {access.isError || accessError ? (
                <div className="desktop-browser-settings-error" role="alert">
                  <p>{translateError(accessFailure, t('errors.accessFailed'))}</p>
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
                    {t('settings.retryAccess')}
                  </Button>
                </div>
              ) : null}
            </section>
            <section
              className="desktop-browser-settings-section"
              id={accessDescriptionId}
              aria-label={t('settings.helpLabel')}
            >
              <h3>{t('settings.helpTitle')}</h3>
              <p>{t('settings.accessHelp')}</p>
              <p>{t('settings.controlHelp')}</p>
              <p>{t('settings.tabHelp')}</p>
            </section>
          </DialogContent>
        </Dialog>
        <span className="desktop-browser-divider" aria-hidden="true" />
        {panelActions}
      </div>
      <form
        className="desktop-browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const destination = resolveDesktopBrowserInput(address);
          if (!disabled && activeTab && destination) void command('navigate', destination);
        }}
      >
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="desktop-browser-icon"
          aria-label={t('navigation.back')}
          disabled={!state?.control || disabled || !activeTab}
          onClick={() => void command('back')}
        >
          <ArrowLeft data-icon="inline-start" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="desktop-browser-icon"
          aria-label={t('navigation.forward')}
          disabled={!state?.control || disabled || !activeTab}
          onClick={() => void command('forward')}
        >
          <ArrowRight data-icon="inline-start" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="desktop-browser-icon"
          aria-label={t('navigation.reload')}
          disabled={!state?.control || disabled || !activeTab}
          onClick={() => void command('reload')}
        >
          <RotateCw data-icon="inline-start" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="desktop-browser-icon"
          aria-label={t('navigation.home')}
          title={t('navigation.home')}
          disabled={disabled || !activeTab}
          onClick={() => void command('navigate', desktopBrowserDefaultUrl)}
        >
          <Home data-icon="inline-start" aria-hidden="true" />
        </Button>
        <Input
          aria-label={t('navigation.address')}
          title={address || undefined}
          placeholder={t('navigation.placeholder')}
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
          size="xs"
          variant={state?.control ? 'default' : 'outline'}
          className="desktop-browser-control"
          aria-label={
            state?.control
              ? t(differentAgentTab ? 'control.releaseTab' : 'control.release')
              : t('control.take')
          }
          title={t(state?.control ? 'control.releaseHint' : 'control.takeHint')}
          disabled={disabled || (state?.control && state.busy)}
          onClick={() => void command(state?.control ? 'release' : 'take')}
        >
          {transferring
            ? t('control.transferring')
            : state?.control
              ? t('control.return')
              : t('control.take')}
        </Button>
      </form>
      <div
        className="desktop-browser-status"
        data-tone={statusTone}
        role={statusError ? 'alert' : 'status'}
        title={status}
      >
        {statusTone === 'busy' ? (
          <span className="desktop-browser-status-dot" aria-hidden="true" />
        ) : null}
        {showAgentTarget && agentTab ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={t('tabs.showAgent')}
            title={t('tabs.agentTitle', {
              label: agentTab.title || agentTab.url || t('tabs.untitled'),
            })}
            disabled={disabled}
            onClick={() => void command('select-tab', agentTab.id)}
          >
            <Bot data-icon="inline-start" aria-hidden="true" />
            <span className="truncate">{status}</span>
          </Button>
        ) : (
          <span className="truncate">{status}</span>
        )}
      </div>
      <div
        className="desktop-browser-slot"
        ref={slot}
        aria-label={state?.title || t('desktop.pageArea')}
      />
    </section>
  );
}

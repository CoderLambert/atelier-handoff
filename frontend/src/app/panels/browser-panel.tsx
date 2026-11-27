/**
 * @file 将既有原生或 Web 浏览器视图接入面板。
 * @implementation 将桌面浏览器订阅与 Web 预览轮询隔离在浏览器面板边界内，避免高频状态变化波及工作区外壳；收起时保留既有槽位清理与预览停询约定。
 * @updated 2026-11-27T19:25:00+08:00
 */
import type { ReactNode } from 'react';
import { Globe } from 'lucide-react';
import { BrowserPreview } from '../browser-preview';
import { PanelLayoutButtons } from '@/components/panel-layout-buttons';
import { useUiTranslation } from '@/i18n';
import type { PanelInstance, PanelViewProps, ProjectPanelTarget } from '@/panel-sdk';
import { useBrowserPreview } from '@/use-query/browser/use-browser-preview';
import { DesktopBrowser, useDesktopBrowser } from '../desktop-browser';

export interface BrowserPanelProps extends PanelViewProps<
  PanelInstance<'atelier.browser', ProjectPanelTarget>
> {
  desktop: boolean;
  collapsed: boolean;
}

function DesktopBrowserPanel({
  projectId,
  panelActions,
}: {
  projectId: string;
  panelActions: ReactNode;
}) {
  const { t } = useUiTranslation('workbench');
  const state = useDesktopBrowser(projectId);
  return (
    <>
      <h2 className="sr-only">{t('browser.title')}</h2>
      <DesktopBrowser projectId={projectId} state={state} panelActions={panelActions} />
    </>
  );
}

function WebBrowserPreviewPanel({
  projectId,
  collapsed,
  panelActions,
}: {
  projectId: string;
  collapsed: boolean;
  panelActions: ReactNode;
}) {
  const { t } = useUiTranslation('workbench');
  const browser = useBrowserPreview(collapsed ? undefined : projectId, true);
  return (
    <>
      <header className="workspace-browser-heading">
        <h2>
          <Globe aria-hidden="true" />
          {t('browser.title')}
        </h2>
        {panelActions}
      </header>
      <BrowserPreview frame={browser.data?.frame} error={browser.isError} />
    </>
  );
}

export default function BrowserPanel({
  instance,
  desktop,
  collapsed,
  ...layout
}: BrowserPanelProps) {
  const { t } = useUiTranslation('workbench');
  const actions = (
    <PanelLayoutButtons
      layout={layout}
      expandLabel={t('browser.expand')}
      dockLabel={t('browser.dock')}
      collapseLabel={t('browser.collapse')}
    />
  );
  return (
    <section
      className="workspace-browser-panel"
      data-expanded={layout.expanded || undefined}
      role={layout.expanded ? 'dialog' : 'region'}
      aria-modal={layout.expanded || undefined}
      aria-label={t('browser.panel')}
    >
      {desktop ? (
        <DesktopBrowserPanel
          key={instance.target.projectId}
          projectId={instance.target.projectId}
          panelActions={actions}
        />
      ) : (
        <WebBrowserPreviewPanel
          key={instance.target.projectId}
          projectId={instance.target.projectId}
          collapsed={collapsed}
          panelActions={actions}
        />
      )}
    </section>
  );
}

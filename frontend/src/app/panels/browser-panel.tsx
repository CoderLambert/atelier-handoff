/**
 * @file 将既有原生或 Web 浏览器视图接入面板。
 * @implementation 为原生浏览器与 Web 预览接入共享布局操作；收起时清理槽位并发送 layout(null)，网页实例仍由桌面宿主持有。
 * @updated 2026-11-27T02:41:56+08:00
 */
import { Globe } from 'lucide-react';
import type { ComponentProps } from 'react';
import { BrowserPreview } from '../browser-preview';
import { PanelLayoutButtons } from '@/components/panel-layout-buttons';
import { useUiTranslation } from '@/i18n';
import type { PanelInstance, PanelViewProps, ProjectPanelTarget } from '@/panel-sdk';
import { DesktopBrowser } from '../desktop-browser';
export interface BrowserPanelProps extends PanelViewProps<
  PanelInstance<'atelier.browser', ProjectPanelTarget>
> {
  desktop: boolean;
  state: ComponentProps<typeof DesktopBrowser>['state'];
  preview: ComponentProps<typeof BrowserPreview>;
}
export default function BrowserPanel({
  instance,
  desktop,
  state,
  preview,
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
        <>
          <h2 className="sr-only">{t('browser.title')}</h2>
          <DesktopBrowser
            key={instance.target.projectId}
            projectId={instance.target.projectId}
            state={state}
            panelActions={actions}
          />
        </>
      ) : (
        <>
          <header className="workspace-browser-heading">
            <h2>
              <Globe aria-hidden="true" />
              {t('browser.title')}
            </h2>
            {actions}
          </header>
          <BrowserPreview {...preview} />
        </>
      )}
    </section>
  );
}

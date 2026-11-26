/**
 * @file 将既有原生或 Web 浏览器视图接入面板。
 * @implementation 原生组件卸载沿现有契约发送 layout(null)，网页实例继续由桌面宿主持有。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { Globe, X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { BrowserPreview } from '../browser-preview';
import { Button } from '@/components/ui/button';
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
  onRequestHide,
}: BrowserPanelProps) {
  const { t } = useUiTranslation('workbench');
  return (
    <section className="workspace-browser-panel" aria-label={t('browser.panel')}>
      {desktop ? (
        <>
          <h2 className="sr-only">{t('browser.title')}</h2>
          <DesktopBrowser
            key={instance.target.projectId}
            projectId={instance.target.projectId}
            state={state}
            onClose={onRequestHide}
            closeLabel={t('browser.close')}
          />
        </>
      ) : (
        <>
          <header className="workspace-browser-heading">
            <h2>
              <Globe aria-hidden="true" />
              {t('browser.title')}
            </h2>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('browser.close')}
              onClick={onRequestHide}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          <BrowserPreview {...preview} />
        </>
      )}
    </section>
  );
}

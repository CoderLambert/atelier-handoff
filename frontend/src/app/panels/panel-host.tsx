/**
 * @file 提供功能面板的加载与渲染错误边界。
 * @implementation 按实例隔离渲染失败和重试，异步业务错误由 feature 展示，隐藏不推断资源应被销毁。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import type { PanelDefinition, PanelViewProps } from '@/panel-sdk';

class PanelErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function PanelHost<Props extends PanelViewProps>({
  definition,
  view,
}: {
  definition: PanelDefinition<Props>;
  view: Props;
}) {
  const { t } = useUiTranslation('terminal');
  const [attempt, retry] = useState(0);
  const View = useMemo(() => lazy(definition.load), [definition, attempt]);
  const fallback = (
    <div className={view.expanded ? 'fixed inset-0 z-40 bg-card p-4' : 'px-4 py-3'} role="alert">
      <p>{t('panelFailed')}</p>
      <Button size="sm" variant="outline" onClick={() => retry((value) => value + 1)}>
        {t('retry')}
      </Button>
      <Button size="sm" variant="ghost" onClick={view.onRequestHide}>
        {t('panelClose')}
      </Button>
    </div>
  );
  if (!view.visible) return null;
  return (
    <PanelErrorBoundary key={`${view.instance.instanceId}:${attempt}`} fallback={fallback}>
      <Suspense
        fallback={
          <p
            className={
              view.expanded ? 'fixed inset-0 z-40 bg-card px-5 py-4' : 'empty-text px-5 py-4'
            }
            role="status"
          >
            {t('panelLoading')}
          </p>
        }
      >
        <View {...view} />
      </Suspense>
    </PanelErrorBoundary>
  );
}

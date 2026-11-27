/**
 * @file 提供右侧工具共用的布局按钮。
 * @implementation 以同样的顺序、图标和尺寸呈现全屏、还原和收起，业务按钮由工具自己提供。
 * @updated 2026-11-27T12:00:00+08:00
 */
import { Maximize2, Minimize2, PanelRightClose } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PanelLayoutActions } from '@/panel-sdk';

export function PanelLayoutButtons({
  layout,
  expandLabel,
  dockLabel,
  collapseLabel,
  collapseDisabled,
}: {
  layout: PanelLayoutActions;
  expandLabel: string;
  dockLabel: string;
  collapseLabel: string;
  collapseDisabled?: boolean;
}) {
  const toggleLabel = layout.expanded ? dockLabel : expandLabel;
  return (
    <span className="workspace-tool-actions">
      {layout.expandable && (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={layout.onRequestExpand}
        >
          {layout.expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </Button>
      )}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={collapseLabel}
        title={collapseLabel}
        disabled={collapseDisabled}
        onClick={layout.onRequestHide}
      >
        <PanelRightClose aria-hidden="true" />
      </Button>
    </span>
  );
}

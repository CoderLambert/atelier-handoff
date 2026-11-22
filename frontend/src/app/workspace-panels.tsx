/**
 * @file 管理工作区三栏布局和窄窗口切换。
 * @implementation 保留桌面像素偏好，通过分隔条事件通知原生网页槽位重算坐标。
 * @updated 2026-11-22T00:00:00+08:00
 */
import { useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { useUiTranslation } from '@/i18n';
import {
  collapsedNavigationWidth,
  maxInspectorWidth,
  maxNavigationWidth,
  minInspectorWidth,
  minNavigationWidth,
  type WorkspaceLayout,
} from '@shared/workspace-layout';

export const workspaceLayoutEvent = 'atelier-workspace-layout';
const centerMinimum = 420;
const separatorWidth = 8;
function subscribeToViewport(notify: () => void) {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
}
const viewport = () => window.innerWidth;
export function useWorkspaceViewport() {
  return useSyncExternalStore(subscribeToViewport, viewport, () => 1280);
}

interface WorkspacePanelsProps {
  layout: WorkspaceLayout;
  width: number;
  showLeft: boolean;
  showRight: boolean;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  onChange: (layout: WorkspaceLayout) => void;
}

export function WorkspacePanels({
  layout,
  width,
  showLeft,
  showRight,
  left,
  center,
  right,
  onChange,
}: WorkspacePanelsProps) {
  const { t } = useUiTranslation('navigation');
  const group = useGroupRef();
  const notifySlot = () => {
    window.dispatchEvent(new Event(workspaceLayoutEvent));
  };

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const handle = group.current;
      const current = handle?.getLayout();
      if (
        !handle ||
        !current ||
        !('conversation' in current) ||
        showLeft !== 'navigation' in current ||
        showRight !== 'inspector' in current
      )
        return;
      const usable = width - (Number(showLeft) + Number(showRight)) * separatorWidth;
      const savedLeft = layout.collapsed ? collapsedNavigationWidth : layout.recent.left;
      const rightMinimum = showRight ? minInspectorWidth : 0;
      const leftPixels = showLeft ? Math.min(savedLeft, usable - centerMinimum - rightMinimum) : 0;
      const rightPixels = showRight
        ? Math.min(layout.recent.right, usable - centerMinimum - leftPixels)
        : 0;
      const percent = (pixels: number) => (100 * pixels) / usable;
      handle.setLayout({
        ...(showLeft ? { navigation: percent(leftPixels) } : {}),
        conversation: percent(usable - leftPixels - rightPixels),
        ...(showRight ? { inspector: percent(rightPixels) } : {}),
      });
      notifySlot();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    group,
    layout.collapsed,
    layout.recent.left,
    layout.recent.right,
    showLeft,
    showRight,
    width,
  ]);

  return (
    <Group
      groupRef={group}
      className="workspace-resizable"
      orientation="horizontal"
      onLayoutChange={notifySlot}
      onLayoutChanged={(sizes, meta) => {
        if (!meta.isUserInteraction) return;
        const usable = width - (Number(showLeft) + Number(showRight)) * separatorWidth;
        const pixels = (percent: number | undefined) =>
          percent === undefined ? undefined : (percent * usable) / 100;
        const leftPixels = pixels(sizes.navigation);
        const collapsed =
          leftPixels === undefined
            ? layout.collapsed
            : Math.round(leftPixels) === collapsedNavigationWidth;
        const leftSize = collapsed ? undefined : leftPixels;
        const rightSize = pixels(sizes.inspector);
        const recent = {
          left:
            leftSize === undefined
              ? layout.recent.left
              : Math.max(minNavigationWidth, Math.min(maxNavigationWidth, Math.round(leftSize))),
          right:
            rightSize === undefined
              ? layout.recent.right
              : Math.max(minInspectorWidth, Math.min(maxInspectorWidth, Math.round(rightSize))),
        };
        if (
          collapsed !== layout.collapsed ||
          recent.left !== layout.recent.left ||
          recent.right !== layout.recent.right
        )
          onChange({ ...layout, recent, collapsed });
      }}
    >
      {showLeft && (
        <Panel
          id="navigation"
          className="workspace-pane"
          collapsible
          collapsedSize={collapsedNavigationWidth}
          defaultSize={layout.collapsed ? collapsedNavigationWidth : layout.recent.left}
          minSize={minNavigationWidth}
          maxSize={maxNavigationWidth}
          groupResizeBehavior="preserve-pixel-size"
        >
          {left}
        </Panel>
      )}
      {showLeft && (
        <Separator
          id="resize-navigation"
          className="workspace-separator"
          aria-label={t('panels.resizeNavigation')}
        />
      )}
      <Panel id="conversation" className="workspace-pane" minSize={width < 768 ? 0 : centerMinimum}>
        {center}
      </Panel>
      {showRight && (
        <Separator
          id="resize-inspector"
          className="workspace-separator"
          aria-label={t('panels.resizeBrowser')}
        />
      )}
      {showRight && (
        <Panel
          id="inspector"
          className="workspace-pane"
          defaultSize={layout.recent.right}
          minSize={minInspectorWidth}
          maxSize={maxInspectorWidth}
          groupResizeBehavior="preserve-pixel-size"
        >
          {right}
        </Panel>
      )}
    </Group>
  );
}

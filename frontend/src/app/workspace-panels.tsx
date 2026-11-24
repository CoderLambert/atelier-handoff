/**
 * @file 管理工作区分栏和右侧面板尺寸。
 * @implementation 限制 Git 分隔条的拖动范围，保留导航和浏览器宽度偏好；全窗口时停用背景交互，并通知原生网页更新坐标。
 * @updated 2026-11-24T04:13:00+08:00
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
  focusRight?: boolean;
  rightPane?: {
    width: number;
    minWidth: number;
    maxWidth: number;
    resizeLabel: string;
    onResize: (width: number) => void;
  };
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
  focusRight = false,
  rightPane,
  onChange,
}: WorkspacePanelsProps) {
  const { t } = useUiTranslation('navigation');
  const group = useGroupRef();
  const usable = width - (Number(showLeft) + Number(showRight)) * separatorWidth;
  const centerMin = width < 768 ? 0 : centerMinimum;
  const rightMin = focusRight ? 0 : (rightPane?.minWidth ?? minInspectorWidth);
  const savedLeft = layout.collapsed ? collapsedNavigationWidth : layout.recent.left;
  const leftWidth = showLeft
    ? Math.min(savedLeft, usable - centerMin - (showRight ? rightMin : 0))
    : 0;
  const rightSpace = usable - centerMin - leftWidth;
  // At its limit the right divider can otherwise resize the navigation through the center.
  const rightMax = rightPane ? Math.min(rightPane.maxWidth, rightSpace) : maxInspectorWidth;
  const rightWidth = focusRight ? 0 : (rightPane?.width ?? layout.recent.right);
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
      const rightPixels = showRight ? Math.min(rightWidth, rightSpace) : 0;
      const percent = (pixels: number) => (100 * pixels) / usable;
      handle.setLayout({
        ...(showLeft ? { navigation: percent(leftWidth) } : {}),
        conversation: percent(usable - leftWidth - rightPixels),
        ...(showRight ? { inspector: percent(rightPixels) } : {}),
      });
      notifySlot();
    });
    return () => cancelAnimationFrame(frame);
  }, [group, showLeft, showRight, usable, leftWidth, rightWidth, rightSpace]);

  return (
    <Group
      groupRef={group}
      className="workspace-resizable"
      orientation="horizontal"
      disabled={focusRight}
      onLayoutChange={notifySlot}
      onLayoutChanged={(sizes, meta) => {
        if (!meta.isUserInteraction) return;
        const pixels = (percent: number | undefined) =>
          percent === undefined ? undefined : (percent * usable) / 100;
        const navigation = pixels(sizes.navigation);
        const leftPixels =
          rightPane && navigation !== undefined && Math.abs(navigation - leftWidth) < 1
            ? undefined
            : navigation;
        const collapsed =
          leftPixels === undefined
            ? layout.collapsed
            : Math.round(leftPixels) === collapsedNavigationWidth;
        const leftSize = collapsed ? undefined : leftPixels;
        const rightSize = pixels(sizes.inspector);
        if (rightPane && rightSize !== undefined) rightPane.onResize(Math.round(rightSize));
        const recent = {
          left:
            leftSize === undefined
              ? layout.recent.left
              : Math.max(minNavigationWidth, Math.min(maxNavigationWidth, Math.round(leftSize))),
          right:
            rightPane || rightSize === undefined
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
          inert={focusRight}
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
          inert={focusRight}
          className="workspace-separator"
          aria-label={t('panels.resizeNavigation')}
        />
      )}
      <Panel id="conversation" className="workspace-pane" minSize={centerMin} inert={focusRight}>
        {center}
      </Panel>
      {showRight && (
        <Separator
          id="resize-inspector"
          inert={focusRight}
          className="workspace-separator"
          aria-label={rightPane?.resizeLabel ?? t('panels.resizeBrowser')}
        />
      )}
      {showRight && (
        <Panel
          id="inspector"
          className="workspace-pane"
          defaultSize={rightWidth}
          minSize={rightMin}
          maxSize={rightMax}
          groupResizeBehavior="preserve-pixel-size"
        >
          {right}
        </Panel>
      )}
    </Group>
  );
}

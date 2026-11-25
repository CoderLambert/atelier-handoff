/**
 * @file 将现有 Git 工作区接入功能面板合同。
 * @implementation 保留文件标签、代码引用与工作树选择，宿主只协调显隐、尺寸和关闭保护。
 * @updated 2026-11-26T01:00:00+08:00
 */
import type { ComponentProps } from 'react';
import GitBoard from '@/features/git';
import type { PanelInstance, PanelViewProps, ProjectPanelTarget } from '@/panel-sdk';
export interface GitPanelProps extends PanelViewProps<
  PanelInstance<'atelier.git', ProjectPanelTarget>
> {
  board: Omit<ComponentProps<typeof GitBoard>, 'expanded' | 'onToggleExpanded' | 'onClose'>;
}
export default function GitPanel({
  board,
  expanded,
  expandable,
  onRequestExpand,
  onRequestHide,
}: GitPanelProps) {
  return (
    <GitBoard
      {...board}
      expanded={expanded}
      onToggleExpanded={expandable ? onRequestExpand : undefined}
      onClose={onRequestHide}
    />
  );
}

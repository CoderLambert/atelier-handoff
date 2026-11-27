/**
 * @file 将现有 Git 工作区接入功能面板合同。
 * @implementation 将 Git 业务属性与公共布局操作传入 Git 工作区，业务状态由 Git 工作区和宿主管理。
 * @updated 2026-11-27T02:41:56+08:00
 */
import type { ComponentProps } from 'react';
import GitBoard from '@/features/git';
import type { PanelInstance, PanelViewProps, ProjectPanelTarget } from '@/panel-sdk';
export interface GitPanelProps extends PanelViewProps<
  PanelInstance<'atelier.git', ProjectPanelTarget>
> {
  board: Omit<ComponentProps<typeof GitBoard>, 'layout'>;
}
export default function GitPanel({ board, ...view }: GitPanelProps) {
  return <GitBoard {...board} layout={view} />;
}

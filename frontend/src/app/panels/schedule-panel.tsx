/**
 * @file 将定时任务详情面板接入工作台面板合同。
 * @implementation 适配 PanelViewProps，将项目与任务目标透传给 ScheduleInspectorPanel。
 * @updated 2026-11-27T13:48:00+08:00
 */
import type { ComponentProps } from 'react';
import { ScheduleInspectorPanel } from '@/features/schedules/schedule-panel';
import type { PanelInstance, PanelViewProps, ProjectPanelTarget } from '@/panel-sdk';

export interface SchedulePanelProps extends PanelViewProps<
  PanelInstance<'atelier.schedule', ProjectPanelTarget>
> {
  panel: Omit<ComponentProps<typeof ScheduleInspectorPanel>, 'layout'>;
}

export default function SchedulePanel({ panel, ...view }: SchedulePanelProps) {
  return <ScheduleInspectorPanel {...panel} layout={view} />;
}

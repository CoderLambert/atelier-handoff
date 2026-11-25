/**
 * @file 声明受信功能面板的公共接入合同。
 * @implementation 分离可序列化描述、ID 化实例和静态组件加载；资源由 feature 自行持有，不提供动态代码执行能力。
 * @updated 2026-11-26T01:00:00+08:00
 */
import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { resources } from '@shared/i18n';

type UiResources = typeof resources.en;
export type PanelTitleKey = {
  [Ns in keyof UiResources]: `${Ns & string}:${keyof UiResources[Ns] & string}`;
}[keyof UiResources];
export type ProjectPanelTarget = { scope: 'project'; projectId: string };
export type SessionPanelTarget = { scope: 'session'; projectId: string; sessionId: string };
export type PanelTarget = ProjectPanelTarget | SessionPanelTarget;
export interface PanelManifest {
  apiVersion: 1;
  id: string;
  titleKey: PanelTitleKey;
  scope: PanelTarget['scope'];
  slot: 'right';
  layout: { defaultWidth: number; minWidth: number; maxWidth: number };
}
export interface PanelInstance<
  Id extends string = string,
  Target extends PanelTarget = PanelTarget,
> {
  instanceId: string;
  panelId: Id;
  target: Target;
}
export interface PanelViewProps<Instance extends PanelInstance = PanelInstance> {
  instance: Instance;
  visible: boolean;
  expanded: boolean;
  expandable: boolean;
  onRequestHide(): void;
  onRequestExpand(): void;
}
export interface PanelDefinition<Props extends PanelViewProps> {
  manifest: PanelManifest & {
    id: Props['instance']['panelId'];
    scope: Props['instance']['target']['scope'];
  };
  icon: LucideIcon;
  load(): Promise<{ default: ComponentType<Props> }>;
}

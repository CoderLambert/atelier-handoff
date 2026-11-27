/**
 * @file 定义工作区布局的默认值、边界和持久化契约。
 * @implementation 定义导航栏与共享右侧工具的尺寸偏好，校验时兼容旧版较窄的浏览器栏宽度。
 * @updated 2026-11-27T02:41:56+08:00
 */
import { z } from 'zod';

export const minNavigationWidth = 190;
export const maxNavigationWidth = 440;
export const minInspectorWidth = 450;
export const maxInspectorWidth = 1440;
export const collapsedNavigationWidth = 48;
export const initialPaneWidths = { left: 232, right: 640 } as const;
export const paneWidthsSchema = z.strictObject({
  left: z.number().int().min(minNavigationWidth).max(maxNavigationWidth),
  // Existing preferences from the former browser-only column remain readable.
  right: z.number().int().min(240).max(maxInspectorWidth),
});
export const workspaceLayoutSchema = z.strictObject({
  defaults: paneWidthsSchema,
  recent: paneWidthsSchema,
  collapsed: z.boolean(),
});
export type PaneWidths = z.infer<typeof paneWidthsSchema>;
export type WorkspaceLayout = z.infer<typeof workspaceLayoutSchema>;
export const initialWorkspaceLayout: WorkspaceLayout = {
  defaults: initialPaneWidths,
  recent: initialPaneWidths,
  collapsed: false,
};

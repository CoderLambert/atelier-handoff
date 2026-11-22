/**
 * @file 定义工作区布局的默认值、边界和持久化契约。
 * @implementation 同时保存设置的默认宽度和最近使用的实际宽度。
 * @updated 2026-11-22T00:00:00+08:00
 */
import { z } from 'zod';

export const minNavigationWidth = 190;
export const maxNavigationWidth = 440;
export const minInspectorWidth = 240;
export const maxInspectorWidth = 760;
export const collapsedNavigationWidth = 48;
export const initialPaneWidths = { left: 232, right: 320 } as const;
export const paneWidthsSchema = z.strictObject({
  left: z.number().int().min(minNavigationWidth).max(maxNavigationWidth),
  right: z.number().int().min(minInspectorWidth).max(maxInspectorWidth),
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

/**
 * @file 定义内置 RTK 的全局默认与项目覆盖契约。
 * @implementation 从共享 schema 推导设置、更新和能力状态，项目可显式启停或恢复继承全局值。
 * @updated 2026-11-26T01:39:35+08:00
 */
import { z } from 'zod';

export const rtkProjectModeSchema = z.enum(['follow', 'on', 'off']);
export type RtkProjectMode = z.infer<typeof rtkProjectModeSchema>;

export const rtkSettingsPatchSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('global'), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('project'), mode: rtkProjectModeSchema }),
]);
export type RtkSettingsPatch = z.infer<typeof rtkSettingsPatchSchema>;

export const rtkSettingsScopeSchema = z.strictObject({ projectId: z.string().uuid().optional() });

export const rtkSettingsViewSchema = z.strictObject({
  globalEnabled: z.boolean(),
  projectMode: rtkProjectModeSchema,
  effectiveEnabled: z.boolean(),
  source: z.enum(['global', 'project']),
  available: z.boolean(),
  unavailableReason: z.enum(['native-unavailable', 'resource-unavailable']).optional(),
});
export type RtkSettingsView = z.infer<typeof rtkSettingsViewSchema>;

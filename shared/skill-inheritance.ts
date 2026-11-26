/**
 * @file 定义 Skill 继承视图与策略更新的共享契约。
 * @implementation 用 Zod schema 定义来源、策略、可用项和更新请求，并推导 TypeScript 类型。
 * @updated 2026-11-26T00:06:59+08:00
 */
import { z } from 'zod';

export const skillInheritanceModeSchema = z.enum(['off', 'manual', 'auto']);
export const skillInheritanceProjectModeSchema = z.enum(['follow', 'block']);
export const skillInheritanceOverrideSchema = z.enum(['follow', 'off', 'manual']);
export const skillInheritanceSourceSchema = z.enum(['atelier', 'workspace', 'host']);
const id = z.string().uuid();
export const skillInheritanceItemSchema = z.object({
  id,
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  source: skillInheritanceSourceSchema,
  mode: skillInheritanceModeSchema,
  effective: skillInheritanceModeSchema,
  override: skillInheritanceOverrideSchema,
  manual: z.boolean(),
  auto: z.boolean(),
  reason: z
    .enum(['global-off', 'project-blocked', 'not-native', 'disabled', 'session-off'])
    .optional(),
});
export const skillInheritanceViewSchema = z.object({
  enabled: z.boolean(),
  projectMode: skillInheritanceProjectModeSchema,
  items: z.array(skillInheritanceItemSchema),
});
export const skillInheritancePatchSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('global'), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('host'), id, mode: skillInheritanceModeSchema }),
  z.strictObject({ type: z.literal('project'), mode: skillInheritanceProjectModeSchema }),
  z.strictObject({ type: z.literal('session'), id, mode: skillInheritanceOverrideSchema }),
]);
export type SkillInheritanceMode = z.infer<typeof skillInheritanceModeSchema>;
export type SkillInheritanceProjectMode = z.infer<typeof skillInheritanceProjectModeSchema>;
export type SkillInheritanceOverride = z.infer<typeof skillInheritanceOverrideSchema>;
export type SkillInheritanceItem = z.infer<typeof skillInheritanceItemSchema>;
export type SkillInheritanceView = z.infer<typeof skillInheritanceViewSchema>;
export type SkillInheritancePatch = z.infer<typeof skillInheritancePatchSchema>;

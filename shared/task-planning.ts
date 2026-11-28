/**
 * @file 定义任务规划设置与运行策略。
 * @implementation 共享设置及 PATCH 校验，并定义默认拆分提示词和本轮快照。
 * @updated 2026-11-28T21:12:24+08:00
 */
import { z } from 'zod';
import { gatewayModelSchema } from './models.js';

export const taskPlanningModeSchema = z.enum(['auto', 'on-request', 'off']);
export type TaskPlanningMode = z.infer<typeof taskPlanningModeSchema>;

export const defaultTaskPlanningPrompt =
  '用用户的语言，围绕实际交付物拆分任务。依据用户要求和已确认的材料，按依赖顺序写出每一步要做什么、怎样算完成。保留明确的格式、范围和验收条件，合并能一起完成的动作。关键材料缺失时指出缺口。要求变化时更新受影响的步骤，有实际结果后再勾选完成。';

export const taskPlanningPromptLimit = 8000;
const prompt = z.string().trim().min(1).max(taskPlanningPromptLimit);
const model = gatewayModelSchema.shape.id;
const modelOverride = z.strictObject({ model, mode: taskPlanningModeSchema });
export const taskPlanningSettingsSchema = z.strictObject({
  mode: taskPlanningModeSchema,
  prompt: prompt.nullable(),
  modelOverrides: z.array(modelOverride),
});
export const taskPlanningPatchSchema = z.strictObject({
  mode: taskPlanningModeSchema.optional(),
  prompt: prompt.nullable().optional(),
  modelOverride: modelOverride.extend({ mode: taskPlanningModeSchema.nullable() }).optional(),
});
export const taskPlanningPolicySchema = z.strictObject({
  mode: taskPlanningModeSchema,
  prompt: prompt.optional(),
});
export type TaskPlanningSettings = z.infer<typeof taskPlanningSettingsSchema>;
export type TaskPlanningPatch = z.infer<typeof taskPlanningPatchSchema>;
export type TaskPlanningPolicy = z.infer<typeof taskPlanningPolicySchema>;

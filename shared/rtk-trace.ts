/**
 * @file 定义已确认执行的内置 RTK 命令轨迹。
 * @implementation 从运行时 schema 推导 Hook 身份与原始、实际命令；字段仅由执行回执确认后写入。
 * @updated 2026-11-26T01:33:50+08:00
 */
import { z } from 'zod';

export const rtkTraceSchema = z.object({
  hook: z.literal('builtin-rtk'),
  originalCommand: z.string().min(1),
  executedCommand: z.string().min(1),
});
export type RtkTrace = z.infer<typeof rtkTraceSchema>;

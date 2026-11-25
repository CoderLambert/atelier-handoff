/**
 * @file 定义原生 Bash 状态和用户控制请求。
 * @implementation 从运行时 schema 推导持久快照及逐命令操作类型。
 * @updated 2026-11-25T22:05:06+08:00
 */
import { z } from 'zod';

export const bashExecutionSchema = z.object({
  phase: z.enum(['foreground', 'background', 'stopping', 'stopped', 'unknown']),
  controllable: z.boolean(),
  lastObservedAt: z.string(),
  foregroundTimeoutMs: z.int().positive().optional(),
});
export type BashExecution = z.infer<typeof bashExecutionSchema>;

export const bashControlSchema = z.strictObject({ action: z.enum(['background', 'stop']) });
export type BashControl = z.infer<typeof bashControlSchema>;

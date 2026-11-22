/**
 * @file 定义会话快照提供的子任务记录。
 * @implementation 以同一 schema 校验运行时持久化、恢复与界面读取的状态。
 * @updated 2026-11-21T12:00:00+00:00
 */
import { z } from 'zod';

export const subagentSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  kind: z.enum(['explore', 'worker']),
  title: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'stopped', 'interrupted']),
  summary: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type Subagent = z.infer<typeof subagentSchema>;

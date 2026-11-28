/**
 * @file 定义交付验收事件的持久化字段。
 * @implementation 共享运行时回执和界面读取校验，使判定能关联到用户输入和已核对的成果版本。
 * @updated 2026-11-28T19:35:00+08:00
 */
import { z } from 'zod';

const checkSchema = z.object({
  criterion: z.string(),
  status: z.enum(['passed', 'failed', 'unverified']),
  detail: z.string(),
  artifactId: z.string().optional(),
  fingerprint: z.string().optional(),
});

export type AcceptanceCheck = z.infer<typeof checkSchema>;
export const acceptanceReceipt = z.object({
  phase: z.enum(['initial', 'recheck']),
  correctionRequested: z.boolean(),
  messageId: z.string().optional(),
  checks: z.array(checkSchema).nonempty(),
});

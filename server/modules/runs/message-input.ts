/**
 * @file 定义提交会话消息和持久队列意图的校验契约。
 * @implementation 共用请求 schema，记录排队时的授权指纹，并兼容旧队列记录中可选的执行器、Skill 范围和 Skill ID。
 * @updated 2026-11-27T02:25:28+08:00
 */
import { z } from 'zod';
import { composerTextLimit } from '../../../shared/message-quotes.js';
import { runScheduleMetaSchema } from '../../../shared/schedules.js';
import { reasoningEfforts } from '../../../shared/types.js';
import { extensionSelections } from '../../extensions.js';
import { gatewayModelId } from '../../gateway-models.js';

export const executorSchema = z.enum(['native-v1', 'project-v1']);
export const sessionMessageInput = z.object({
  text: z.string().trim().min(1).max(composerTextLimit),
  mode: z.enum(['readonly', 'edit']).default('readonly'),
  model: gatewayModelId.optional(),
  effort: z.enum(reasoningEfforts).optional(),
  approvalMode: z.literal('automatic').optional(),
  executionPreference: executorSchema.optional(),
  maxSearchChargeFen: z.int().min(0).max(100_000).optional(),
  contextPaths: z.array(z.string().max(1000)).max(30).default([]),
  attachmentIds: z.array(z.string().uuid()).max(20).default([]),
  extensionSelections: extensionSelections.default([]),
  idempotencyKey: z.string().uuid(),
  scheduleMeta: runScheduleMetaSchema.optional(),
});

export const queuedIntent = z.object({
  request: sessionMessageInput,
  model: gatewayModelId,
  scope: z.string(),
  executor: executorSchema.optional(),
  skillScope: z.string().optional(),
  skillIds: z.array(z.string().uuid()).optional(),
});

export type Executor = z.infer<typeof executorSchema>;
export type SessionMessageInput = z.infer<typeof sessionMessageInput>;

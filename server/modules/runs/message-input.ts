/**
 * @file 定义提交会话消息和持久队列意图的校验契约。
 * @implementation 共用请求 schema，并兼容原队列记录中的可选执行器和 Skill 范围字段。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { z } from 'zod';
import { composerTextLimit } from '../../../shared/message-quotes.js';
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
});

export const queuedIntent = z.object({
  request: sessionMessageInput,
  model: gatewayModelId,
  scope: z.string(),
  executor: executorSchema.optional(),
  skillScope: z.string().optional(),
});

export type Executor = z.infer<typeof executorSchema>;
export type SessionMessageInput = z.infer<typeof sessionMessageInput>;

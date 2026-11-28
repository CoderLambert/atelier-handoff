/**
 * @file 解析会话创建和草稿更新请求。
 * @implementation 校验创建请求中的项目和可选草稿编号，限制草稿编号与智能体版本的组合，并解析草稿更新和执行器选项。
 * @updated 2026-11-28T15:51:00+08:00
 */
import { z } from 'zod';
import { composerTextLimit, messageQuotesSchema } from '../../../shared/message-quotes.js';
import { reasoningEfforts } from '../../../shared/types.js';
import { extensionSelections } from '../../extensions.js';
import { gatewayModelId } from '../../gateway-models.js';
import { executorSchema } from '../../modules/runs/message-input.js';

const draftSchema = z
  .object({
    text: z.string().max(composerTextLimit),
    messageQuotes: messageQuotesSchema.optional(),
    mode: z.enum(['readonly', 'edit']),
    model: gatewayModelId.optional(),
    effort: z.enum(reasoningEfforts).optional(),
    approvalMode: z.literal('automatic').optional(),
    executionPreference: executorSchema.optional(),
    contextPaths: z.array(z.string().max(1000)).max(30),
    attachmentIds: z.array(z.string().uuid()).max(20),
    extensionSelections: extensionSelections.optional(),
  })
  .refine((draft) => !draft.approvalMode || draft.mode === 'edit', '自动化草稿须允许修改。');

export const sessionCreateInput = z
  .object({
    projectId: z.string().uuid(),
    agentRevisionId: z.string().uuid().optional(),
    draftId: z.uuidv4().optional(),
  })
  .refine((input) => !input.draftId || !input.agentRevisionId);
export const sessionUpdateInput = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  status: z.enum(['active', 'archived']).optional(),
  draft: draftSchema.optional(),
});

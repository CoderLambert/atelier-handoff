/**
 * @file 定义新运行的会话顺序与错误提示契约。
 * @implementation 正文片段引用同一消息内的 UTF-16 区间，工具和通知按首次观察位置关联。
 * @updated 2026-11-26T00:56:00+08:00
 */
import { z } from 'zod';

export const transcriptOrderSchema = z.int().positive();

const positioned = { order: transcriptOrderSchema, at: z.iso.datetime() };

const transcriptPartSchema = z
  .object({
    ...positioned,
    id: z.string().min(1),
    start: z.int().nonnegative(),
    end: z.int().positive(),
  })
  .refine(({ start, end }) => start < end);

const toolNotice = {
  ...positioned,
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
};
const toolBlockedNoticeSchema = z.object({ ...toolNotice, kind: z.literal('tool_blocked') });
const transcriptNoticeSchema = z.discriminatedUnion('kind', [
  z.object({
    ...positioned,
    kind: z.literal('api_retry'),
    attempt: z.int().nonnegative(),
    maxRetries: z.int().nonnegative(),
  }),
  z.object({ ...positioned, kind: z.literal('api_error'), code: z.string() }),
  toolBlockedNoticeSchema,
  z.object({ ...toolNotice, kind: z.literal('tool_preparing') }),
  z.object({ ...toolNotice, kind: z.literal('tool_interrupted') }),
]);

export const transcriptPartsSchema = z.array(transcriptPartSchema);
export const runTranscriptSchema = z.object({
  version: z.literal(1),
  notices: z.array(transcriptNoticeSchema),
  pendingDenials: z.array(toolBlockedNoticeSchema).optional(),
});

export type TranscriptPart = z.infer<typeof transcriptPartSchema>;
export type TranscriptNotice = z.infer<typeof transcriptNoticeSchema>;
export type RunTranscript = z.infer<typeof runTranscriptSchema>;

export function finalizeRunTranscript(transcript: RunTranscript): RunTranscript {
  return {
    version: 1,
    notices: [
      ...transcript.notices.map((notice): TranscriptNotice =>
        notice.kind === 'tool_preparing' ? { ...notice, kind: 'tool_interrupted' } : notice,
      ),
      ...(transcript.pendingDenials ?? []),
    ],
  };
}

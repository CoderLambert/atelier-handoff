/**
 * @file 定义本地 SDK 会话分支 worker 的输入和输出。
 * @implementation 用同一组 schema 校验线程边界，只传递目录、会话标识和原生分支结果。
 * @updated 2026-11-21T22:00:00+08:00
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const directory = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && !value.includes('\0'));
export const sessionForkRequestSchema = z.object({
  projectPath: directory,
  sourceDirectory: directory,
  targetDirectory: directory,
  sourceSessionId: z.uuid(),
  upToMessageId: z.uuid(),
  title: z.string().trim().min(1),
});
export type SessionForkRequest = z.infer<typeof sessionForkRequestSchema>;

export const sessionForkJobSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fork'),
    projectPath: directory,
    sourceSessionId: z.uuid(),
    upToMessageId: z.uuid(),
    title: z.string().min(1),
  }),
  z.object({
    kind: z.literal('read'),
    projectPath: directory,
    sourceSessionIds: z.array(z.uuid()).max(128),
  }),
]);
export const legacyForkTurnSchema = z.object({
  sdkSessionId: z.uuid(),
  userId: z.uuid(),
  assistantId: z.uuid(),
  prompt: z.string(),
  reply: z.string(),
});
const failure = z.object({ ok: z.literal(false), message: z.string() });
export const sessionForkReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), sessionId: z.uuid() }),
  failure,
]);
export const legacyForkReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), turns: z.array(legacyForkTurnSchema) }),
  failure,
]);

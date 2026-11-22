/**
 * @file 定义运行上下文快照及其派生计数。
 * @implementation 为 SDK 窗口、分类和最近请求的缓存用量提供共享存储契约。
 * @updated 2026-11-23T03:40:00+08:00
 */
import { z } from 'zod';

export const contextTokenCount = z.number().int().nonnegative();
export const contextCategorySchema = z.object({
  id: z.string().max(80).optional(),
  name: z.string().min(1).max(160),
  kind: z.enum(['used', 'free', 'buffer', 'deferred']),
  tokens: contextTokenCount,
});
export const contextMessageBreakdownSchema = z.object({
  userMessageTokens: contextTokenCount,
  assistantMessageTokens: contextTokenCount,
  toolCallTokens: contextTokenCount,
  toolResultTokens: contextTokenCount,
  attachmentTokens: contextTokenCount,
  redirectedContextTokens: contextTokenCount,
  unattributedTokens: contextTokenCount,
});
export const contextRequestUsageSchema = z.object({
  inputTokens: contextTokenCount.nullable(),
  outputTokens: contextTokenCount.nullable(),
  cacheReadTokens: contextTokenCount.nullable(),
  cacheCreationTokens: contextTokenCount.nullable(),
});
export const contextUsageSchema = z.object({
  capturedAt: z.iso.datetime(),
  sdkSessionId: z.string().min(1).max(128),
  model: z.string().min(1).max(200),
  usedTokens: contextTokenCount,
  windowTokens: contextTokenCount.positive(),
  categories: z.array(contextCategorySchema).max(32),
  messageBreakdown: contextMessageBreakdownSchema.optional(),
  requestUsage: contextRequestUsageSchema.nullable(),
});

export type ContextUsage = z.infer<typeof contextUsageSchema>;
export type ContextRequestUsage = z.infer<typeof contextRequestUsageSchema>;

export function contextStats(context: ContextUsage) {
  const reservedTokens = context.categories
    .filter(({ kind }) => kind === 'buffer')
    .reduce((sum, { tokens }) => sum + tokens, 0);
  const remainingTokens = Math.min(
    Math.max(0, context.windowTokens - context.usedTokens),
    context.categories.find(({ kind }) => kind === 'free')?.tokens ??
      Math.max(0, context.windowTokens - context.usedTokens - reservedTokens),
  );
  return {
    reservedTokens,
    remainingTokens,
    remainingRatio: remainingTokens / context.windowTokens,
    usedRatio: context.usedTokens / context.windowTokens,
  };
}

export function cacheHitRatio(usage: ContextRequestUsage | null): number | null {
  if (!usage) return null;
  const { inputTokens, cacheReadTokens, cacheCreationTokens } = usage;
  if (inputTokens === null || cacheReadTokens === null || cacheCreationTokens === null) return null;
  const total = inputTokens + cacheReadTokens + cacheCreationTokens;
  return total > 0 ? cacheReadTokens / total : null;
}

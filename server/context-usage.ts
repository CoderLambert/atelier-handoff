/**
 * @file 读取运行结束时的原生 SDK 上下文摘要。
 * @implementation 在现有连接中有界采样，保存界面需要的计数与分类。
 * @updated 2026-11-23T03:40:00+08:00
 */
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  contextCategorySchema,
  contextMessageBreakdownSchema,
  contextTokenCount,
  contextUsageSchema,
  type ContextUsage,
} from '../shared/context-usage.js';

const sdkSnapshot = z.object({
  model: z.string(),
  totalTokens: contextTokenCount,
  rawMaxTokens: contextTokenCount.positive(),
  categories: z.array(z.unknown()),
  messageBreakdown: z.unknown().optional(),
  apiUsage: z.record(z.string(), z.unknown()).nullable().optional().catch(null),
});

function readContextUsage(value: unknown, sdkSessionId: string): ContextUsage | undefined {
  const parsed = sdkSnapshot.safeParse(value);
  if (!parsed.success) return undefined;
  const source = parsed.data;
  const count = (value: unknown) => contextTokenCount.safeParse(value).data ?? null;
  const usage = source.apiUsage;
  return contextUsageSchema.safeParse({
    capturedAt: new Date().toISOString(),
    sdkSessionId,
    model: source.model,
    usedTokens: source.totalTokens,
    windowTokens: source.rawMaxTokens,
    categories: source.categories.slice(0, 32).flatMap((row) => {
      const category = contextCategorySchema.safeParse(row);
      return category.success ? [category.data] : [];
    }),
    messageBreakdown: contextMessageBreakdownSchema.safeParse(source.messageBreakdown).data,
    requestUsage: usage
      ? {
          inputTokens: count(usage.input_tokens),
          outputTokens: count(usage.output_tokens),
          cacheReadTokens: count(usage.cache_read_input_tokens),
          cacheCreationTokens: count(usage.cache_creation_input_tokens),
        }
      : null,
  }).data;
}

export function sampleContextUsage(
  connection: Pick<Query, 'getContextUsage'>,
  sdkSessionId: string,
  signal: AbortSignal,
  timeoutMs = 500,
): Promise<ContextUsage | undefined> {
  if (signal.aborted || typeof connection.getContextUsage !== 'function') {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const stop = () => finish(undefined);
    const timer = setTimeout(stop, timeoutMs);
    const finish = (value: ContextUsage | undefined) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve(value);
    };
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve()
      .then(() => (signal.aborted ? undefined : connection.getContextUsage({ detail: 'summary' })))
      .then((value) => finish(readContextUsage(value, sdkSessionId)))
      .catch(stop);
  });
}

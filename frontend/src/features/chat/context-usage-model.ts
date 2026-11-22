/**
 * @file 选择输入框对应的上下文快照。
 * @implementation 限定 SDK 会话归属，并标记来自旧运行或旧模型的样本。
 * @updated 2026-11-23T03:40:00+08:00
 */
import type { ContextUsage } from '@shared/context-usage';
import type { Run } from '@shared/types';

export function selectContextUsage(
  runs: readonly Pick<Run, 'id' | 'config' | 'contextUsage'>[],
  sdkSessionId: string | null,
  activeRunId: string | undefined,
  selectedModel: string,
): { context: ContextUsage; previous: boolean } | undefined {
  if (!sdkSessionId) return undefined;
  const owner = runs.findLast(({ contextUsage }) => contextUsage?.sdkSessionId === sdkSessionId);
  if (!owner?.contextUsage) return undefined;
  return {
    context: owner.contextUsage,
    previous: owner.id !== (activeRunId ?? runs.at(-1)?.id) || owner.config.model !== selectedModel,
  };
}

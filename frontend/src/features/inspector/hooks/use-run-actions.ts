/**
 * @file 编排运行停止与重试操作。
 * @implementation 合并两个 mutation 的状态，并为重试保留幂等键、防止重复提交。
 * @updated 2026-11-20T14:44:21+08:00
 */
import { useRef } from 'react';
import type { Run } from '@shared/types';
import { useStopRun } from '@/use-query/runs/use-stop-run';
import { useRetryRun } from '@/use-query/runs/use-retry-run';

export function useRunActions(run: Run) {
  const retryKey = useRef<string | undefined>(undefined);
  const stop = useStopRun(run);
  const retry = useRetryRun(run);
  return {
    isPending: stop.isPending || retry.isPending,
    isSuccess: stop.isSuccess || retry.isSuccess,
    error: stop.error ?? retry.error,
    mutate: (action: 'stop' | 'retry') => {
      if (stop.isPending || retry.isPending || stop.isSuccess || retry.isSuccess) return;
      if (action === 'stop') stop.mutate();
      else {
        retryKey.current ??= crypto.randomUUID();
        retry.mutate(retryKey.current);
      }
    },
  };
}

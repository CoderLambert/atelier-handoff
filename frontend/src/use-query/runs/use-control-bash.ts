/**
 * @file 提供指定原生 Bash 命令的后台和停止操作。
 * @implementation 绑定运行及工具身份，成功或冲突后刷新原会话和执行轨迹。
 * @updated 2026-11-25T22:05:06+08:00
 */
import {
  mutationOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import type { BashControl } from '@shared/bash-execution';
import type { ToolCall } from '@shared/types';
import { api } from '@/api/client';
import { sessionKeys } from '@/use-query/sessions/keys';
import { runKeys } from './keys';

function controlBashOptions(
  tool: Pick<ToolCall, 'id' | 'runId' | 'sessionId'>,
  client: QueryClient,
) {
  return mutationOptions({
    mutationKey: [...runKeys.bash(tool.runId), tool.id],
    mutationFn: async (body: BashControl) =>
      z
        .object({ ok: z.literal(true) })
        .parse(
          await api<unknown>(
            `/api/runs/${encodeURIComponent(tool.runId)}/tools/${encodeURIComponent(tool.id)}/bash`,
            { method: 'POST', body },
          ),
        ),
    retry: false,
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: sessionKeys.snapshot(tool.sessionId), exact: true }),
        client.invalidateQueries({ queryKey: runKeys.trace(tool.runId), exact: true }),
      ]);
    },
  });
}

export function useControlBash(tool: Pick<ToolCall, 'id' | 'runId' | 'sessionId'>) {
  return useMutation(controlBashOptions(tool, useQueryClient()));
}

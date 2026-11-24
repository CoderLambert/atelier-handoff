/**
 * @file 请求基于当前草稿的 AI 多提交修改。
 * @implementation 将显式指令绑定工作树快照并解码已验证的草稿。
 * @updated 2026-11-25T01:09:00+08:00
 */
import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
import {
  multiCommitRevisionResponse,
  type MultiCommitRevisionRequest,
} from '@shared/git-multi-commit';
import { gitTreeUrl } from './keys';

export function useReviseMultiCommit(projectId: string, treeId: string) {
  return useMutation({
    mutationFn: async ({ signal, ...body }: MultiCommitRevisionRequest & { signal: AbortSignal }) =>
      multiCommitRevisionResponse.parse(
        await api(gitTreeUrl(projectId, treeId) + '/commit-plan-revise', {
          method: 'POST',
          body,
          signal,
        }),
      ),
  });
}

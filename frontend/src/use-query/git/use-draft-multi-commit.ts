/**
 * @file 请求工作树变更快照及 AI 多提交建议。
 * @implementation 绑定项目和工作树，使用可取消的独立查询操作。
 * @updated 2026-11-24T14:41:22+08:00
 */
import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
import { multiCommitDraft, type MultiCommitDraftRequest } from '@shared/git-multi-commit';
import { gitTreeUrl } from './keys';

export function useDraftMultiCommit(projectId: string, treeId: string) {
  return useMutation({
    mutationFn: async ({ signal, ...body }: MultiCommitDraftRequest & { signal: AbortSignal }) =>
      multiCommitDraft.parse(
        await api(gitTreeUrl(projectId, treeId) + '/commit-plan', {
          method: 'POST',
          body,
          signal,
        }),
      ),
  });
}

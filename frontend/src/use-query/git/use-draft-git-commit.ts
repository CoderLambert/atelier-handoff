/**
 * @file 读取暂存区核对稿和可选的 AI 提交说明。
 * @implementation 使用所选项目及工作树的端点，并传递生成请求的取消信号。
 * @updated 2026-11-24T04:36:00+08:00
 */
import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
import { gitCommitDraft, type GitCommitDraftRequest } from '@shared/git-workbench';
import { gitTreeUrl } from './keys';

export function useDraftGitCommit(projectId: string, treeId: string) {
  return useMutation({
    mutationFn: async ({ signal, ...body }: GitCommitDraftRequest & { signal: AbortSignal }) =>
      gitCommitDraft.parse(
        await api(gitTreeUrl(projectId, treeId) + '/commit-draft', {
          method: 'POST',
          body,
          signal,
        }),
      ),
  });
}

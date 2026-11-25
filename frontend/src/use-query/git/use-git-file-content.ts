/**
 * @file 查询 Git 审阅中所选文件的完整文本。
 * @implementation 以工作树或提交、比较版本和路径区分完整文件查询。
 * @updated 2026-11-25T16:50:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import {
  gitFileContentResponse,
  type GitCommitFileSource,
  type GitWorkingFileSource,
} from '@shared/git-workbench';
import { gitKeys, gitTreeUrl, gitUrl } from './keys';

export type GitFileContentTarget = { path: string } & (
  | { kind: 'worktree'; worktreeId: string; source: GitWorkingFileSource }
  | { kind: 'history'; commitOid: string; source: GitCommitFileSource }
);

export function useGitFileContent(projectId: string, target: GitFileContentTarget) {
  const revision = target.kind === 'worktree' ? target.worktreeId : target.commitOid;
  return useQuery({
    queryKey: gitKeys.fileContent(projectId, revision, target.source, target.path),
    queryFn: async ({ signal }) => {
      const base =
        target.kind === 'worktree'
          ? gitTreeUrl(projectId, target.worktreeId)
          : `${gitUrl(projectId)}/commits/${encodeURIComponent(target.commitOid)}`;
      const params = new URLSearchParams({ path: target.path, source: target.source });
      return gitFileContentResponse.parse(await api(`${base}/file-content?${params}`, { signal }));
    },
    retry: false,
    staleTime: target.kind === 'history' ? Infinity : 0,
    gcTime: 90_000,
  });
}

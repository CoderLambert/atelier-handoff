/**
 * @file 查询 Git 审阅中所选文件的完整文本。
 * @implementation 按工作树、提交、比较版本和路径查询完整文件。工作树内容参与实时刷新，按提交固定的历史内容保持缓存。
 * @updated 2026-11-26T21:32:56+08:00
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
  return useQuery({
    queryKey:
      target.kind === 'worktree'
        ? gitKeys.workingFileContent(projectId, target.worktreeId, target.source, target.path)
        : gitKeys.commitFileContent(projectId, target.commitOid, target.source, target.path),
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

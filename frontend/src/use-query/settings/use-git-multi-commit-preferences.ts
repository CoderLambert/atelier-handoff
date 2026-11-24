/**
 * @file 读取 AI 多提交的模型和推理等级偏好。
 * @implementation 使用独立查询键与运行时 schema，确保偏好不改变聊天模型。
 * @updated 2026-11-25T00:00:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { gitMultiCommitPreferences } from '@shared/git-multi-commit';
import { api } from '@/api/client';

export const gitMultiCommitPreferencesKey = ['settings', 'git-multi-commit-preferences'] as const;
export function useGitMultiCommitPreferences() {
  return useQuery({
    queryKey: gitMultiCommitPreferencesKey,
    queryFn: async ({ signal }) =>
      gitMultiCommitPreferences.parse(
        await api('/api/settings/git-multi-commit-preferences', { signal }),
      ),
    staleTime: Infinity,
    retry: false,
  });
}

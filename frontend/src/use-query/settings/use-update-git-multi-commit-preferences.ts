/**
 * @file 保存 AI 多提交的模型和推理等级偏好。
 * @implementation 串行写入独立设置，并让缓存保留最新选择而不被迟到响应覆盖。
 * @updated 2026-11-25T00:00:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  gitMultiCommitPreferences,
  type GitMultiCommitPreferences,
} from '@shared/git-multi-commit';
import { api } from '@/api/client';
import { gitMultiCommitPreferencesKey } from './use-git-multi-commit-preferences';

export function useUpdateGitMultiCommitPreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...gitMultiCommitPreferencesKey, 'update'],
    scope: { id: 'git-multi-commit-preferences' },
    mutationFn: async (preferences: GitMultiCommitPreferences) =>
      gitMultiCommitPreferences.parse(
        await api('/api/settings/git-multi-commit-preferences', {
          method: 'PATCH',
          body: preferences,
        }),
      ),
    onMutate: (preferences) => {
      void client.cancelQueries({ queryKey: gitMultiCommitPreferencesKey });
      client.setQueryData(gitMultiCommitPreferencesKey, preferences);
    },
  });
}

/**
 * @file 校验多提交计划并读取每组差异预览。
 * @implementation 在所选工作树中绑定快照版本和用户编辑的分组。
 * @updated 2026-11-24T14:41:22+08:00
 */
import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
import { multiCommitPreview, type MultiCommitValidate } from '@shared/git-multi-commit';
import { gitTreeUrl } from './keys';

export function useValidateMultiCommit(projectId: string, treeId: string) {
  return useMutation({
    mutationFn: async (body: MultiCommitValidate) =>
      multiCommitPreview.parse(
        await api(gitTreeUrl(projectId, treeId) + '/commit-plan-validate', {
          method: 'POST',
          body,
        }),
      ),
  });
}

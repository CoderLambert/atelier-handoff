/**
 * @file 安全放弃尚未推进分支的多提交操作。
 * @implementation 仅发送操作编号，服务端校验引用、索引及锁归属后清理本操作的锁。
 * @updated 2026-11-24T14:41:22+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/api/client';
import { gitTreeUrl } from './keys';
import { pendingMultiCommitKey } from './use-pending-multi-commits';

export function useAbandonMultiCommit(projectId: string, treeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (operationId: string) =>
      z.strictObject({ operationId: z.uuid(), aborted: z.literal(true) }).parse(
        await api(gitTreeUrl(projectId, treeId) + '/commit-plan-abandon', {
          method: 'POST',
          body: { operationId },
        }),
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: pendingMultiCommitKey(projectId, treeId) });
    },
  });
}

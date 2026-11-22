/**
 * @file 提交单次审批的允许或拒绝决定。
 * @implementation 发送已复核的版本，操作结束后仅刷新所属审批、会话快照、运行列表与运行轨迹。
 * @updated 2026-11-20T11:51:19+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { Permission } from '@shared/types';
import { api, ApiError } from '@/api/client';
import { permissionKeys } from './keys';
import { permissionSchema } from './use-permission';

type PermissionDecision = Pick<Permission, 'id' | 'version' | 'sessionId' | 'runId'> & {
  decision: 'allow' | 'deny';
};

export function useDecidePermission() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: permissionKeys.decide,
    retry: false,
    mutationFn: async ({ id, version, decision }: PermissionDecision) => {
      const result = z.object({ permission: permissionSchema }).parse(
        await api<unknown>(`/api/permissions/${encodeURIComponent(id)}/decision`, {
          method: 'POST',
          body: { decision, version },
        }),
      );
      if (result.permission.id !== id)
        throw new ApiError('PERMISSION_RESPONSE_MISMATCH', 502, 'PERMISSION_RESPONSE_MISMATCH');
      return result.permission;
    },
    onSettled: (_data, _error, { id, sessionId, runId }) =>
      Promise.all([
        client.invalidateQueries({ queryKey: permissionKeys.permission(id) }),
        client.invalidateQueries({ queryKey: ['snapshot', sessionId], exact: true }),
        client.invalidateQueries({ queryKey: ['runs'] }),
        client.invalidateQueries({ queryKey: ['trace', runId], exact: true }),
      ]),
  });
}

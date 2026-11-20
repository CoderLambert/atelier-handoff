/**
 * @file 获取单次审批的差异或精确操作预览。
 * @implementation 以审批身份和版本隔离预览缓存，使用与完整审批一致的字段校验响应。
 * @updated 2026-11-20T11:51:19+08:00
 */
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { permissionKeys, type PermissionIdentity } from './keys';
import { permissionSchema } from './use-permission';

const permissionDiffSchema = permissionSchema.pick({
  diff: true,
  before: true,
  after: true,
  path: true,
  kind: true,
  version: true,
});

export const permissionDiffQuery = (identity: PermissionIdentity) =>
  queryOptions({
    queryKey: permissionKeys.diff(identity),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) =>
      permissionDiffSchema.parse(
        await api<unknown>(`/api/permissions/${encodeURIComponent(identity.id)}/diff`, { signal }),
      ),
  });

export function usePermissionDiff(identity: PermissionIdentity) {
  return useQuery(permissionDiffQuery(identity));
}

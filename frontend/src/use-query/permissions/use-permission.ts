/**
 * @file 获取单次审批的最新完整内容。
 * @implementation 按审批版本和状态查询，校验响应与请求身份，向审批复核用例提供可取消的快照。
 * @updated 2026-11-20T11:51:19+08:00
 */
import { queryOptions, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { Permission } from '@shared/types';
import { api } from '@/api/client';
import { permissionKeys, type PermissionIdentity } from './keys';

export const permissionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  kind: z.enum(['write', 'edit', 'delete', 'command', 'mcp', 'browser']),
  path: z.string().nullable(),
  command: z.string().nullable(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  diff: z.string(),
  baseFingerprint: z.string().nullable(),
  version: z.string(),
  status: z.enum(['pending', 'allowed', 'denied', 'expired', 'canceled']),
  createdAt: z.string(),
  expiresAt: z.string(),
  reason: z.string(),
  resolutionReason: z.string().optional(),
  decisionSource: z.literal('automatic').optional(),
}) satisfies z.ZodType<Permission>;

export const permissionQuery = (identity: PermissionIdentity) =>
  queryOptions({
    queryKey: permissionKeys.detail(identity),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const result = z
        .object({ permission: permissionSchema })
        .parse(
          await api<unknown>(`/api/permissions/${encodeURIComponent(identity.id)}`, { signal }),
        );
      if (result.permission.id !== identity.id) throw new Error('审批响应不匹配，请重新加载。');
      return result.permission;
    },
  });

export function usePermission(identity: PermissionIdentity) {
  return useQuery(permissionQuery(identity));
}

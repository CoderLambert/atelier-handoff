/**
 * @file 定义逐次审批内容与预览的查询键。
 * @implementation 用审批身份、版本和状态隔离复核内容，支持审批结果精准失效。
 * @updated 2026-11-20T11:51:19+08:00
 */
import type { Permission } from '@shared/types';

export type PermissionIdentity = Pick<Permission, 'id' | 'version' | 'status'>;

export const permissionKeys = {
  detail: ({ id, version, status }: PermissionIdentity) =>
    ['permissions', id, 'detail', version, status] as const,
  diff: ({ id, version, status }: PermissionIdentity) =>
    ['permissions', id, 'diff', version, status] as const,
  permission: (id: string) => ['permissions', id] as const,
  decide: ['permissions', 'decision'] as const,
};

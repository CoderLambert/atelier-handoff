/**
 * @file 定义开发会话的持久化记录及仓储接口。
 * @implementation 从共享输入推导列值校验，并以具体操作隔离 SQL 实现。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { z } from 'zod';
import {
  gitOid,
  gitBranchName,
  gitCheckoutMode,
  gitPath,
  gitRetentionReason,
} from '../../../shared/git-workbench.js';

export const worktreeRecord = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  repositoryId: z.string().min(1),
  mode: gitCheckoutMode,
  branch: gitBranchName,
  directoryIdentity: z.string().nullable(),
  adminIdentity: z.string().nullable(),
  snapshotId: z.uuid().nullable(),
  snapshotDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  retained: gitRetentionReason.nullable(),
  rebuildable: z.array(gitPath),
});
export const worktreeOperation = z.strictObject({
  id: z.uuid(),
  worktreeId: z.uuid(),
  requestHash: z.string().min(1),
  kind: z.enum(['create', 'reclaim', 'restore']),
  state: z.enum(['pending', 'completed', 'failed']),
  sessionId: z.uuid().nullable(),
  branch: gitBranchName,
  oid: gitOid,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  scratchIdentity: z.string().nullable(),
  error: z.string().nullable(),
});
export type WorktreeRecord = z.infer<typeof worktreeRecord>;
export type WorktreeOperation = z.infer<typeof worktreeOperation>;

export interface WorktreeRepository {
  byId(id: string): WorktreeRecord | undefined;
  byProject(projectId: string): WorktreeRecord[];
  forSession(sessionId: string): WorktreeRecord | undefined;
  sessions(worktreeId: string): string[];
  bind(sessionId: string, worktreeId: string): void;
  saveWorktree(value: WorktreeRecord): void;
  operation(id: string): WorktreeOperation | undefined;
  pendingOperations(): WorktreeOperation[];
  saveOperation(value: WorktreeOperation): void;
}

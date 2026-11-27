/**
 * @file 定义桌面端 Git 操作的共享 IPC 契约、类型与校验 Schema。
 * @implementation 声明 Git IPC 通道和校验结构。分支合并按工作树绑定来源及目标，并返回明确结果。
 * @updated 2026-11-27T01:02:41+08:00
 */
import { z } from 'zod';

export const desktopGitChannels = {
  status: 'git:status',
  commitStats: 'git:commit-stats',
  fetch: 'git:fetch',
  pull: 'git:pull',
  push: 'git:push',
  createBranch: 'git:create-branch',
  checkoutBranch: 'git:checkout-branch',
  renameBranch: 'git:rename-branch',
  deleteBranch: 'git:delete-branch',
  mergeBranch: 'git:merge-branch',
  reset: 'git:reset',
  revert: 'git:revert',
  cherryPick: 'git:cherry-pick',
  commit: 'git:commit',
  amendCommit: 'git:amend-commit',
  stashList: 'git:stash-list',
  stashPush: 'git:stash-push',
  stashPop: 'git:stash-pop',
  stashApply: 'git:stash-apply',
  stashDrop: 'git:stash-drop',
  continueOp: 'git:continue-op',
  abortOp: 'git:abort-op',
} as const;

export const repoStateSchema = z.enum([
  'NORMAL',
  'MERGING',
  'REBASING',
  'CHERRY_PICKING',
  'DETACHED',
]);
export type RepoState = z.infer<typeof repoStateSchema>;

export const gitRepoStatusSchema = z.strictObject({
  currentBranch: z.string(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  isDirty: z.boolean(),
  repoState: repoStateSchema,
  conflictFiles: z.array(z.string()),
});
export type GitRepoStatus = z.infer<typeof gitRepoStatusSchema>;

export const gitCommitStatsSchema = z.strictObject({
  hash: z.string(),
  body: z.string(),
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type GitCommitStats = z.infer<typeof gitCommitStatsSchema>;

export const gitStashItemSchema = z.strictObject({
  id: z.string(),
  index: z.number().int().nonnegative(),
  message: z.string(),
  date: z.string(),
});
export type GitStashItem = z.infer<typeof gitStashItemSchema>;

export const gitOpResultSchema = z.strictObject({
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});
export type GitOpResult = z.infer<typeof gitOpResultSchema>;

const existingBranchName = z
  .string()
  .min(1)
  .regex(/^[^\x00-\x20\x7f]+$/u);
export const gitMergeRequestSchema = z.strictObject({
  cwd: z.string().min(1),
  source: z.strictObject({ kind: z.enum(['local', 'remote']), name: existingBranchName }),
  targetBranch: existingBranchName.nullable(),
});
export type GitMergeRequest = z.infer<typeof gitMergeRequestSchema>;

export const gitMergeResultSchema = gitOpResultSchema.omit({ success: true }).extend({
  status: z.enum(['merged', 'upToDate', 'targetChanged', 'failed']),
});
export type GitMergeResult = z.infer<typeof gitMergeResultSchema>;

export const gitFetchOptionsSchema = z
  .strictObject({
    remote: z.string().optional(),
    prune: z.boolean().optional(),
  })
  .optional();
export type GitFetchOptions = z.infer<typeof gitFetchOptionsSchema>;

export const gitPullOptionsSchema = z
  .strictObject({
    rebase: z.boolean().optional(),
    autoStash: z.boolean().optional(),
  })
  .optional();
export type GitPullOptions = z.infer<typeof gitPullOptionsSchema>;

export const gitPushOptionsSchema = z
  .strictObject({
    setUpstream: z.boolean().optional(),
    forceWithLease: z.boolean().optional(),
    remote: z.string().optional(),
    branch: z.string().optional(),
  })
  .optional();
export type GitPushOptions = z.infer<typeof gitPushOptionsSchema>;

export const gitResetModeSchema = z.enum(['soft', 'mixed', 'hard']);
export type GitResetMode = z.infer<typeof gitResetModeSchema>;

export interface DesktopGitBridge {
  getStatus(cwd: string): Promise<GitRepoStatus>;
  getCommitStats(cwd: string, hash: string): Promise<GitCommitStats>;
  fetch(cwd: string, options?: GitFetchOptions): Promise<GitOpResult>;
  pull(cwd: string, options?: GitPullOptions): Promise<GitOpResult>;
  push(cwd: string, options?: GitPushOptions): Promise<GitOpResult>;
  createBranch(cwd: string, name: string, startPoint?: string): Promise<GitOpResult>;
  checkoutBranch(cwd: string, name: string, autoStash?: boolean): Promise<GitOpResult>;
  renameBranch(cwd: string, oldName: string, newName: string): Promise<GitOpResult>;
  deleteBranch(cwd: string, name: string, force?: boolean): Promise<GitOpResult>;
  mergeBranch(request: GitMergeRequest): Promise<GitMergeResult>;
  reset(cwd: string, hash: string, mode: GitResetMode): Promise<GitOpResult>;
  revert(cwd: string, hash: string): Promise<GitOpResult>;
  cherryPick(cwd: string, hash: string): Promise<GitOpResult>;
  commit(cwd: string, message: string, stageAll?: boolean): Promise<GitOpResult>;
  amendCommit(cwd: string, message: string, stageAll?: boolean): Promise<GitOpResult>;
  stashList(cwd: string): Promise<GitStashItem[]>;
  stashPush(cwd: string, message?: string): Promise<GitOpResult>;
  stashPop(cwd: string, index?: number): Promise<GitOpResult>;
  stashApply(cwd: string, index?: number): Promise<GitOpResult>;
  stashDrop(cwd: string, index?: number): Promise<GitOpResult>;
  continueOp(cwd: string): Promise<GitOpResult>;
  abortOp(cwd: string): Promise<GitOpResult>;
}

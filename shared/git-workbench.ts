/**
 * @file 定义 Git 看板、开发会话和暂存提交的共享契约。
 * @implementation 校验本机引用、工作树操作、暂存清单、编辑内容和提交回执。
 * @updated 2026-11-24T04:50:56+08:00
 */
import { z } from 'zod';
import { uiLocaleSchema } from './i18n/locale.js';

export const gitOid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const gitBranchName = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[^\x00-\x20\x7f~-][^\x00-\x20\x7f]*$/u);
export const gitPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.includes('\0') &&
      path
        .split('/')
        .every(
          (part) => part !== '' && part !== '..' && part !== '.' && part.toLowerCase() !== '.git',
        ),
  );
export const gitDiffLayer = z.enum(['staged', 'unstaged', 'untracked', 'conflict']);
export const gitCheckoutMode = z.enum(['linked', 'in_place']);
export const gitStartPoint = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('head') }),
  z.strictObject({ kind: z.literal('branch'), name: gitBranchName }),
  z.strictObject({ kind: z.literal('commit'), oid: gitOid }),
]);
export const developmentPreview = z.strictObject({
  requestId: z.uuid(),
  mode: gitCheckoutMode,
  sourceWorktreeId: z.uuid().optional(),
  branch: gitBranchName,
  base: gitStartPoint,
});
export const developmentCreate = developmentPreview.extend({ expectedOid: gitOid });
export const gitReclaimRequest = z.strictObject({ requestId: z.uuid() });
export const gitRestoreRequest = gitReclaimRequest.extend({ branch: gitBranchName.optional() });
export const gitCacheRequest = z.strictObject({
  path: gitPath,
  rebuildable: z.boolean().default(true),
});
export type DevelopmentPreview = z.infer<typeof developmentPreview>;
export type DevelopmentCreate = z.infer<typeof developmentCreate>;
export type GitStartPoint = z.infer<typeof gitStartPoint>;
export type GitRestoreRequest = z.infer<typeof gitRestoreRequest>;
export type GitDiffLayer = z.infer<typeof gitDiffLayer>;
export type GitCheckoutMode = z.infer<typeof gitCheckoutMode>;

export const gitRetentionReason = z.enum([
  'ignored',
  'inUse',
  'changed',
  'unsupported',
  'snapshotFailed',
  'interrupted',
  'relocated',
]);
export type GitRetentionReason = z.infer<typeof gitRetentionReason>;
export interface GitWorktree {
  id: string;
  path: string;
  branch: string | null;
  head: string | null;
  scope: 'project' | 'managed' | 'external';
  state: 'ready' | 'busy' | 'missing' | 'snapshotted' | 'changed';
  locked: boolean;
  retained?: GitRetentionReason;
  canReclaim?: boolean;
  retainedPath?: string;
}
export interface GitBranch {
  name: string;
  kind: 'local' | 'remote';
  oid: string;
  worktreeId?: string;
}
export interface GitOverview {
  worktrees: GitWorktree[];
  branches: GitBranch[];
}
export interface GitFile {
  path: string;
  previousPath?: string;
  index: string;
  worktree: string;
  kind: 'tracked' | 'untracked' | 'conflict';
}
export interface GitFileStatus {
  files: GitFile[];
  ignored: string[];
  rebuildable: string[];
}
export interface GitDiff {
  text: string;
  binary: boolean;
}
export interface GitCommit {
  oid: string;
  author: string;
  date: string;
  subject: string;
}
export interface GitHistory {
  items: GitCommit[];
  nextOffset: number | null;
}
export interface GitSessionWorkspace {
  id: string;
  path: string;
  branch: string;
  mode: GitCheckoutMode;
  state: GitWorktree['state'];
  retained?: GitRetentionReason;
  needsBranch?: boolean;
  retainedPath?: string;
}
export interface GitDevelopmentPreview {
  path: string;
  oid: string;
  branch: string;
}

export const gitCommitDraftRequest = z.strictObject({
  locale: uiLocaleSchema,
  generate: z.boolean().default(true),
});
const gitStagedVersion = z.string().regex(/^[a-f0-9]{64}$/u);
export const gitCommitTitle = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[^\r\n\0]+$/u);
export const gitCommitBody = z
  .string()
  .max(8000)
  .refine((text) => !text.includes('\0'));
export const gitCommitMessage = z.strictObject({
  title: gitCommitTitle,
  body: gitCommitBody.default(''),
});
export const gitCommitRequest = gitCommitMessage.extend({ version: gitStagedVersion });
export const gitStagedFile = z.strictObject({
  path: gitPath,
  previousPath: gitPath.optional(),
  added: z.number().int().nonnegative().nullable(),
  removed: z.number().int().nonnegative().nullable(),
});
export const gitCommitDraft = z.strictObject({
  version: gitStagedVersion,
  branch: z.string().nullable(),
  files: z.array(gitStagedFile).max(120),
  fileCount: z.number().int().positive(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  suggestion: gitCommitMessage.nullable(),
  partial: z.boolean(),
});
export const gitCommitReceipt = z.strictObject({ oid: gitOid });
export type GitCommitDraftRequest = z.input<typeof gitCommitDraftRequest>;
export type GitCommitDraft = z.infer<typeof gitCommitDraft>;
export type GitCommitRequest = z.input<typeof gitCommitRequest>;
export type GitStagedFile = z.infer<typeof gitStagedFile>;

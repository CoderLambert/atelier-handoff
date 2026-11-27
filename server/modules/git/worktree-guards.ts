/**
 * @file 提供开发工作树的路径、仓库状态与目录身份校验辅助。
 * @implementation 封装只读路径存在性、Git 空闲态检查、检出身份核对、分支占用检测与临时检出清理。
 * @updated 2026-11-27T12:45:00-06:00
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRetentionReason } from '../../../shared/git-workbench.js';
import type { Project } from '../../../shared/types.js';
import { AppError } from '../../../shared/errors.js';
import { inside } from '../../files.js';
import { fileIdentity, gitError, LocalGit } from './git-cli.js';
import { listGitWorktrees } from './git-reader.js';
import type { WorktreeRecord } from './worktree-repository.js';

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function assertIdleGit(git: LocalGit, ownIndexLock = false): Promise<void> {
  const markers = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'REBASE_HEAD',
    'BISECT_START',
    'rebase-apply',
    'rebase-merge',
    'sequencer',
    ...(ownIndexLock ? [] : ['index.lock']),
  ];
  if ((await Promise.all(markers.map((name) => pathExists(join(git.admin, name))))).some(Boolean))
    throw gitError('IN_PROGRESS', '此检出有进行中的 Git 操作。');
}

export function worktreePath(managed: string, project: Project, row: WorktreeRecord): string {
  return row.mode === 'linked' ? join(managed, row.id) : project.path;
}

export function scratchPath(
  managed: string,
  purpose: 'verify' | 'restore' | 'reclaim',
  id: string,
): string {
  return join(managed, '.' + purpose + '-' + id);
}

export function retentionReason(error: unknown): GitRetentionReason {
  const code = error instanceof AppError ? error.code : undefined;
  if (code === 'GIT_IGNORED_FILES') return 'ignored';
  if (code === 'GIT_DIRECTORY_BUSY') return 'inUse';
  if (code === 'GIT_WORKTREE_CHANGED' || code === 'GIT_DESTINATION_EXISTS') return 'changed';
  if (
    code === 'GIT_IN_PROGRESS' ||
    code === 'GIT_SNAPSHOT_UNSUPPORTED' ||
    code === 'GIT_OUTPUT_LIMIT'
  )
    return 'unsupported';
  return 'snapshotFailed';
}

export async function openWorktreeRepository(
  project: Project,
  row: WorktreeRecord,
): Promise<LocalGit> {
  const git = await LocalGit.open(project.path);
  if (git.repositoryId !== row.repositoryId)
    throw gitError('WORKTREE_CHANGED', '项目的 Git 仓库身份已变化。');
  return git;
}

export async function checkWorktreeCheckout(
  row: WorktreeRecord,
  path: string,
  signal?: AbortSignal,
) {
  const git = await LocalGit.open(path, signal);
  if (
    git.repositoryId !== row.repositoryId ||
    (row.mode === 'linked' &&
      (git.admin === git.common || !inside(join(git.common, 'worktrees'), git.admin)))
  )
    throw gitError('WORKTREE_CHANGED', '检出的仓库身份已变化。');
  const [entry, identity, admin] = await Promise.all([
    listGitWorktrees(git, signal).then((trees) => trees.find((item) => item.path === path)),
    fileIdentity(path),
    fileIdentity(git.admin),
  ]);
  if (
    !entry ||
    entry.missing ||
    entry.branch !== row.branch ||
    (row.directoryIdentity && row.directoryIdentity !== identity) ||
    (row.adminIdentity && row.adminIdentity !== admin)
  )
    throw gitError('WORKTREE_CHANGED', '工作树位置或分支已变化。');
  return { git, entry, identity, admin };
}

export async function needsRestoreBranch(
  git: LocalGit,
  branch: string,
  oid: string,
): Promise<boolean> {
  const [ref, worktrees] = await Promise.all([
    git.oid('refs/heads/' + branch),
    listGitWorktrees(git),
  ]);
  return ref !== oid || worktrees.some((entry) => entry.branch === branch);
}

// Scratch paths belong to one persisted operation and are outside all project roots.
export async function discardScratchWorktree(
  git: LocalGit,
  path: string,
  identity: string | null,
): Promise<void> {
  if (!identity || !(await pathExists(path)) || (await fileIdentity(path)) !== identity) return;
  const scratch = await LocalGit.open(path).catch(() => undefined);
  if (scratch?.repositoryId !== git.repositoryId) return;
  await git.run(['worktree', 'remove', '--force', '--', path]);
}

export async function returnParkedWorktree(
  managed: string,
  project: Project,
  source: LocalGit,
  row: WorktreeRecord,
  parked: string,
): Promise<boolean> {
  const original = worktreePath(managed, project, row);
  try {
    if (await pathExists(original)) return false;
    await checkWorktreeCheckout(row, parked);
    await source.run(['worktree', 'move', '--', parked, original]);
    return true;
  } catch {
    return false;
  }
}

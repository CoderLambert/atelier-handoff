/**
 * @file 提供主进程 Git CLI 执行服务与基础操作。
 * @implementation 通过参数数组执行 Git。分支合并使用完整引用并核对工作树目标，区分改动、无变更和失败。
 * @updated 2026-11-27T01:02:41+08:00
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  GitCommitStats,
  GitFetchOptions,
  GitMergeRequest,
  GitMergeResult,
  GitOpResult,
  GitPullOptions,
  GitPushOptions,
  GitRepoStatus,
  GitResetMode,
  GitStashItem,
  RepoState,
} from '../../shared/desktop-git.js';

export interface GitExecResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export function execGit(
  cwd: string,
  args: readonly string[],
  options?: { input?: string | Buffer },
): Promise<GitExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        env: {
          ...process.env,
          LANG: 'C',
          LC_ALL: 'C',
          GIT_EDITOR: 'true',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const outStr = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        const errStr = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        if (error) {
          const code = typeof error.code === 'number' ? error.code : 1;
          resolve({
            success: false,
            code,
            stdout: outStr,
            stderr: errStr || error.message,
          });
        } else {
          resolve({
            success: true,
            code: 0,
            stdout: outStr,
            stderr: errStr,
          });
        }
      },
    );
    if (options?.input) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.input);
    }
  });
}

export async function getGitRepoStatus(cwd: string): Promise<GitRepoStatus> {
  const dirRes = await execGit(cwd, ['rev-parse', '--git-dir']);
  if (!dirRes.success) {
    throw new Error(dirRes.stderr.trim() || 'Not a git repository.');
  }
  const rawGitDir = dirRes.stdout.trim();
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : join(cwd, rawGitDir);

  let repoState: RepoState = 'NORMAL';
  if (
    existsSync(join(gitDir, 'rebase-merge')) ||
    existsSync(join(gitDir, 'rebase-apply'))
  ) {
    repoState = 'REBASING';
  } else if (existsSync(join(gitDir, 'MERGE_HEAD'))) {
    repoState = 'MERGING';
  } else if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) {
    repoState = 'CHERRY_PICKING';
  } else {
    const symRes = await execGit(cwd, ['symbolic-ref', '-q', 'HEAD']);
    if (!symRes.success) {
      repoState = 'DETACHED';
    }
  }

  let currentBranch = 'HEAD';
  if (repoState !== 'DETACHED') {
    const symRes = await execGit(cwd, ['symbolic-ref', '--short', 'HEAD']);
    if (symRes.success && symRes.stdout.trim()) {
      currentBranch = symRes.stdout.trim();
    } else {
      const bRes = await execGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (bRes.success && bRes.stdout.trim()) {
        currentBranch = bRes.stdout.trim();
      }
    }
  } else {
    const shaRes = await execGit(cwd, ['rev-parse', '--short', 'HEAD']);
    if (shaRes.success && shaRes.stdout.trim()) {
      currentBranch = shaRes.stdout.trim();
    }
  }

  const upRes = await execGit(cwd, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  const upstream = upRes.success && upRes.stdout.trim() ? upRes.stdout.trim() : null;

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const countRes = await execGit(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    if (countRes.success) {
      const parts = countRes.stdout.trim().split(/\s+/);
      const first = parts[0];
      const second = parts[1];
      ahead = first !== undefined ? Number(first) || 0 : 0;
      behind = second !== undefined ? Number(second) || 0 : 0;
    }
  }

  const statusRes = await execGit(cwd, ['--no-optional-locks', 'status', '--porcelain']);
  const isDirty = statusRes.success && statusRes.stdout.trim().length > 0;

  const conflicts = new Set<string>();
  const diffRes = await execGit(cwd, ['--no-optional-locks', 'diff', '--name-only', '--diff-filter=U']);
  if (diffRes.success && diffRes.stdout.trim()) {
    for (const file of diffRes.stdout.trim().split('\n')) {
      const trimmed = file.trim();
      if (trimmed) conflicts.add(trimmed);
    }
  }
  if (statusRes.success && statusRes.stdout.trim()) {
    for (const line of statusRes.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const code = trimmed.slice(0, 2);
      if (['UU', 'AA', 'UD', 'DU', 'DD', 'AU', 'UA'].includes(code)) {
        const filePath = trimmed.slice(2).trim();
        if (filePath) conflicts.add(filePath);
      }
    }
  }

  return {
    currentBranch,
    upstream,
    ahead,
    behind,
    isDirty,
    repoState,
    conflictFiles: Array.from(conflicts),
  };
}

export async function getGitCommitStats(cwd: string, hash: string): Promise<GitCommitStats> {
  const res = await execGit(cwd, ['show', '--shortstat', '--format=%B', hash]);
  if (!res.success) {
    throw new Error(res.stderr.trim() || `Failed to read commit stats for ${hash}`);
  }
  const lines = res.stdout.trim().split('\n');
  const statRegex =
    /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/;

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  let bodyLines = lines;

  const lastLine = lines[lines.length - 1];
  if (lastLine !== undefined) {
    const match = statRegex.exec(lastLine);
    if (match) {
      filesChanged = match[1] !== undefined ? Number(match[1]) || 0 : 0;
      insertions = match[2] !== undefined ? Number(match[2]) || 0 : 0;
      deletions = match[3] !== undefined ? Number(match[3]) || 0 : 0;
      bodyLines = lines.slice(0, -1);
    }
  }

  return {
    hash,
    body: bodyLines.join('\n').trim(),
    filesChanged,
    insertions,
    deletions,
  };
}

export async function gitFetch(cwd: string, options?: GitFetchOptions): Promise<GitOpResult> {
  const args = ['fetch'];
  if (options?.remote) args.push(options.remote);
  else args.push('--all');
  if (options?.prune) args.push('--prune');
  const res = await execGit(cwd, args);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitPull(cwd: string, options?: GitPullOptions): Promise<GitOpResult> {
  const args = ['pull'];
  if (options?.rebase) args.push('--rebase');
  if (options?.autoStash) args.push('--autostash');
  const res = await execGit(cwd, args);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitPush(cwd: string, options?: GitPushOptions): Promise<GitOpResult> {
  const args = ['push'];
  if (options?.setUpstream) {
    args.push('-u', options.remote || 'origin', options.branch || 'HEAD');
  } else if (options?.remote) {
    args.push(options.remote);
    if (options?.branch) args.push(options.branch);
  }
  if (options?.forceWithLease) args.push('--force-with-lease');
  const res = await execGit(cwd, args);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitCreateBranch(
  cwd: string,
  name: string,
  startPoint?: string,
): Promise<GitOpResult> {
  const args = ['branch', name];
  if (startPoint) args.push(startPoint);
  const res = await execGit(cwd, args);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitCheckoutBranch(
  cwd: string,
  name: string,
  autoStash?: boolean,
): Promise<GitOpResult> {
  if (autoStash) {
    const statusRes = await execGit(cwd, ['status', '--porcelain']);
    if (statusRes.success && statusRes.stdout.trim().length > 0) {
      const stashRes = await execGit(cwd, [
        'stash',
        'push',
        '-u',
        '-m',
        `Auto-stash before checkout to ${name}`,
      ]);
      if (!stashRes.success) {
        return { success: false, stdout: stashRes.stdout, stderr: stashRes.stderr };
      }
      const checkoutRes = await execGit(cwd, ['checkout', name]);
      if (!checkoutRes.success) {
        await execGit(cwd, ['stash', 'pop']);
        return { success: false, stdout: checkoutRes.stdout, stderr: checkoutRes.stderr };
      }
      const popRes = await execGit(cwd, ['stash', 'pop']);
      return {
        success: popRes.success,
        stdout: [checkoutRes.stdout, popRes.stdout].filter(Boolean).join('\n'),
        stderr: popRes.stderr,
      };
    }
  }
  const res = await execGit(cwd, ['checkout', name]);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitRenameBranch(
  cwd: string,
  oldName: string,
  newName: string,
): Promise<GitOpResult> {
  const res = await execGit(cwd, ['branch', '-m', oldName, newName]);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitDeleteBranch(
  cwd: string,
  name: string,
  force?: boolean,
): Promise<GitOpResult> {
  const res = await execGit(cwd, ['branch', force ? '-D' : '-d', name]);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitMergeBranch({
  cwd,
  source,
  targetBranch,
}: GitMergeRequest): Promise<GitMergeResult> {
  const sourceRef = `refs/${source.kind === 'local' ? 'heads' : 'remotes'}/${source.name}`;
  const sourceResult = await execGit(cwd, ['show-ref', '--verify', '--', sourceRef]);
  if (!sourceResult.success) {
    return { status: 'failed', stdout: sourceResult.stdout, stderr: sourceResult.stderr };
  }

  const target = await execGit(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
  if (!target.success && target.code !== 1) {
    return { status: 'failed', stdout: target.stdout, stderr: target.stderr };
  }
  const actualTarget = target.success ? target.stdout.trim() : null;
  const expectedTarget = targetBranch === null ? null : `refs/heads/${targetBranch}`;
  if (actualTarget !== expectedTarget) {
    return { status: 'targetChanged', stdout: '', stderr: '' };
  }

  const result = await execGit(cwd, ['merge', '--', sourceRef]);
  if (!result.success) {
    return { status: 'failed', stdout: result.stdout, stderr: result.stderr };
  }
  return {
    status: result.stdout.trim() === 'Already up to date.' ? 'upToDate' : 'merged',
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function gitReset(
  cwd: string,
  hash: string,
  mode: GitResetMode,
): Promise<GitOpResult> {
  const res = await execGit(cwd, ['reset', `--${mode}`, hash]);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitRevert(cwd: string, hash: string): Promise<GitOpResult> {
  const res = await execGit(cwd, ['revert', '--no-edit', hash]);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitCherryPick(cwd: string, hash: string): Promise<GitOpResult> {
  const res = await execGit(cwd, ['cherry-pick', hash]);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitCommit(
  cwd: string,
  message: string,
  stageAll?: boolean,
): Promise<GitOpResult> {
  if (stageAll) {
    await execGit(cwd, ['add', '-A']);
  }
  const res = await execGit(cwd, ['commit', '-m', message]);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitAmendCommit(
  cwd: string,
  message: string,
  stageAll?: boolean,
): Promise<GitOpResult> {
  if (stageAll) {
    await execGit(cwd, ['add', '-A']);
  }
  const res = await execGit(cwd, ['commit', '--amend', '-m', message]);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitStashList(cwd: string): Promise<GitStashItem[]> {
  const res = await execGit(cwd, ['stash', 'list', '--format=%gd%x00%gs%x00%cr']);
  if (!res.success || !res.stdout.trim()) {
    return [];
  }
  const lines = res.stdout.trim().split('\n');
  const items: GitStashItem[] = [];
  for (const line of lines) {
    const parts = line.split('\0');
    const id = parts[0] ?? '';
    const message = parts[1] ?? '';
    const date = parts[2] ?? '';
    const idxMatch = id.match(/\d+/);
    const index = idxMatch ? Number(idxMatch[0]) || 0 : 0;
    items.push({ id, index, message, date });
  }
  return items;
}

export async function gitStashPush(cwd: string, message?: string): Promise<GitOpResult> {
  const args = ['stash', 'push'];
  if (message) args.push('-m', message);
  const res = await execGit(cwd, args);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitStashPop(cwd: string, index?: number): Promise<GitOpResult> {
  const args = ['stash', 'pop'];
  if (typeof index === 'number') args.push(`stash@{${index}}`);
  const res = await execGit(cwd, args);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitStashApply(cwd: string, index?: number): Promise<GitOpResult> {
  const args = ['stash', 'apply'];
  if (typeof index === 'number') args.push(`stash@{${index}}`);
  const res = await execGit(cwd, args);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitStashDrop(cwd: string, index?: number): Promise<GitOpResult> {
  const args = ['stash', 'drop'];
  if (typeof index === 'number') args.push(`stash@{${index}}`);
  const res = await execGit(cwd, args);
  return { success: res.success, stdout: res.stdout, stderr: res.stderr };
}

export async function gitContinueOp(cwd: string): Promise<GitOpResult> {
  const status = await getGitRepoStatus(cwd).catch(() => null);
  if (!status) {
    return { success: false, stdout: '', stderr: 'Unable to check repository status.' };
  }
  if (status.repoState === 'MERGING') {
    const res = await execGit(cwd, ['merge', '--continue']);
    return { success: res.success, stdout: res.stdout, stderr: res.stderr };
  }
  if (status.repoState === 'REBASING') {
    const res = await execGit(cwd, ['rebase', '--continue']);
    return { success: res.success, stdout: res.stdout, stderr: res.stderr };
  }
  if (status.repoState === 'CHERRY_PICKING') {
    const res = await execGit(cwd, ['cherry-pick', '--continue']);
    return { success: res.success, stdout: res.stdout, stderr: res.stderr };
  }
  return {
    success: false,
    stdout: '',
    stderr: 'No merge, rebase, or cherry-pick in progress to continue.',
  };
}

export async function gitAbortOp(cwd: string): Promise<GitOpResult> {
  const status = await getGitRepoStatus(cwd).catch(() => null);
  if (!status) {
    return { success: false, stdout: '', stderr: 'Unable to check repository status.' };
  }
  if (status.repoState === 'MERGING') {
    const res = await execGit(cwd, ['merge', '--abort']);
    return { success: res.success, stdout: res.stdout, stderr: res.stderr };
  }
  if (status.repoState === 'REBASING') {
    const res = await execGit(cwd, ['rebase', '--abort']);
    return { success: res.success, stdout: res.stdout, stderr: res.stderr };
  }
  if (status.repoState === 'CHERRY_PICKING') {
    const res = await execGit(cwd, ['cherry-pick', '--abort']);
    return { success: res.success, stdout: res.stdout, stderr: res.stderr };
  }
  return {
    success: false,
    stdout: '',
    stderr: 'No merge, rebase, or cherry-pick in progress to abort.',
  };
}

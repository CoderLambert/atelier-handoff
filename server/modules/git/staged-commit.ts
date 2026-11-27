/**
 * @file 核对暂存区并执行用户确认的 Git 提交。
 * @implementation 使用临时索引副本确定树，持有检出索引锁并按预期旧引用推进分支。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { copyFile, lstat, mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitOid,
  gitStagedFile,
  type GitCommitDraft,
  type GitCommitRequest,
  type GitStagedFile,
} from '../../../shared/git-workbench.js';
import { AppError } from '../../../shared/errors.js';
import { fingerprint } from '../../files.js';
import { assertIdleGit } from './development-worktrees.js';
import { fileIdentity, gitError, gitText, type LocalGit } from './git-cli.js';

const maxFiles = 120;
const maxPatchChars = 24_000;
const diffFlags = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--find-renames',
  '--submodule=short',
  '--ignore-submodules=none',
];
const errorIs = (error: unknown, code: string) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;
const stale = () => gitError('COMMIT_STALE', '暂存区或当前分支已变化，请重新核对。');

async function readTarget(git: LocalGit, signal?: AbortSignal) {
  const [reference, head] = await Promise.all([
    git.text(['symbolic-ref', '--quiet', 'HEAD'], { signal, allowExit: [1] }),
    git.oid('HEAD', signal),
  ]);
  const ref = reference.trim() || 'HEAD';
  if ((!ref.startsWith('refs/heads/') && ref !== 'HEAD') || (ref === 'HEAD' && !head))
    throw gitError('WORKTREE_CHANGED', '无法确认当前 Git 提交目标。');
  return { ref, head };
}

async function indexTree(git: LocalGit, signal?: AbortSignal) {
  const scratch = await mkdtemp(join(tmpdir(), 'atelier-commit-index-'));
  try {
    const index = join(git.admin, 'index');
    const info = await lstat(index).catch((error: unknown) => {
      if (!errorIs(error, 'ENOENT')) throw error;
    });
    if (info && !info.isFile()) throw gitError('WORKTREE_CHANGED', '当前 Git 索引无法安全读取。');
    const indexFile = join(scratch, 'index');
    if (info) await copyFile(index, indexFile);
    return gitOid.parse((await git.text(['write-tree'], { signal, indexFile })).trim());
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function capture(git: LocalGit, signal?: AbortSignal) {
  const target = await readTarget(git, signal);
  const [tree, identity] = await Promise.all([
    indexTree(git, signal),
    Promise.all([fileIdentity(git.root), fileIdentity(git.admin)]),
  ]);
  const after = await readTarget(git, signal);
  if (after.ref !== target.ref || after.head !== target.head) throw stale();
  const version = fingerprint(JSON.stringify([git.repositoryId, identity, target, tree]));
  return { ...target, tree, version };
}

function numstat(text: string): GitStagedFile[] {
  const entries = text.split('\0');
  if (entries.pop() !== '') throw gitError('OUTPUT_INVALID', '无法识别 Git 暂存区统计。');
  const files: GitStagedFile[] = [];
  for (let index = 0; index < entries.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(entries[index] ?? '');
    if (!match) throw gitError('OUTPUT_INVALID', '无法识别 Git 暂存区统计。');
    const [, added, removed, name] = match;
    files.push(
      gitStagedFile.parse({
        path: name || entries[index + 2],
        ...(name ? {} : { previousPath: entries[index + 1] }),
        added: added === '-' ? null : Number(added),
        removed: removed === '-' ? null : Number(removed),
      }),
    );
    if (!name) index += 2;
  }
  return files;
}

export async function readStagedChanges(
  git: LocalGit,
  includePatch: boolean,
  signal: AbortSignal,
): Promise<{ draft: GitCommitDraft; patch: string }> {
  await assertIdleGit(git);
  const snapshot = await capture(git, signal);
  const base = gitOid.parse(
    (snapshot.head
      ? await git.text(['rev-parse', snapshot.head + '^{tree}'], { signal })
      : await git.text(['hash-object', '-w', '-t', 'tree', '--stdin'], { signal })
    ).trim(),
  );
  if (base === snapshot.tree) throw gitError('COMMIT_EMPTY', '当前暂存区没有可提交的文件。');
  const fromTo = [base, snapshot.tree, '--'];
  const files = numstat(
    await git.text(['diff', ...diffFlags, '--numstat', '-z', ...fromTo], { signal }),
  );
  if (!files.length) throw gitError('COMMIT_EMPTY', '当前暂存区没有可提交的文件。');
  let patch = '';
  let partial = files.length > maxFiles;
  if (includePatch) {
    try {
      const bytes = await git.run(['diff', ...diffFlags, '--patch', '--unified=2', ...fromTo], {
        signal,
        maxBuffer: 256 * 1024,
      });
      const text = gitText(bytes);
      partial ||= text.length > maxPatchChars;
      patch = text.slice(0, maxPatchChars);
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        (error.code !== 'GIT_OUTPUT_LIMIT' && error.code !== 'GIT_ENCODING')
      )
        throw error;
      partial = true;
    }
  }
  return {
    patch,
    draft: {
      version: snapshot.version,
      branch: snapshot.ref === 'HEAD' ? null : snapshot.ref.slice('refs/heads/'.length),
      files: files.slice(0, maxFiles),
      fileCount: files.length,
      added: files.reduce((total, file) => total + (file.added ?? 0), 0),
      removed: files.reduce((total, file) => total + (file.removed ?? 0), 0),
      suggestion: null,
      partial,
    },
  };
}

async function withIndexLock<T>(git: LocalGit, work: () => Promise<T>) {
  const path = join(git.admin, 'index.lock');
  const lock = await open(path, 'wx', 0o600).catch((error: unknown) => {
    if (errorIs(error, 'EEXIST')) throw gitError('IN_PROGRESS', 'Git 暂存区正在被其他操作使用。');
    throw gitError('COMMIT_WRITE', '无法取得暂存区写锁。');
  });
  const identity = await lock.stat({ bigint: true }).catch(async (error: unknown) => {
    await lock.close();
    await unlink(path);
    throw error;
  });
  try {
    await assertIdleGit(git, true);
    return await work();
  } finally {
    await lock.close();
    const current = await lstat(path, { bigint: true }).catch((error: unknown) => {
      if (!errorIs(error, 'ENOENT')) throw error;
    });
    if (current?.dev === identity.dev && current.ino === identity.ino) await unlink(path);
  }
}

export async function commitStagedChanges(git: LocalGit, input: GitCommitRequest) {
  return withIndexLock(git, async () => {
    const snapshot = await capture(git);
    if (snapshot.version !== input.version) throw stale();
    if (
      snapshot.head &&
      snapshot.tree === (await git.text(['rev-parse', snapshot.head + '^{tree}'])).trim()
    )
      throw gitError('COMMIT_EMPTY', '当前暂存区没有可提交的文件。');
    const settings = { userCommitConfig: true };
    const signing = await git.text(['config', '--type=bool', '--get', 'commit.gpgSign'], {
      ...settings,
      allowExit: [1],
    });
    if (signing.trim() === 'true')
      throw gitError('COMMIT_SIGNING', '当前 Git 配置要求签名，请使用本机 Git 提交。');
    const identityFlags = ['-c', 'user.useConfigOnly=true'];
    try {
      await Promise.all(
        ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].map((key) =>
          git.text([...identityFlags, 'var', key], settings),
        ),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'GIT_COMMAND_FAILED')
        throw gitError('COMMIT_IDENTITY', '请为本机 Git 配置提交者姓名和邮箱。');
      throw error;
    }

    const body = input.body?.replace(/\r\n?/gu, '\n').trimEnd();
    const message = input.title + (body ? '\n\n' + body : '') + '\n';
    const oid = gitOid.parse(
      (
        await git.text(
          [
            ...identityFlags,
            'commit-tree',
            '--no-gpg-sign',
            snapshot.tree,
            ...(snapshot.head ? ['-p', snapshot.head] : []),
            '-F',
            '-',
          ],
          { ...settings, input: Buffer.from(message) },
        )
      ).trim(),
    );
    const target = await readTarget(git);
    if (target.ref !== snapshot.ref || target.head !== snapshot.head) throw stale();
    try {
      await git.run(
        [
          'update-ref',
          '--no-deref',
          '-m',
          'commit: ' + input.title,
          snapshot.ref,
          oid,
          snapshot.head ?? '0'.repeat(oid.length),
        ],
        settings,
      );
    } catch (error) {
      const current = await readTarget(git);
      if (current.ref !== target.ref || current.head !== target.head) throw stale();
      throw error;
    }
    return { oid };
  });
}

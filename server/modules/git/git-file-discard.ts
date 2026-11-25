/**
 * @file 丢弃所选 Git 文件层的改动。
 * @implementation 写入前复核变更范围，分别从索引或 HEAD 恢复，或者删除未跟踪文件。
 * @updated 2026-11-25T16:31:33+08:00
 */
import { lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitFileDiscardRequest } from '../../../shared/git-workbench.js';
import { gitError, type LocalGit } from './git-cli.js';
import { diffLayer, readGitStatus } from './git-reader.js';

function fileChanged() {
  return gitError('FILE_CHANGED', '文件状态已变化，请刷新 Git 看板。', 404);
}

export async function discardGitFiles(git: LocalGit, { targets }: GitFileDiscardRequest) {
  const { files, ignored } = await readGitStatus(git);
  const byPath = new Map<string, typeof files>();
  for (const file of files) {
    const entries = byPath.get(file.path) ?? [];
    entries.push(file);
    byPath.set(file.path, entries);
  }

  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();
  for (const { path, layer } of targets) {
    const file = byPath.get(path)?.find((entry) => diffLayer(entry, layer));
    if (!file) throw fileChanged();
    const code = layer === 'staged' ? file.index : file.worktree;
    const destination = layer === 'staged' ? staged : layer === 'unstaged' ? unstaged : untracked;
    destination.add(path);
    if (code === 'R' && file.previousPath) destination.add(file.previousPath);
  }

  const protectedPaths = [
    ...ignored,
    ...files.filter(({ kind }) => kind !== 'tracked').map(({ path }) => path.replace(/\/$/u, '')),
  ];
  for (const path of [...staged, ...unstaged]) {
    if (
      protectedPaths.some(
        (other) => other === path || other.startsWith(path + '/') || path.startsWith(other + '/'),
      )
    )
      throw fileChanged();
    const status = await lstat(join(git.root, path)).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return;
      throw fileChanged();
    });
    if (status?.isDirectory()) throw fileChanged();
  }

  const checkedUntrackedPath = async (path: string) => {
    const absolute = join(git.root, path);
    const parent = dirname(absolute);
    if ((await realpath(parent).catch(() => undefined)) !== parent) throw fileChanged();
    const status = await lstat(absolute).catch(() => undefined);
    if (!status || !(status.isFile() || status.isSymbolicLink())) throw fileChanged();
    return absolute;
  };
  for (const path of untracked) {
    if (byPath.get(path)?.some(({ kind }) => kind !== 'untracked')) throw fileChanged();
    await checkedUntrackedPath(path);
  }

  const restore = (options: string[], paths: Set<string>) =>
    git.run(['restore', ...options, '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: Buffer.from([...paths].join('\0') + '\0'),
    });
  if (staged.size) {
    const source =
      (await git.oid('HEAD')) ?? (await git.text(['hash-object', '-t', 'tree', '--stdin'])).trim();
    await restore(['--source=' + source, '--staged', '--worktree'], staged);
  }
  for (const path of staged) unstaged.delete(path);
  if (unstaged.size) await restore(['--worktree'], unstaged);
  for (const path of untracked) {
    const absolute = await checkedUntrackedPath(path);
    await unlink(absolute).catch(() => {
      throw fileChanged();
    });
  }
  return { updated: true as const };
}

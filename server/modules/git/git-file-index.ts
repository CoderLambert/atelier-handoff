/**
 * @file 更新所选 Git 文件的暂存状态。
 * @implementation 复核工作树状态后用字面路径更新索引，支持首次提交前取消暂存。
 * @updated 2026-11-25T13:32:26+08:00
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitFileIndexRequest } from '../../../shared/git-workbench.js';
import { gitError, type LocalGit } from './git-cli.js';
import { diffLayer, readGitStatus } from './git-reader.js';

export async function updateGitFileIndex(git: LocalGit, { path, layer }: GitFileIndexRequest) {
  const { files } = await readGitStatus(git, undefined, false);
  const file = files.find((entry) => entry.path === path && diffLayer(entry, layer));
  if (!file) throw gitError('FILE_CHANGED', '文件状态已变化，请刷新 Git 看板。', 404);

  const code = layer === 'staged' ? file.index : file.worktree;
  const paths = file.previousPath && code === 'R' ? [file.previousPath, path] : [path];
  if (layer === 'staged') {
    const head = await git.oid('HEAD');
    await git.run(
      head ? ['reset', '-q', head, '--', ...paths] : ['rm', '--cached', '-f', '--', ...paths],
    );
  } else if (layer === 'unstaged' && code !== 'R' && code !== 'C') {
    await git.run(['add', '-u', '--', ...paths]);
  } else {
    const target = await lstat(join(git.root, path)).catch(() => undefined);
    if (!target || target.isDirectory())
      throw gitError('FILE_CHANGED', '文件状态已变化，请刷新 Git 看板。', 404);
    await git.run(['add', '-A', '--', ...paths]);
  }
  return { updated: true as const };
}

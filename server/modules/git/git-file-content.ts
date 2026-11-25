/**
 * @file 读取 Git 差异所对应的完整文本版本。
 * @implementation 用项目路径策略限制范围，从工作树、索引或指定提交读取有界的普通 UTF-8 文件。
 * @updated 2026-11-25T16:50:00+08:00
 */
import { AppError } from '../../../shared/types.js';
import { gitOid, type GitWorkingFileSource } from '../../../shared/git-workbench.js';
import { MAX_TEXT, readProjectText, sensitiveProjectPath } from '../../files.js';
import { gitError, type LocalGit } from './git-cli.js';

export async function readGitFileContent(
  git: LocalGit,
  path: string,
  source: GitWorkingFileSource | { oid: string; parent: boolean },
  signal?: AbortSignal,
) {
  if (sensitiveProjectPath(path)) throw new AppError('PATH_DENIED', '无法打开受保护的文件。', 403);
  if (source === 'worktree') return { text: await readProjectText(git.root, path) };

  const options = { signal };
  const fromIndex = source === 'index';
  const ref = typeof source === 'object' ? source.oid + (source.parent ? '^1' : '') : 'HEAD';
  const commit = fromIndex ? undefined : await git.oid(ref, signal);
  const entries = fromIndex
    ? await git.text(['ls-files', '--stage', '-z', '--', path], options)
    : commit
      ? await git.text(['ls-tree', '-z', commit, '--', path], options)
      : '';
  const blob = entries.split('\0').flatMap((entry) => {
    const tab = entry.indexOf('\t');
    if (tab === -1 || entry.slice(tab + 1) !== path) return [];
    const match = (
      fromIndex ? /^100(?:644|755) ([a-f0-9]+) 0$/u : /^100(?:644|755) blob ([a-f0-9]+)$/u
    ).exec(entry.slice(0, tab));
    const oid = gitOid.safeParse(match?.[1]);
    return oid.success ? [oid.data] : [];
  })[0];
  if (!blob) throw new AppError('FILE_UNAVAILABLE', '此版本没有可预览的普通文件。', 404);
  const size = Number((await git.text(['cat-file', '-s', blob], options)).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TEXT)
    throw new AppError('FILE_TOO_LARGE', '文件超过文本预览大小限制。', 413);
  const bytes = await git.run(['cat-file', 'blob', blob], { signal, maxBuffer: MAX_TEXT });
  if (bytes.includes(0)) throw new AppError('BINARY_FILE', '该文件是二进制文件。', 415);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    throw new AppError('UNSUPPORTED_ENCODING', '该文件不是 UTF-8 文本。', 415);
  }
}

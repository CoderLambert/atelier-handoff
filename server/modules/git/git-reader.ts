/**
 * @file 读取 Git 工作树、分支、文件变化和提交历史。
 * @implementation 解析 Git 的 NUL 分隔协议，并在工作树实际状态中定位单个差异。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { createTwoFilesPatch } from 'diff';
import { normalize } from 'node:path';
import {
  gitOid,
  gitPath,
  type GitBranch,
  type GitDiff,
  type GitDiffLayer,
  type GitFile,
  type GitHistory,
  type GitOverview,
} from '../../../shared/git-workbench.js';
import { AppError } from '../../../shared/types.js';
import { fingerprint, readProjectText } from '../../files.js';
import { gitError, LocalGit } from './git-cli.js';

export interface ListedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
  missing: boolean;
}

export async function listGitWorktrees(
  git: LocalGit,
  signal?: AbortSignal,
): Promise<ListedWorktree[]> {
  const data = await git.text(['worktree', 'list', '--porcelain', '-z'], { signal });
  return data
    .split('\0\0')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\0');
      const path = lines.find((line) => line.startsWith('worktree '))?.slice(9);
      const ref = lines.find((line) => line.startsWith('branch refs/heads/'))?.slice(18);
      const head = gitOid.safeParse(lines.find((line) => line.startsWith('HEAD '))?.slice(5)).data;
      if (!path) throw gitError('OUTPUT_INVALID', '无法识别 Git 工作树记录。');
      return {
        path: normalize(path),
        head: head && !/^0+$/u.test(head) ? head : null,
        branch: ref ?? null,
        locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')),
        missing: lines.some((line) => line === 'prunable' || line.startsWith('prunable ')),
      };
    });
}

export async function readGitOverview(
  git: LocalGit,
  projectId: string,
  signal?: AbortSignal,
): Promise<GitOverview> {
  const [trees, refs] = await Promise.all([
    listGitWorktrees(git, signal),
    git.text(
      [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(symref)',
        'refs/heads',
        'refs/remotes',
      ],
      { signal },
    ),
  ]);
  const worktrees = trees.map((item) => ({
    id: item.path === git.root ? projectId : 'external-' + fingerprint(item.path),
    path: item.path,
    head: item.head,
    branch: item.branch,
    locked: item.locked,
    scope: item.path === git.root ? ('project' as const) : ('external' as const),
    state: item.missing ? ('missing' as const) : ('ready' as const),
  }));
  const occupied = new Map(
    worktrees.filter((item) => item.branch).map((item) => [item.branch, item.id]),
  );
  const branches: GitBranch[] = [];
  for (const line of refs.split('\n')) {
    const [ref, sha, symbolic] = line.split('\0');
    const oid = gitOid.safeParse(sha).data;
    if (!ref || !oid || symbolic) continue;
    const kind = ref.startsWith('refs/heads/') ? 'local' : 'remote';
    const name = ref.slice(kind === 'local' ? 11 : 13);
    const worktreeId = kind === 'local' ? occupied.get(name) : undefined;
    branches.push({ name, oid, kind, ...(worktreeId ? { worktreeId } : {}) });
  }
  return { worktrees, branches };
}

export async function readGitStatus(git: LocalGit, signal?: AbortSignal, showIgnored = true) {
  const records = (
    await git.text(
      [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
        ...(showIgnored ? ['--ignored=matching'] : []),
      ],
      { signal },
    )
  ).split('\0');
  const ignored: string[] = [];
  const files: GitFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('! ')) {
      ignored.push(gitPath.parse(record.slice(2).replace(/\/$/u, '')));
      continue;
    }
    if (record.startsWith('? ')) {
      const path = record.slice(2);
      // Git may report an embedded repository as a directory, not a readable file.
      gitPath.parse(path.replace(/\/$/u, ''));
      files.push({ path, index: '.', worktree: '?', kind: 'untracked' });
      continue;
    }
    const tag = record[0];
    const fields = tag === '1' ? 8 : tag === '2' ? 9 : tag === 'u' ? 10 : 0;
    if (!fields) throw gitError('OUTPUT_INVALID', '无法识别 Git 文件状态。');
    const header = record.match(new RegExp('^(?:[^ ]+ ){' + fields + '}', 'u'))?.[0];
    if (!header) throw gitError('OUTPUT_INVALID', '无法识别 Git 文件状态。');
    const path = gitPath.parse(record.slice(header.length));
    const previousPath = tag === '2' ? gitPath.parse(records[++i]) : undefined;
    files.push({
      path,
      index: record.charAt(2),
      worktree: record.charAt(3),
      kind: tag === 'u' ? 'conflict' : 'tracked',
      ...(previousPath ? { previousPath } : {}),
    });
  }
  return { files, ignored, rebuildable: [] as string[] };
}

export function diffLayer(file: GitFile, layer: GitDiffLayer) {
  if (file.kind !== 'tracked') return file.kind === layer;
  return layer === 'staged' ? file.index !== '.' : layer === 'unstaged' && file.worktree !== '.';
}
const displayOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none'];
const readableDiff = (text: string): GitDiff => ({
  text,
  binary: /^(?:Binary files |GIT binary patch)/mu.test(text),
});

export async function readFileDiff(
  git: LocalGit,
  path: string,
  layer: GitDiffLayer,
  signal?: AbortSignal,
) {
  const { files } = await readGitStatus(git, signal, false);
  const file = files.find((entry) => entry.path === path && diffLayer(entry, layer));
  if (!file) throw gitError('FILE_CHANGED', '文件状态已变化，请刷新 Git 看板。', 404);
  if (layer === 'untracked') {
    try {
      const text = await readProjectText(git.root, path);
      return readableDiff(createTwoFilesPatch('/dev/null', path, '', text));
    } catch (error) {
      if (error instanceof AppError && ['BINARY_FILE', 'UNSUPPORTED_ENCODING'].includes(error.code))
        return { binary: true, text: '' };
      throw error;
    }
  }
  return readableDiff(
    await git.text(
      [
        'diff',
        ...displayOptions,
        ...(layer === 'staged' ? ['--cached'] : layer === 'conflict' ? ['--cc'] : []),
        '--',
        ...(file.previousPath ? [file.previousPath] : []),
        file.path,
      ],
      { signal },
    ),
  );
}

export async function readGitHistory(
  git: LocalGit,
  oid: string,
  offset: number,
  signal?: AbortSignal,
): Promise<GitHistory> {
  if ((await git.oid(oid, signal)) !== oid) throw gitError('BASE_MISSING', '本机提交不可用。', 404);
  const pageSize = 25;
  const fields = (
    await git.text(
      [
        'log',
        '--format=%H%x00%an%x00%aI%x00%s',
        '-z',
        '--max-count=' + (pageSize + 1),
        '--skip=' + offset,
        oid,
        '--',
      ],
      { signal },
    )
  ).split('\0');
  const items: GitHistory['items'] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [sha, author, date, subject] = fields.slice(i, i + 4);
    if (sha && author !== undefined && date !== undefined && subject !== undefined)
      items.push({ oid: gitOid.parse(sha), author, date, subject });
  }
  return {
    items: items.slice(0, pageSize),
    nextOffset: items.length > pageSize ? offset + pageSize : null,
  };
}

export async function readCommitDiff(git: LocalGit, oid: string, signal?: AbortSignal) {
  if ((await git.oid(oid, signal)) !== oid) throw gitError('BASE_MISSING', '本机提交不可用。', 404);
  return readableDiff(
    await git.text(
      ['show', '--format=', '--diff-merges=first-parent', ...displayOptions, oid, '--'],
      { signal },
    ),
  );
}

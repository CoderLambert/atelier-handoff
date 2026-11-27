/**
 * @file 读取 Git 工作树、分支、文件变化和提交历史。
 * @implementation 解析 Git 的 NUL 分隔协议，并在工作树实际状态中定位单个差异。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { createTwoFilesPatch } from 'diff';
import { normalize } from 'node:path';
import {
  gitOid,
  gitPath,
  type GitBranch,
  type GitCommit,
  type GitDiff,
  type GitDiffLayer,
  type GitFile,
  type GitHistory,
  type GitHistoryQuery,
  type GitOverview,
} from '../../../shared/git-workbench.js';
import { AppError } from '../../../shared/errors.js';
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

/**
 * 解析 NUL 分隔的 Git 日志条目为结构化提交记录。
 */
export function parseGitLogRecords(raw: string): GitCommit[] {
  const fields = raw.split('\0');
  const items: GitCommit[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [sha, author, date, subject] = fields.slice(i, i + 4);
    if (sha && author !== undefined && date !== undefined && subject !== undefined) {
      items.push({ oid: gitOid.parse(sha), author, date, subject });
    }
  }
  return items;
}

const gitLogRecordFormat = '--format=%H%x00%an%x00%aI%x00%s';

/**
 * 封装结构化 Git 日志查询与记录解析，复用参数构建与容错逻辑。
 */
async function queryGitLogCommits(
  git: LocalGit,
  args: string[],
  options?: { signal?: AbortSignal; allowExit?: number[] },
): Promise<GitCommit[]> {
  try {
    const raw = await git.text(['log', gitLogRecordFormat, '-z', ...args], options);
    return parseGitLogRecords(raw);
  } catch {
    return [];
  }
}

/**
 * 转换时间范围快捷选项为 git log 对应的 --since 参数。
 */
export function resolveSinceArgument(since?: string): string | undefined {
  const s = since?.trim();
  if (!s || s === 'all') return undefined;
  if (s === '7d') return '--since=7 days ago';
  if (s === '30d') return '--since=30 days ago';
  return `--since=${s}`;
}

/**
 * 校验提交时间是否落在指定的时间跨度内。
 */
function isCommitWithinSince(dateStr: string, since?: string): boolean {
  const s = since?.trim();
  if (!s || s === 'all') return true;
  const commitTime = new Date(dateStr).getTime();
  if (Number.isNaN(commitTime)) return true;
  const now = Date.now();
  if (s === '7d') return commitTime >= now - 7 * 86400_000;
  if (s === '30d') return commitTime >= now - 30 * 86400_000;
  return true;
}

/**
 * 提取指定基准下最近的唯一作者列表。
 */
async function readRepositoryAuthors(
  git: LocalGit,
  oid: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const text = await git.text(['log', '--format=%an', '-n', '200', oid, '--'], {
      signal,
      allowExit: [1],
    });
    return Array.from(
      new Set(
        text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ).sort();
  } catch {
    return [];
  }
}

/**
 * 按短/长 Hash 前缀检索在指定基准历史中的可达提交。
 */
async function findAncestorCommitsByHash(
  git: LocalGit,
  oid: string,
  prefix: string,
  signal?: AbortSignal,
): Promise<GitCommit[]> {
  if (prefix.length < 4 || !/^[0-9a-fA-F]{4,64}$/.test(prefix)) return [];
  try {
    const shas = (
      await git.text(['rev-parse', `--disambiguate=${prefix}`], { signal, allowExit: [1] })
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const matches: GitCommit[] = [];
    for (const sha of shas) {
      const mb = (await git.text(['merge-base', sha, oid], { signal, allowExit: [1] })).trim();
      if (mb === sha) {
        matches.push(
          ...(await queryGitLogCommits(git, ['-1', sha, '--'], { signal, allowExit: [1] })),
        );
      }
    }
    return matches;
  } catch {
    return [];
  }
}

export async function readGitHistory(
  git: LocalGit,
  oid: string,
  offset: number,
  options?: GitHistoryQuery,
  signal?: AbortSignal,
): Promise<GitHistory> {
  if ((await git.oid(oid, signal)) !== oid) throw gitError('BASE_MISSING', '本机提交不可用。', 404);
  const pageSize = 25;
  const query = options?.query?.trim();
  const author = options?.author?.trim();
  const sinceArg = resolveSinceArgument(options?.since);
  const sinceArgs = sinceArg ? [sinceArg] : [];

  // Fast path: 无关键词搜索、无作者筛选且无时间范围限制时直接按游标分页
  if (!query && (!author || author === 'all') && sinceArgs.length === 0) {
    const items = await queryGitLogCommits(
      git,
      [`--max-count=${pageSize + 1}`, `--skip=${offset}`, oid, '--'],
      { signal },
    );
    const authors = offset === 0 ? await readRepositoryAuthors(git, oid, signal) : undefined;

    return {
      items: items.slice(0, pageSize),
      nextOffset: items.length > pageSize ? offset + pageSize : null,
      authors,
    };
  }

  // Filtered path: 聚合 Hash 前缀精确匹配与说明/作者文本检索
  const commitMap = new Map<string, GitCommit>();

  // 1. Commit Hash 前缀匹配
  if (query) {
    const hashMatches = await findAncestorCommitsByHash(git, oid, query, signal);
    for (const commit of hashMatches) {
      const matchAuthor =
        !author || author === 'all' || commit.author.toLowerCase().includes(author.toLowerCase());
      const matchSince = isCommitWithinSince(commit.date, options?.since);
      if (matchAuthor && matchSince) {
        commitMap.set(commit.oid, commit);
      }
    }
  }

  // 2. 构造日志筛选条件（--grep、--author、--since）
  const logRuns: string[][] = [];
  if (author && author !== 'all') {
    const runArgs = [...sinceArgs, `--author=${author}`];
    if (query) runArgs.push(`--grep=${query}`, '-F', '-i');
    logRuns.push(runArgs);
  } else if (query) {
    logRuns.push([...sinceArgs, `--grep=${query}`, '-F', '-i']);
    logRuns.push([...sinceArgs, `--author=${query}`, '-i']);
  } else {
    logRuns.push([...sinceArgs]);
  }

  for (const runArgs of logRuns) {
    const commits = await queryGitLogCommits(
      git,
      ['--max-count=300', ...runArgs, oid, '--'],
      { signal, allowExit: [1] },
    );
    for (const commit of commits) {
      commitMap.set(commit.oid, commit);
    }
  }

  const allSorted = Array.from(commitMap.values()).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  const authors = offset === 0 ? await readRepositoryAuthors(git, oid, signal) : undefined;

  return {
    items: allSorted.slice(offset, offset + pageSize),
    nextOffset: allSorted.length > offset + pageSize ? offset + pageSize : null,
    totalCount: allSorted.length,
    authors,
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

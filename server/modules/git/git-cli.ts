/**
 * @file 调用系统 Git 并识别已授权的仓库和检出目录。
 * @implementation 使用参数数组与受限环境。提交时按需读取本机 Git 身份和签名偏好，限制外部程序和访网。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { devNull, homedir } from 'node:os';
import { join, normalize } from 'node:path';
import { gitOid, type GitStartPoint } from '../../../shared/git-workbench.js';
import { AppError } from '../../../shared/errors.js';
import { resolveProjectPath } from '../../files.js';

const config = [
  'core.hooksPath=' + devNull,
  'core.fsmonitor=false',
  'core.attributesFile=' + devNull,
  'protocol.allow=never',
  'submodule.recurse=false',
  'maintenance.auto=false',
  'gc.auto=0',
  'core.quotePath=true',
  'color.ui=false',
].flatMap((entry) => ['-c', entry]);
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1',
};
export const gitError = (code: string, message: string, status = 409) =>
  new AppError('GIT_' + code, message, status);

interface GitOptions {
  signal?: AbortSignal;
  input?: Buffer;
  maxBuffer?: number;
  allowExit?: readonly number[];
  indexFile?: string;
  userCommitConfig?: boolean;
}
function processCode(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error) return error.code;
}

async function gitProcess(
  root: string,
  args: readonly string[],
  filters: readonly string[],
  options: GitOptions,
) {
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        'git',
        ['--no-pager', ...config, ...filters, '-C', root, ...args],
        {
          env: {
            ...env,
            ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
            ...(options.userCommitConfig
              ? {
                  HOME: homedir(),
                  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
                  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
                }
              : {}),
          },
          encoding: 'buffer',
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
          signal: options.signal,
        },
        (error, stdout) => {
          if (!error || (typeof error.code === 'number' && options.allowExit?.includes(error.code)))
            resolve(stdout);
          else reject(error);
        },
      );
      // Git can exit before consuming stdin on a failed check; its exit status owns the error.
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.input);
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    const code = processCode(error);
    if (code === 'ENOENT') throw gitError('UNAVAILABLE', '未找到本机 Git。', 503);
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      throw gitError('OUTPUT_LIMIT', 'Git 输出超过工作台读取上限。', 413);
    throw gitError('COMMAND_FAILED', 'Git 无法完成操作，请检查仓库状态。');
  }
}

export function gitText(bytes: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw gitError('ENCODING', 'Git 输出包含无法读取的路径或文本。');
  }
}

export async function fileIdentity(path: string) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || (await realpath(path)) !== path)
    throw gitError('WORKTREE_CHANGED', 'Git 目录已移动或不可用。');
  return stat.dev + ':' + stat.ino;
}

async function filterOverrides(root: string, signal?: AbortSignal) {
  const keys = gitText(
    await gitProcess(
      root,
      ['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\.'],
      [],
      { signal, allowExit: [1] },
    ),
  ).split('\0');
  const drivers = new Set<string>();
  for (const key of keys) {
    const driver = /^(filter\..+)\.(?:clean|smudge|process|required)$/u.exec(key)?.[1];
    if (!driver) continue;
    if (/[=\r\n]/u.test(driver))
      throw gitError('UNSAFE_CONFIG', '仓库配置包含无法安全禁用的 Git 过滤器。');
    drivers.add(driver);
  }
  return Array.from(drivers).flatMap((name) =>
    ['clean=', 'smudge=', 'process=', 'required=false'].flatMap((entry) => [
      '-c',
      name + '.' + entry,
    ]),
  );
}

export class LocalGit {
  private constructor(
    readonly root: string,
    readonly common: string,
    readonly admin: string,
    readonly repositoryId: string,
    private readonly filters: readonly string[],
  ) {}

  static async open(root: string, signal?: AbortSignal) {
    await resolveProjectPath(root, '', { directory: true });
    const metadata = await lstat(join(root, '.git')).catch(() => undefined);
    if (!metadata || (!metadata.isDirectory() && !metadata.isFile()))
      throw gitError('NOT_REPOSITORY', '此项目目录不是 Git 检出根目录。', 404);
    const probe = async (...args: string[]) =>
      gitText(await gitProcess(root, ['rev-parse', ...args], [], { signal })).replace(
        /\r?\n$/u,
        '',
      );
    const top = normalize(await probe('--show-toplevel'));
    if (root !== top) throw gitError('NOT_REPOSITORY', '此项目目录不是 Git 检出根目录。', 404);
    const common = await realpath(await probe('--path-format=absolute', '--git-common-dir'));
    const admin = await realpath(await probe('--absolute-git-dir'));
    const repositoryId = common + '\0' + (await fileIdentity(common));
    return new LocalGit(root, common, admin, repositoryId, await filterOverrides(root, signal));
  }

  run(args: readonly string[], options: GitOptions = {}) {
    return gitProcess(this.root, args, this.filters, options);
  }

  async text(args: readonly string[], options?: GitOptions) {
    return gitText(await this.run(args, options));
  }

  async oid(ref: string, signal?: AbortSignal) {
    const result = (
      await this.text(['rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}'], {
        signal,
        allowExit: [1],
      })
    ).trim();
    return gitOid.safeParse(result).data;
  }

  async startPoint(base: GitStartPoint) {
    const ref =
      base.kind === 'head' ? 'HEAD' : base.kind === 'branch' ? 'refs/heads/' + base.name : base.oid;
    const oid = await this.oid(ref);
    if (!oid || (base.kind === 'commit' && oid !== base.oid))
      throw gitError('BASE_MISSING', '找不到所选的本机基线提交。');
    return oid;
  }

  async checkNewBranch(branch: string) {
    if (branch === 'HEAD') throw gitError('INVALID_BRANCH', '请输入有效的 Git 分支名。', 400);
    try {
      await this.run(['check-ref-format', 'refs/heads/' + branch]);
    } catch (error) {
      if (error instanceof AppError && error.code === 'GIT_COMMAND_FAILED')
        throw gitError('INVALID_BRANCH', '请输入有效的 Git 分支名。', 400);
      throw error;
    }
    const existing = (
      await this.text(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'])
    ).split('\n');
    if (
      existing.some(
        (name) => name === branch || name.startsWith(branch + '/') || branch.startsWith(name + '/'),
      )
    )
      throw gitError('BRANCH_EXISTS', '分支名已被使用，请输入新名称。');
  }
}

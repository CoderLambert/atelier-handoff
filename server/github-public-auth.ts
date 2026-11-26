/**
 * @file 使用本机 GitHub CLI 访问公开仓库的 Git 元数据。
 * @implementation 限制到只读 GitHub API 与公开仓库，CLI 保有凭据，raw 文件使用匿名传输。
 * @updated 2026-11-26T15:40:00+08:00
 */
import { execFile } from 'node:child_process';
import { delimiter, isAbsolute } from 'node:path';
import { z } from 'zod';
import { githubLogin } from '../shared/github-public-auth.js';
import { AppError } from '../shared/types.js';

const ghError = () =>
  new AppError('GITHUB_LOGIN_REQUIRED', '请先通过 GitHub CLI 登录 github.com，再连接。', 401);
const repository = z.object({ private: z.literal(false), visibility: z.literal('public') });
const safeRoute =
  /^\/repos\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/(?:commits\/[^/]+|git\/trees\/[a-f0-9]{40})$/u;

function cli(endpoint: string, signal?: AbortSignal): Promise<Response> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
  };
  for (const name of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GH_REPO',
  ])
    delete env[name];
  env.PATH = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).join(delimiter);
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', '--hostname', 'github.com', '--method', 'GET', '--include', endpoint],
      {
        env,
        signal,
        timeout: 12_000,
        maxBuffer: 13 * 1024 * 1024,
        encoding: 'buffer',
      },
      (error, stdout) => {
        if (signal?.aborted || (error && typeof error.code !== 'number')) {
          reject(signal?.reason ?? ghError());
          return;
        }
        const end = stdout.indexOf('\r\n\r\n');
        // gh prints the status line with LF even when the HTTP header block uses CRLF.
        const headerEnd = end === -1 ? stdout.indexOf('\n\n') : end;
        const status = Number(/^HTTP\/\S+ (\d{3})/u.exec(stdout.subarray(0, 30).toString())?.[1]);
        if (headerEnd < 0 || status < 200 || status > 599 || !Number.isInteger(status)) {
          reject(ghError());
          return;
        }
        const headers = new Headers();
        for (const line of stdout.subarray(0, headerEnd).toString().split(/\r?\n/u)) {
          const [name, value] = line.split(/:\s*/, 2);
          if (
            name &&
            value &&
            ['retry-after', 'x-ratelimit-remaining'].includes(name.toLowerCase())
          )
            headers.set(name, value);
        }
        const payload = stdout.subarray(headerEnd + (end === -1 ? 2 : 4));
        resolve(
          new Response([204, 205, 304].includes(status) ? null : new Uint8Array(payload), {
            status,
            headers,
          }),
        );
      },
    );
  });
}

type GithubCli = typeof cli;

export async function currentGithubLogin(signal?: AbortSignal, invoke: GithubCli = cli) {
  const response = await invoke('/user', signal);
  if (!response.ok) throw ghError();
  const account = z.object({ login: githubLogin }).safeParse(await response.json());
  if (!account.success) throw ghError();
  return account.data.login;
}

export function authenticatedGithubFetch(
  login: string,
  fallback: typeof fetch,
  invoke: GithubCli = cli,
): typeof fetch {
  let checked: Promise<void> | undefined;
  return async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://api.github.com') return fallback(input, options);
    if (!safeRoute.test(url.pathname) || (url.search && url.search !== '?recursive=1'))
      throw new AppError('PUBLIC_SOURCE_INVALID', 'GitHub 导入元数据地址无效。');
    const signal = options?.signal ?? undefined;
    checked ??= (async () => {
      if ((await currentGithubLogin(signal, invoke)).toLowerCase() !== login.toLowerCase())
        throw ghError();
      const repoPath = url.pathname.split('/').slice(0, 4).join('/');
      const metadata = await invoke(repoPath, signal);
      if (!metadata.ok || !repository.safeParse(await metadata.json()).success)
        throw new AppError('GITHUB_PUBLIC_REPO_REQUIRED', '请选择公开 GitHub 仓库。', 404);
    })();
    await checked;
    return invoke(url.pathname + url.search, signal);
  };
}

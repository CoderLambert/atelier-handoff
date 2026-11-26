/**
 * @file 读取已绑定项目的 Git 分支标识。
 * @implementation 普通仓库读取 HEAD；链接工作树在受限环境调用 Git；缺失或无效时返回空分支。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function branchFor(root: string): Promise<string> {
  try {
    const git = join(root, '.git');
    const metadata = await lstat(git);
    if (
      metadata.isFile() &&
      metadata.size <= 4096 &&
      (await readFile(git, 'utf8')).startsWith('gitdir: ')
    ) {
      const options = {
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        timeout: 1500,
        maxBuffer: 4096,
      };
      try {
        return (
          await exec('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD'], options)
        ).stdout.trim();
      } catch {
        await exec('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], options);
        return 'detached';
      }
    }
    if (!metadata.isDirectory() || (await lstat(join(git, 'HEAD'))).isSymbolicLink()) return '';
    const head = (await readFile(join(git, 'HEAD'), 'utf8')).trim();
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : 'detached';
  } catch {
    return '';
  }
}

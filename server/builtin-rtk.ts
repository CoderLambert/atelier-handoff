/**
 * @file 验证 Linux RTK 资源并为单次原生 SDK 运行装载内置 Hook。
 * @implementation 校验二进制摘要、启动器内容和执行位，固定命令映射随运行写入独立插件目录。轨迹仅从匹配实际命令的 SDK 回执产生。
 * @updated 2026-11-26T12:00:00+08:00
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { rtkLauncher, rtkRelease } from '../shared/builtin-rtk.js';
import type { RtkTrace } from '../shared/rtk-trace.js';

let verified: { binary: string; identity: string } | undefined;

export function builtinRtkLauncher(binary: string): string {
  return join(dirname(binary), 'bin', 'rtk');
}

export async function builtinRtkAvailable(binary?: string): Promise<boolean> {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !binary || !isAbsolute(binary))
    return false;
  const launcher = builtinRtkLauncher(binary);
  try {
    const entries = await Promise.all(
      [binary, launcher].map(async (path) => {
        const stat = await lstat(path, { bigint: true });
        if (!stat.isFile() || (stat.mode & 0o111n) === 0n)
          throw new Error('RTK resource unavailable');
        await access(path, constants.X_OK);
        return [stat.dev, stat.ino, stat.size, stat.ctimeNs].join(':');
      }),
    );
    const identity = entries.join('/');
    if (verified?.binary === binary && verified.identity === identity) return true;
    if ((await readFile(launcher, 'utf8')) !== rtkLauncher) return false;
    const file = await open(
      binary,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== rtkRelease.binarySha256) return false;
    } finally {
      await file.close();
    }
    verified = { binary, identity };
    return true;
  } catch {
    return false;
  }
}

export async function mountBuiltinRtkPlugin(scratch: string): Promise<string> {
  const root = await mkdtemp(join(scratch, 'builtin-rtk-'));
  const hooks = join(root, 'hooks');
  const manifest = join(root, '.claude-plugin');
  await Promise.all([mkdir(hooks), mkdir(manifest), mkdir(join(root, 'plans'), { mode: 0o700 })]);
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const moduleName = `register.${extension}`;
  await Promise.all([
    copyFile(new URL(`./rtk-plugin/${moduleName}`, import.meta.url), join(hooks, moduleName)),
    writeFile(
      join(manifest, 'plugin.json'),
      JSON.stringify({
        name: 'atelier-builtin-rtk',
        version: '1.0.0',
        description: 'Bundled RTK Bash output compression',
      }),
    ),
    writeFile(join(hooks, 'hooks.json'), JSON.stringify({ modules: [`./${moduleName}`] })),
  ]);
  return root;
}

export function publishBuiltinRtkPlan(
  plugin: string,
  toolUseId: string,
  plan: RtkTrace,
): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(toolUseId)) return Promise.resolve(false);
  return writeFile(join(plugin, 'plans', toolUseId + '.json'), JSON.stringify(plan), {
    mode: 0o600,
    flag: 'wx',
  }).then(
    () => true,
    () => false,
  );
}

export function confirmedRtkTrace(
  plan: RtkTrace | undefined,
  input: unknown,
): RtkTrace | undefined {
  if (
    plan &&
    input &&
    typeof input === 'object' &&
    'command' in input &&
    input.command === plan.executedCommand
  )
    return plan;
  return undefined;
}

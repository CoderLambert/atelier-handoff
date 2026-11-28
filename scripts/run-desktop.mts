/**
 * @file 启动开发桌面并跟随当前 Git 检出构建。
 * @implementation 首次构建后启动 Electron，串行采样稳定的 HEAD。检出变化时重建并提示重启，Electron 退出后结束监听。
 * @updated 2026-12-08T12:00:00+00:00
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const root = process.cwd();
const require = createRequire(join(root, 'package.json'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Start this launcher with npm run desktop.');

const exec = promisify(execFile);
async function git(...args: string[]) {
  try {
    return (await exec('git', args, { cwd: root, timeout: 3_000 })).stdout.trimEnd();
  } catch {
    return undefined;
  }
}

const gitDir = await git('rev-parse', '--absolute-git-dir');
const gitChanges = ['index.lock', 'MERGE_HEAD', 'rebase-apply', 'rebase-merge'];
async function revision() {
  const head = await git('rev-parse', '--verify', 'HEAD');
  return gitDir && head && !gitChanges.some((name) => existsSync(join(gitDir, name)))
    ? head
    : undefined;
}

const controller = new AbortController();
const children = new Set<ChildProcess>();
function run(...args: string[]) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  children.add(child);
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      children.delete(child);
      resolve(code ?? 1);
    });
  });
}

function stop(signal: 'SIGINT' | 'SIGTERM') {
  controller.abort();
  for (const child of children) child.kill(signal);
}
const interrupt = () => stop('SIGINT');
const terminate = () => stop('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);

async function watch(initial: string | undefined, build: () => Promise<number>) {
  let attempted = initial;
  let candidate: string | undefined;
  while (!controller.signal.aborted) {
    await delay(750, undefined, { signal: controller.signal }).catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
    if (controller.signal.aborted) break;
    const head = await revision();
    if (controller.signal.aborted) break;
    if (head && head === candidate && head !== attempted) {
      attempted = head;
      console.log(`[desktop] Git checkout updated to ${head.slice(0, 12)}. Rebuilding…`);
      if ((await build()) === 0)
        console.log('[desktop] Rebuild complete. Restart the desktop to load the new version.');
      else console.error('[desktop] Rebuild failed. Retry with npm run desktop:build.');
    }
    candidate = head;
  }
}

try {
  const initial = gitDir ? await revision() : undefined;
  const build = () => run(npm, 'run', 'desktop:build');
  if (!controller.signal.aborted) {
    process.exitCode = await build();
    if (process.exitCode === 0 && !controller.signal.aborted) {
      const desktop = run(
        require.resolve('electron/cli.js'),
        'dist/desktop/main.mjs',
        ...process.argv.slice(2),
      );
      const windowClosed = desktop.finally(() => controller.abort());
      const [code] = await Promise.all([windowClosed, gitDir ? watch(initial, build) : undefined]);
      process.exitCode = code;
    }
  }
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}

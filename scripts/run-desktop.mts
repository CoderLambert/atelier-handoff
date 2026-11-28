/**
 * @file 启动开发桌面并跟随当前 Git 检出构建。
 * @implementation 串行采样 Git HEAD 并构建。成功后请求空闲重启，沿用 Electron 确认的端口和启动参数。
 * @updated 2026-12-08T12:00:00+00:00
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  developmentRestartAccepted,
  developmentRestartRequest,
} from '../shared/desktop-development-restart.js';

const root = process.cwd();
const require = createRequire(join(root, 'package.json'));
const npmPath = process.env.npm_execpath;
if (!npmPath) throw new Error('Start this launcher with npm run desktop.');
const npm = npmPath;

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
function untilClosed(child: ChildProcess) {
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
function build() {
  return untilClosed(
    spawn(process.execPath, [npm, 'run', 'desktop:build'], { cwd: root, stdio: 'inherit' }),
  );
}

let attempted = gitDir ? await revision() : undefined;
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
const restart = developmentRestartRequest.parse({ type: 'atelier-dev:restart' });

async function watch(desktop: ChildProcess, signal: AbortSignal) {
  let candidate: string | undefined;
  let built: string | undefined;
  while (!signal.aborted) {
    await delay(750, undefined, { signal }).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
    if (signal.aborted) break;
    const head = await revision();
    if (signal.aborted) break;
    if (head && head === candidate) {
      if (head !== attempted) {
        attempted = head;
        built = undefined;
        console.log(`[desktop] Git checkout updated to ${head.slice(0, 12)}. Rebuilding…`);
        if ((await build()) === 0) {
          built = head;
          console.log('[desktop] Rebuild complete. The desktop will restart when idle.');
        } else console.error('[desktop] Rebuild failed. The current instance remains open.');
      } else if (head === built && desktop.connected) {
        desktop.send(restart, () => {});
      }
    }
    candidate = head;
  }
}

try {
  if (!controller.signal.aborted) process.exitCode = await build();
  if (process.exitCode === 0 && !controller.signal.aborted) {
    const executable: unknown = require('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    let port = process.env.ATELIER_PORT;
    do {
      console.log('[desktop] Starting Electron…');
      const desktop = spawn(executable, ['dist/desktop/main.mjs', ...process.argv.slice(2)], {
        cwd: root,
        env: { ...process.env, ATELIER_DEV_LAUNCH: '1', ...(port ? { ATELIER_PORT: port } : {}) },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      let restartPort: string | undefined;
      desktop.on('message', (input: unknown) => {
        const result = developmentRestartAccepted.safeParse(input);
        if (result.success) restartPort = String(result.data.port);
      });
      const ended = new AbortController();
      const closed = untilClosed(desktop).finally(() => ended.abort());
      const [code] = await Promise.all([
        closed,
        gitDir ? watch(desktop, AbortSignal.any([controller.signal, ended.signal])) : undefined,
      ]);
      process.exitCode = code;
      if (code !== 0 || !restartPort) break;
      port = restartPort;
    } while (!controller.signal.aborted);
  }
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}

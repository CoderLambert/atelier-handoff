/**
 * @file 在隔离 Electron 中验证挂起浏览器工具的取消与后续导航。
 * @implementation 临时编译真实控制器和故障夹具，用独立 Xvfb、profile 及本地网页运行有时限的回归，退出时清理测试子进程。
 * @updated 2026-11-20T21:57:13+08:00
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Run from the checkout; no installed app, SDK, gateway, or real user data is used:
// node --import tsx scripts/smoke-browser-cancellation.mts --xvfb /path/to/Xvfb
// This exercises explicit cancellation, the real 30s input deadline, and a slow HTTP navigation.
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === '--xvfb' && args[1]),
  'Usage: node --import tsx scripts/smoke-browser-cancellation.mts [--xvfb /path/to/Xvfb]',
);
assert.equal(process.platform, 'linux', 'This standalone smoke uses Linux Xvfb.');
const source = fileURLToPath(new URL('../', import.meta.url));
const xvfbPath = resolve(args[1] ?? '/usr/bin/Xvfb');
const electronPath = join(source, 'node_modules/electron/dist/electron');
await Promise.all([access(xvfbPath, constants.X_OK), access(electronPath, constants.X_OK)]);
const root = await mkdtemp(join(tmpdir(), 'atelier-browser-cancel-'));
let xvfb: ChildProcess | undefined;
let electron: ChildProcess | undefined;
let diagnostics = '';

function exited(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = exited(child);
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try {
    await stopped;
  } finally {
    clearTimeout(timer);
  }
}

try {
  await Promise.all(
    ['profile', 'downloads', 'config', 'cache', 'runtime'].map((name) =>
      mkdir(join(root, name), { mode: 0o700 }),
    ),
  );
  const fixture = join(root, 'fixture.mjs');
  await build({
    absWorkingDir: source,
    entryPoints: ['scripts/browser-cancel-smoke/app.mts'],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    external: ['electron'],
    logLevel: 'silent',
  });
  // -displayfd allocates a free display, avoiding an existing user's X server.
  xvfb = spawn(
    xvfbPath,
    [
      '-displayfd',
      '1',
      '-screen',
      '0',
      '1280x800x24',
      '-nolisten',
      'tcp',
      '-ac',
      '-extension',
      'GLX',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const display = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Xvfb readiness exceeded 5s.')), 5000);
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    let text = '';
    xvfb?.once('error', (error) => finish(error));
    xvfb?.once('exit', (code, signal) =>
      finish(new Error(`Xvfb exited before readiness: ${code}/${signal}`)),
    );
    xvfb?.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      const match = /^(\d+)\n/u.exec(text);
      if (match?.[1]) finish(undefined, `:${match[1]}`);
    });
    xvfb?.stderr?.on('data', (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-16_384);
    });
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: display,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(
    electronPath,
    [fixture, root, '--ozone-platform=x11', '--disable-gpu', '--disable-dev-shm-usage'],
    { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  electron.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  electron.stderr?.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-16_384);
  });
  // Even a regressed controller or fixture must terminate with a useful failure.
  const watchdog = setTimeout(() => electron?.kill('SIGKILL'), 50_000);
  try {
    const result = await exited(electron);
    assert.deepEqual(result, { code: 0, signal: null }, diagnostics);
  } finally {
    clearTimeout(watchdog);
  }
} finally {
  await stop(electron);
  await stop(xvfb);
  await rm(root, { recursive: true, force: true });
}

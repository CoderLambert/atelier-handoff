/**
 * @file 在 Linux 隔离目录中执行受控命令。
 * @implementation 探测 bubblewrap，以传入目录挂载工作区，递归遮蔽凭据和 Git 元数据并限制网络、时间及输出。
 * @updated 2026-11-27T11:46:00-06:00
 */
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '../shared/errors.js';
import { isSensitiveCredentialName } from './files.js';

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_MASK_DEPTH = 8;
const MAX_MASK_ENTRIES = 512;
const SKIP_SCAN_DIRS = new Set(['node_modules', 'dist', '.cache']);

function systemMountArgs(): string[] {
  const args = ['--ro-bind', '/usr', '/usr'];
  for (const dir of ['/bin', '/lib', '/lib64']) {
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) args.push('--symlink', readlinkSync(dir), dir);
    else if (stat.isDirectory()) args.push('--ro-bind', dir, dir);
  }
  return args;
}

function collectSensitiveMountArgs(root: string): string[] {
  const args: string[] = [];
  let count = 0;
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > MAX_MASK_DEPTH || count >= MAX_MASK_ENTRIES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_MASK_ENTRIES) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isSensitiveCredentialName(entry.name)) {
        if (entry.isDirectory()) {
          args.push('--tmpfs', '/workspace/' + rel);
          count++;
        } else if (entry.isFile()) {
          args.push('--ro-bind', '/dev/null', '/workspace/' + rel);
          count++;
        }
        continue;
      }
      if (entry.isDirectory() && !SKIP_SCAN_DIRS.has(entry.name)) {
        walk(join(dir, entry.name), rel, depth + 1);
      }
    }
  };
  walk(root, '', 0);
  return args;
}

function trimIncompleteUtf8Tail(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let continuations = 0;
  while (i >= 0 && continuations < 3 && (buf[i]! & 0xc0) === 0x80) {
    continuations++;
    i--;
  }
  if (i < 0) return buf;
  const lead = buf[i]!;
  let expected = 1;
  if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  return continuations + 1 < expected ? buf.subarray(0, i) : buf;
}

let supported: boolean | undefined;
export function commandsAvailable(): boolean {
  if (supported !== undefined) return supported;
  if (process.platform !== 'linux') return (supported = false);
  const probe = spawnSync(
    'bwrap',
    ['--unshare-all', ...systemMountArgs(), '--proc', '/proc', '--dev', '/dev', '/usr/bin/true'],
    { timeout: 3000, stdio: 'ignore' },
  );
  return (supported = probe.status === 0);
}
export async function runCommand(
  root: string,
  command: string,
  signal: AbortSignal,
): Promise<{ output: string; code: number | null; truncated: boolean }> {
  if (!commandsAvailable())
    throw new AppError(
      'COMMANDS_UNAVAILABLE',
      '此机器未启用可用的 bubblewrap 命令隔离，首版不会退回无限制 shell。',
      409,
    );
  signal.throwIfAborted();
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--clearenv',
    ...systemMountArgs(),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/home',
    '--bind',
    root,
    '/workspace',
    '--ro-bind',
    dirname(dirname(process.execPath)),
    '/opt/node',
    '--setenv',
    'PATH',
    '/opt/node/bin:/usr/bin:/bin',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--chdir',
    '/workspace',
    ...collectSensitiveMountArgs(root),
  ];
  args.push('/bin/sh', '-c', command);
  return new Promise((resolve, reject) => {
    const child = spawn('bwrap', args, {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let killed = false;
    const append = (chunk: Buffer) => {
      if (totalBytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_OUTPUT_BYTES - totalBytes;
      if (chunk.length > remaining) {
        truncated = true;
        chunks.push(chunk.subarray(0, remaining));
        totalBytes = MAX_OUTPUT_BYTES;
      } else {
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      killed = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
      }
      force = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }
      }, 1000);
    };
    const timer = setTimeout(kill, 60000);
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(force);
      signal.removeEventListener('abort', kill);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      signal.removeEventListener('abort', kill);
      if (signal.aborted) reject(new AppError('RUN_STOPPED', '命令已随运行停止。', 409));
      else {
        const raw = Buffer.concat(chunks);
        const output = new TextDecoder('utf-8', { fatal: false }).decode(
          truncated ? trimIncompleteUtf8Tail(raw) : raw,
        );
        resolve({
          output:
            output +
            (truncated ? '\n[输出超过 64 KiB，已截断]' : '') +
            (killed ? '\n[命令超过 60 秒已终止]' : ''),
          code,
          truncated,
        });
      }
    });
  });
}

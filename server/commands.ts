import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '../shared/types.js';

let supported: boolean | undefined;
export function commandsAvailable(): boolean {
  if (supported !== undefined) return supported;
  if (process.platform !== 'linux') return supported = false;
  const probe = spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64', '--proc', '/proc', '--dev', '/dev', '/usr/bin/true'], { timeout: 3000, stdio: 'ignore' });
  return supported = probe.status === 0;
}
export async function runCommand(root: string, command: string, signal: AbortSignal): Promise<{ output: string; code: number | null; truncated: boolean }> {
  if (!commandsAvailable()) throw new AppError('COMMANDS_UNAVAILABLE', '此机器未启用可用的 bubblewrap 命令隔离，首版不会退回无限制 shell。', 409);
  signal.throwIfAborted();
  const args = ['--die-with-parent', '--new-session', '--unshare-all', '--clearenv', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home', '--bind', root, '/workspace', '--ro-bind', dirname(dirname(process.execPath)), '/opt/node', '--setenv', 'PATH', '/opt/node/bin:/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--chdir', '/workspace'];
  // Hide application state and common credentials at the project root inside commands.
  for (const name of ['.data', '.local', '.git', '.claude', '.codex', '.ssh', '.aws']) if (existsSync(join(root, name))) args.push('--tmpfs', '/workspace/' + name);
  for (const name of ['.env', '.env.local', '.env.production', '.env.development', '.npmrc', '.netrc']) if (existsSync(join(root, name))) args.push('--ro-bind', '/dev/null', '/workspace/' + name);
  args.push('/bin/sh', '-c', command);
  return new Promise((resolve, reject) => {
    const child = spawn('bwrap', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = ''; let truncated = false; let killed = false;
    const append = (chunk: Buffer) => { if (output.length + chunk.length > 64 * 1024) truncated = true; output = (output + chunk.toString()).slice(0, 64 * 1024); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      killed = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 1000);
    };
    const timer = setTimeout(kill, 60000);
    signal.addEventListener('abort', kill, { once: true }); if (signal.aborted) kill();
    child.once('error', error => { clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', kill); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', kill);
      if (signal.aborted) reject(new AppError('RUN_STOPPED', '命令已随运行停止。', 409));
      else resolve({ output: output + (truncated ? '\n[输出超过 64 KiB，已截断]' : '') + (killed ? '\n[命令超过 60 秒已终止]' : ''), code, truncated });
    });
  });
}

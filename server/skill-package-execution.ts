/**
 * @file 在受限 bwrap 沙箱中运行 Skill 包内 Python 脚本。
 * @implementation 隔离文件系统与网络，按需挂载通用可选 Unix socket broker 并采集受限输出，无内置第三方搜索协议耦合。
 * @updated 2026-11-27T22:10:00+08:00
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppError } from '../shared/errors.js';
import {
  createSearchSkillBrokerSpec,
  type PackagePythonBrokerHandle,
  type PackagePythonBrokerSpec,
} from './search-skill-broker.js';

export type { PackagePythonBrokerHandle, PackagePythonBrokerSpec };

const outputLimit = 64 * 1024;
const runTimeout = 120_000;

const bootstrap = String.raw`
import os, runpy, socket, sys
entry, broker_host, broker_port = sys.argv[1:4]
sys.argv = [entry] + sys.argv[4:]
if broker_host and broker_port:
    target_port = int(broker_port)
    class BrokerSocket(socket.socket):
        def setsockopt(self, level, option, *values):
            # http.client enables TCP_NODELAY after create_connection; this is
            # a Unix socket, so that one TCP-only optimization is inapplicable.
            if level == socket.IPPROTO_TCP and option == socket.TCP_NODELAY:
                return
            return super().setsockopt(level, option, *values)
    def broker_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT,
                          source_address=None, *, all_errors=False):
        if address != (broker_host, target_port) or source_address is not None:
            raise OSError('Package network access is disabled')
        connection = BrokerSocket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                connection.settimeout(timeout)
            connection.connect('/broker/http.sock')
            return connection
        except BaseException:
            connection.close()
            raise
    socket.create_connection = broker_connection
# Isolated mode excludes cwd, PYTHONPATH and user site packages. Explicitly permit
# only the entry's bundled siblings (gateway.py imports distribution/activity).
sys.path.insert(0, os.path.dirname(entry))
runpy.run_path(entry, run_name='__main__')
`;

function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function invalid(message: string): never {
  throw new AppError('SKILL_PACKAGE_EXECUTION_INVALID', message);
}

/**
 * Run an already mounted/reviewed package. script is relative to root (or an
 * absolute path inside root); args use sandbox paths /state and /output.
 * Callers may attach an isolated Unix-socket broker via `broker` (or legacy
 * `search: true`). Eligibility and approvals belong to the caller. No shell,
 * project/home mounts, or network fallback are used.
 */
export async function runPackagePython(options: {
  root: string;
  script: string;
  args: string[];
  state: string;
  output: string;
  signal: AbortSignal;
  broker?: PackagePythonBrokerSpec;
  search?: boolean;
}): Promise<{ output: string; code: number | null }> {
  options.signal.throwIfAborted();
  if (process.platform !== 'linux') {
    throw new AppError(
      'SKILL_PACKAGE_EXECUTION_UNAVAILABLE',
      'Python 技能包需要 Linux bubblewrap 隔离。',
      409,
    );
  }
  try {
    await access('/usr/bin/python3', constants.X_OK);
  } catch {
    throw new AppError(
      'SKILL_PACKAGE_EXECUTION_UNAVAILABLE',
      '缺少可执行的 /usr/bin/python3。',
      409,
    );
  }
  if (
    !options.script ||
    options.script.includes('\0') ||
    options.args.length > 256 ||
    options.args.some((arg) => arg.includes('\0')) ||
    options.args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 64 * 1024
  ) {
    invalid('Python 入口或参数无效。');
  }

  const brokerSpec =
    options.broker ?? (options.search ? createSearchSkillBrokerSpec(options.args) : undefined);
  brokerSpec?.validate?.();

  const [root, state, output] = await Promise.all([
    realpath(options.root),
    realpath(options.state),
    realpath(options.output),
  ]);
  const directories: readonly string[] = [root, state, output];
  for (const path of directories) {
    if (!(await stat(path)).isDirectory()) invalid('包、状态和输出路径必须是目录。');
  }
  for (let i = 0; i < directories.length; i++) {
    const first = directories[i];
    if (!first) continue;
    for (let j = i + 1; j < directories.length; j++) {
      const second = directories[j];
      if (!second) continue;
      if (contains(first, second) || contains(second, first)) {
        invalid('包、状态和输出目录不能重叠。');
      }
    }
  }

  const entry = await realpath(resolve(root, options.script));
  if (!contains(root, entry) || !entry.endsWith('.py') || !(await stat(entry)).isFile()) {
    invalid('Python 入口必须是包内的 .py 文件。');
  }
  const sandboxEntry = '/skill/' + relative(root, entry).split(sep).join('/');
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();

  let directory: string | undefined;
  let brokerHandle: PackagePythonBrokerHandle | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, runTimeout);

  try {
    if (brokerSpec) {
      directory = await mkdtemp(join(tmpdir(), 'atelier-skill-broker-'));
      brokerHandle = await brokerSpec.start(directory, lifetime.signal);
    }
    options.signal.throwIfAborted();

    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--cap-drop',
      'ALL',
      '--clearenv',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/lib',
      '/lib',
      '--ro-bind-try',
      '/lib64',
      '/lib64',
      '--proc',
      '/proc',
      '--remount-ro',
      '/proc',
      '--dir',
      '/dev',
      '--ro-bind',
      '/dev/null',
      '/dev/null',
      '--ro-bind',
      '/dev/urandom',
      '/dev/urandom',
      '--dir',
      '/tmp',
      '--ro-bind',
      root,
      '/skill',
      '--bind',
      state,
      '/state',
      '--bind',
      output,
      '/output',
      '--setenv',
      'PATH',
      '/usr/bin',
      '--setenv',
      'LANG',
      'C.UTF-8',
      '--setenv',
      'HOME',
      '/nonexistent',
      '--setenv',
      'TMPDIR',
      '/state',
      '--chdir',
      '/skill',
    ];
    if (brokerHandle) args.push('--ro-bind', brokerHandle.socketPath, '/broker/http.sock');
    args.push(
      '--remount-ro',
      '/',
      '--',
      '/usr/bin/python3',
      '-I',
      '-B',
      '-u',
      '-c',
      bootstrap,
      sandboxEntry,
      brokerSpec ? brokerSpec.host : '',
      brokerSpec ? String(brokerSpec.port) : '',
      ...(brokerSpec?.extraArgs ?? []),
      ...options.args,
    );

    return await new Promise<{ output: string; code: number | null }>((done, reject) => {
      const child = spawn('bwrap', args, {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const append = (chunk: Buffer) => {
        const remaining = outputLimit - size;
        if (chunk.length > remaining) truncated = true;
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining);
          chunks.push(retained);
          size += retained.length;
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const kill = () => {
        if (!child.pid) return;
        try {
          // Killing bubblewrap's namespace init also terminates descendants that
          // changed process groups or sessions inside the PID namespace.
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      lifetime.signal.addEventListener('abort', kill, { once: true });
      if (lifetime.signal.aborted) kill();
      const cleanup = () => lifetime.signal.removeEventListener('abort', kill);
      child.once('error', () => {
        cleanup();
        reject(
          new AppError(
            'SKILL_PACKAGE_EXECUTION_UNAVAILABLE',
            '无法启动 bubblewrap Python 隔离。',
            409,
          ),
        );
      });
      child.once('close', (code) => {
        cleanup();
        if (options.signal.aborted) {
          reject(new AppError('RUN_STOPPED', 'Python 技能包已随运行停止。', 409));
        } else {
          done({
            output:
              Buffer.concat(chunks, size).toString('utf8') +
              (truncated ? '\n[输出超过 64 KiB，已截断]' : '') +
              (timedOut ? '\n[Python 技能包超过 120 秒已终止]' : ''),
            code,
          });
        }
      });
    });
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', stop);
    lifetime.abort();
    await brokerHandle?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

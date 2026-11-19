import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppError } from '../shared/types.js';

const searchOrigin = 'https://skill.zhaopintong.com';
// gateway.py persists a hash of its base URL. This logical address must stay stable
// across runs; it never has a TCP listener, and each run has its own Unix socket.
const gatewayPort = 17863;
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
const requestLimit = 64 * 1024;
const jsonLimit = 2_000_000;
const fileLimit = 15_000_000;
const outputLimit = 64 * 1024;
const runTimeout = 120_000;
const requestTimeout = 30_000;

const bootstrap = String.raw`
import os, runpy, socket, sys
entry, search = sys.argv[1:3]
sys.argv = [entry] + sys.argv[3:]
if search == 'search':
    class BrokerSocket(socket.socket):
        def setsockopt(self, level, option, *values):
            # http.client enables TCP_NODELAY after create_connection; this is
            # a Unix socket, so that one TCP-only optimization is inapplicable.
            if level == socket.IPPROTO_TCP and option == socket.TCP_NODELAY:
                return
            return super().setsockopt(level, option, *values)
    def broker_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT,
                          source_address=None, *, all_errors=False):
        if address != ('127.0.0.1', 17863) or source_address is not None:
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

// These are the exact routes in @zhaopintong/multi-search-engine@1.0.3's
// scripts/gateway.py and its activity.py import. Match the raw request target:
// URL normalization must not turn a forbidden path into an allowed one.
function allowedRequest(method: string | undefined, path: string, execute: boolean) {
  if (method === 'POST') {
    return (
      path === '/api/v1/clients/register' ||
      path === '/api/v1/skills/multi-search-engine/quote' ||
      path === '/api/v1/skills/multi-search-engine/activity/engage' ||
      (execute && path === '/api/v1/skills/multi-search-engine/invoke') ||
      /^\/api\/v1\/multi-search\/tasks\/[a-f0-9]{32}\/(recover|cancel|timing)$/.test(path)
    );
  }
  return (
    method === 'GET' &&
    (/^\/api\/v1\/multi-search\/requests\/[A-Za-z0-9_-]{8,60}\?quote_id=[a-f0-9]{32}$/.test(path) ||
      /^\/api\/v1\/multi-search\/tasks\/[a-f0-9]{32}(?:\/files\/[012])?$/.test(path))
  );
}

function reply(response: ServerResponse, status: number, code: string) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'content-type': 'application/json',
    connection: 'close',
  });
  response.end(JSON.stringify({ code }));
}

async function readRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  // Using data events lets us send 413 before closing an oversized connection.
  return new Promise<Buffer>((resolveBody, reject) => {
    const cleanup = () => {
      request.off('data', data);
      request.off('end', end);
      request.off('error', error);
      request.off('aborted', aborted);
    };
    const error = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const aborted = () => error(new Error('Request aborted'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > requestLimit) {
        request.pause();
        cleanup();
        reject(new Error('Request too large'));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolveBody(Buffer.concat(chunks, size));
    };
    request.on('data', data);
    request.once('end', end);
    request.once('error', error);
    request.once('aborted', aborted);
  });
}

async function startBroker(directory: string, signal: AbortSignal, execute: boolean) {
  const socketPath = join(directory, 'http.sock');
  const upstream = fetch;
  let requests = 0;
  let active = 0;
  let received = 0;
  const server = createServer(
    {
      maxHeaderSize: 8192,
      requestTimeout,
      headersTimeout: 5000,
      connectionsCheckingInterval: 1000,
      keepAliveTimeout: 1,
    },
    (request, response) => {
      void handle(request, response).catch(() => reply(response, 502, 'BROKER_UNAVAILABLE'));
    },
  );
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.on('connection', (socket) => {
    socket.setTimeout(requestTimeout, () => socket.destroy());
  });
  // Never leave CONNECT tunnels or upgraded sockets alive outside HTTP handling.
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const path = request.url ?? '';
    if (
      signal.aborted ||
      path.length > 2048 ||
      request.headers.host !== `127.0.0.1:${gatewayPort}` ||
      !allowedRequest(request.method, path, execute)
    ) {
      reply(response, 403, 'BROKER_REQUEST_DENIED');
      return;
    }
    if (++requests > 64 || active >= 4) {
      reply(response, 429, 'BROKER_LIMIT');
      return;
    }
    const length = request.headers['content-length'];
    if (length && Number(length) > requestLimit) {
      reply(response, 413, 'BROKER_REQUEST_TOO_LARGE');
      return;
    }
    active++;
    const controller = new AbortController();
    const stop = () => controller.abort();
    const timer = setTimeout(stop, requestTimeout);
    signal.addEventListener('abort', stop, { once: true });
    response.once('close', stop);
    let upstreamResponse: Response | undefined;
    try {
      let body: Buffer;
      try {
        body = await readRequest(request);
      } catch {
        reply(response, 413, 'BROKER_REQUEST_TOO_LARGE');
        return;
      }
      if (request.method === 'GET' && body.length) {
        reply(response, 403, 'BROKER_REQUEST_DENIED');
        return;
      }
      if (signal.aborted || controller.signal.aborted) return;
      const headers = new Headers({ accept: 'application/json' });
      // Never forward cookies, Host, proxy headers, or a package-supplied URL.
      for (const name of [
        'authorization',
        'x-skill-distribution',
        'x-search-client-version',
        'x-skill-asset',
      ]) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      if (request.method === 'POST') headers.set('content-type', 'application/json');
      upstreamResponse = await upstream(`${searchOrigin}${path}`, {
        method: request.method,
        headers,
        body: request.method === 'POST' ? new Uint8Array(body) : undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
        reply(response, 502, 'BROKER_REDIRECT_DENIED');
        return;
      }
      const limit = /\/files\/[012]$/.test(path) ? fileLimit : jsonLimit;
      const declared = upstreamResponse.headers.get('content-length');
      if (declared && Number(declared) > limit) {
        reply(response, 502, 'BROKER_RESPONSE_TOO_LARGE');
        return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (upstreamResponse.body) {
        for await (const chunk of upstreamResponse.body) {
          size += chunk.length;
          received += chunk.length;
          if (size > limit || received > 64 * 1024 * 1024) {
            reply(response, 502, 'BROKER_RESPONSE_TOO_LARGE');
            return;
          }
          chunks.push(chunk);
        }
      }
      let payload = Buffer.concat(chunks, size);
      if (path === '/api/v1/skills/multi-search-engine/invoke') {
        // The upstream's cashier link is data, never a broker destination.
        // gateway.py requires it to share the logical --base-url origin.
        let value;
        try {
          value = JSON.parse(payload.toString('utf8'));
        } catch {
          reply(response, 502, 'BROKER_INVALID_RESPONSE');
          return;
        }
        if (value?.checkout_url) {
          const checkout = value.checkout_url;
          if (
            typeof checkout !== 'string' ||
            !checkout.startsWith(`${searchOrigin}/checkout#`) ||
            checkout.length === `${searchOrigin}/checkout#`.length
          ) {
            reply(response, 502, 'BROKER_CHECKOUT_DENIED');
            return;
          }
          value.checkout_url = gatewayBase + checkout.slice(searchOrigin.length);
          payload = Buffer.from(JSON.stringify(value));
        }
      }
      if (!response.destroyed) {
        response.writeHead(upstreamResponse.status, {
          'content-type':
            upstreamResponse.headers.get('content-type') ?? 'application/octet-stream',
          'content-length': payload.length,
          connection: 'close',
        });
        response.end(payload);
      }
    } catch {
      reply(response, controller.signal.aborted ? 504 : 502, 'BROKER_UNAVAILABLE');
    } finally {
      controller.abort();
      // A redirect or size rejection may leave an unread body. Cancel it too.
      if (upstreamResponse?.body && !upstreamResponse.body.locked)
        await upstreamResponse.body.cancel().catch(() => {});
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      response.off('close', stop);
      active--;
    }
  }

  await new Promise<void>((ready, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      ready();
    });
  });
  const close = () => {
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeAllConnections();
    return closed;
  };
  try {
    await chmod(socketPath, 0o600);
    signal.throwIfAborted();
  } catch (error) {
    await close();
    throw error;
  }
  const abort = () => void close();
  signal.addEventListener('abort', abort, { once: true });
  return {
    socketPath,
    async close() {
      signal.removeEventListener('abort', abort);
      await close();
    },
  };
}

/**
 * Run an already mounted/reviewed package. script is relative to root (or an
 * absolute path inside root); args use sandbox paths /state and /output.
 * For the caller-validated search package, args begin with the gateway command;
 * this runner supplies --base-url and --state. Eligibility and approvals belong
 * to the caller. No shell, project/home mounts, or network fallback are used.
 */
export async function runPackagePython(options: {
  root: string;
  script: string;
  args: string[];
  state: string;
  output: string;
  signal: AbortSignal;
  search?: boolean;
}): Promise<{ output: string; code: number | null }> {
  options.signal.throwIfAborted();
  if (process.platform !== 'linux')
    throw new AppError(
      'SKILL_PACKAGE_EXECUTION_UNAVAILABLE',
      'Python 技能包需要 Linux bubblewrap 隔离。',
      409,
    );
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
  )
    invalid('Python 入口或参数无效。');
  if (
    options.search &&
    (!['prepare', 'execute', 'collect'].includes(options.args[0] ?? '') ||
      options.args.some((arg) => /^--(?:base-url|state)(?:=|$)/.test(arg)))
  )
    invalid('搜索包仅支持 prepare、execute、collect；连接地址和状态路径由执行器提供。');

  const [root, state, output] = await Promise.all(
    [options.root, options.state, options.output].map((path) => realpath(path)),
  );
  for (const path of [root!, state!, output!])
    if (!(await stat(path)).isDirectory()) invalid('包、状态和输出路径必须是目录。');
  const paths = [root!, state!, output!];
  for (let i = 0; i < paths.length; i++)
    for (let j = i + 1; j < paths.length; j++)
      if (contains(paths[i]!, paths[j]!) || contains(paths[j]!, paths[i]!))
        invalid('包、状态和输出目录不能重叠。');
  const entry = await realpath(resolve(root!, options.script));
  if (!contains(root!, entry) || !entry.endsWith('.py') || !(await stat(entry)).isFile())
    invalid('Python 入口必须是包内的 .py 文件。');
  const sandboxEntry = '/skill/' + relative(root!, entry).split(sep).join('/');
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  let directory: string | undefined;
  let broker: Awaited<ReturnType<typeof startBroker>> | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, runTimeout);
  try {
    if (options.search) {
      directory = await mkdtemp(join(tmpdir(), 'atelier-skill-broker-'));
      broker = await startBroker(directory, lifetime.signal, options.args[0] === 'execute');
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
      root!,
      '/skill',
      '--bind',
      state!,
      '/state',
      '--bind',
      output!,
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
    if (broker) args.push('--ro-bind', broker.socketPath, '/broker/http.sock');
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
      options.search ? 'search' : 'offline',
      ...(options.search ? ['--base-url', gatewayBase, '--state', '/state'] : []),
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
        if (options.signal.aborted)
          reject(new AppError('RUN_STOPPED', 'Python 技能包已随运行停止。', 409));
        else
          done({
            output:
              Buffer.concat(chunks, size).toString('utf8') +
              (truncated ? '\n[输出超过 64 KiB，已截断]' : '') +
              (timedOut ? '\n[Python 技能包超过 120 秒已终止]' : ''),
            code,
          });
      });
    });
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', stop);
    lifetime.abort();
    await broker?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

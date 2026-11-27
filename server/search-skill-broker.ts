/**
 * @file 提供多搜索引擎 Skill 沙箱的受限本地 Unix socket HTTP 代理与参数契约。
 * @implementation 从通用 bwrap Python 执行器中剥离 @zhaopintong/multi-search-engine 路由白名单、响应限额与结账地址重写，对外暴露通用 PackagePythonBrokerSpec 适配。
 * @updated 2026-11-27T22:10:00+08:00
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { AppError } from '../shared/errors.js';

export const SEARCH_ORIGIN = 'https://skill.zhaopintong.com';
// gateway.py persists a hash of its base URL. This logical address must stay stable
// across runs; it never has a TCP listener, and each run has its own Unix socket.
export const SEARCH_GATEWAY_HOST = '127.0.0.1';
export const SEARCH_GATEWAY_PORT = 17863;
export const SEARCH_GATEWAY_BASE = `http://${SEARCH_GATEWAY_HOST}:${SEARCH_GATEWAY_PORT}`;

const requestLimit = 64 * 1024;
const jsonLimit = 2_000_000;
const fileLimit = 15_000_000;
const requestTimeout = 30_000;

export interface PackagePythonBrokerHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface PackagePythonBrokerSpec {
  readonly host: string;
  readonly port: number;
  readonly extraArgs?: readonly string[];
  validate?(): void;
  start(directory: string, signal: AbortSignal): Promise<PackagePythonBrokerHandle>;
}

function invalidSearchArgs(message: string): never {
  throw new AppError('SKILL_PACKAGE_EXECUTION_INVALID', message);
}

export function validateSearchSkillArgs(args: readonly string[]): void {
  if (
    !['prepare', 'execute', 'collect'].includes(args[0] ?? '') ||
    args.some((arg) => /^--(?:base-url|state)(?:=|$)/.test(arg))
  ) {
    invalidSearchArgs('搜索包仅支持 prepare、execute、collect；连接地址和状态路径由执行器提供。');
  }
}

export function rewriteSearchCheckoutOutput(output: string): string {
  return output.replaceAll(`${SEARCH_GATEWAY_BASE}/checkout`, `${SEARCH_ORIGIN}/checkout`);
}

// These are the exact routes in @zhaopintong/multi-search-engine@1.0.3's
// scripts/gateway.py and its activity.py import. Match the raw request target:
// URL normalization must not turn a forbidden path into an allowed one.
export function isAllowedSearchBrokerRequest(
  method: string | undefined,
  path: string,
  execute: boolean,
): boolean {
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

export async function startSearchSkillBroker(
  directory: string,
  signal: AbortSignal,
  execute: boolean,
): Promise<PackagePythonBrokerHandle> {
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
      request.headers.host !== `${SEARCH_GATEWAY_HOST}:${SEARCH_GATEWAY_PORT}` ||
      !isAllowedSearchBrokerRequest(request.method, path, execute)
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
      upstreamResponse = await upstream(`${SEARCH_ORIGIN}${path}`, {
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
        let value: unknown;
        try {
          value = JSON.parse(payload.toString('utf8'));
        } catch {
          reply(response, 502, 'BROKER_INVALID_RESPONSE');
          return;
        }
        if (value && typeof value === 'object' && 'checkout_url' in value && value.checkout_url) {
          const record = value as Record<string, unknown>;
          const checkout = record.checkout_url;
          if (
            typeof checkout !== 'string' ||
            !checkout.startsWith(`${SEARCH_ORIGIN}/checkout#`) ||
            checkout.length === `${SEARCH_ORIGIN}/checkout#`.length
          ) {
            reply(response, 502, 'BROKER_CHECKOUT_DENIED');
            return;
          }
          record.checkout_url = SEARCH_GATEWAY_BASE + checkout.slice(SEARCH_ORIGIN.length);
          payload = Buffer.from(JSON.stringify(record));
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
    const { chmod } = await import('node:fs/promises');
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

export function createSearchSkillBrokerSpec(args: readonly string[]): PackagePythonBrokerSpec {
  return {
    host: SEARCH_GATEWAY_HOST,
    port: SEARCH_GATEWAY_PORT,
    extraArgs: ['--base-url', SEARCH_GATEWAY_BASE, '--state', '/state'],
    validate: () => validateSearchSkillArgs(args),
    start: (directory, signal) => startSearchSkillBroker(directory, signal, args[0] === 'execute'),
  };
}

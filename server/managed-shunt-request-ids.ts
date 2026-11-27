/**
 * @file 为托管 Shunt 模型响应补齐请求关联标识。
 * @implementation 向受信回环地址转发认证请求，为缺少有效标识的成功消息响应生成本机标识。取消或 SDK 收尾时释放连接。
 * @updated 2026-11-27T12:27:05+08:00
 */
import { randomUUID } from 'node:crypto';
import { Agent, createServer, request, type IncomingHttpHeaders } from 'node:http';
import { pipeline } from 'node:stream';
import type { AppConfig } from '../shared/types.js';

const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function forwardHeaders(source: IncomingHttpHeaders) {
  const headers = { ...source };
  for (const name of source.connection?.split(',') ?? []) delete headers[name.trim().toLowerCase()];
  for (const name of hopHeaders) delete headers[name];
  return headers;
}

export async function openManagedShuntRequestIds(
  config: AppConfig,
  token: string,
  signal: AbortSignal,
) {
  if (
    config.managedGateway !== true ||
    config.gateway !== process.env.ATELIER_MANAGED_GATEWAY ||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(config.gateway) ||
    !token ||
    token !== process.env.ATELIER_MANAGED_GATEWAY_TOKEN
  )
    return;
  signal.throwIfAborted();
  const destination = new URL(config.gateway);
  const agent = new Agent({ keepAlive: true, maxFreeSockets: 2 });
  const auth = `Bearer ${token}`;
  const server = createServer((incoming, outgoing) => {
    const path = incoming.url;
    if (
      !path?.startsWith('/') ||
      path.startsWith('//') ||
      (incoming.headers.authorization !== auth && incoming.headers['x-api-key'] !== token)
    ) {
      outgoing.writeHead(404, { connection: 'close' }).end();
      return;
    }
    const upstream = request({
      agent,
      hostname: destination.hostname,
      port: destination.port || 80,
      method: incoming.method,
      path,
      headers: { ...forwardHeaders(incoming.headers), host: destination.host },
    });
    incoming.once('error', () => upstream.destroy());
    incoming.once('close', () => {
      if (!incoming.complete) upstream.destroy();
    });
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });
    upstream.once('error', () => {
      if (outgoing.headersSent) outgoing.destroy();
      else if (!outgoing.destroyed) outgoing.writeHead(502).end();
    });
    upstream.once('response', (response) => {
      if (outgoing.destroyed) {
        response.destroy();
        return;
      }
      const status = response.statusCode ?? 502;
      const headers = forwardHeaders(response.headers);
      const id = headers['request-id'];
      if (
        incoming.method === 'POST' &&
        path.split('?', 1)[0] === '/v1/messages' &&
        status >= 200 &&
        status < 300 &&
        (typeof id !== 'string' || !id.trim() || id.length > 256)
      )
        headers['request-id'] = `req_atelier_${randomUUID()}`;
      outgoing.writeHead(status, headers).flushHeaders();
      pipeline(response, outgoing, () => {});
    });
    incoming.pipe(upstream);
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());

  let closed: Promise<void> | undefined;
  function close() {
    return (closed ??= new Promise<void>((done) => {
      signal.removeEventListener('abort', onAbort);
      server.close(() => done());
      server.closeAllConnections();
      agent.destroy();
    }));
  }
  function onAbort() {
    void close();
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    signal.addEventListener('abort', onAbort, { once: true });
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing Shunt relay address');
    return { origin: `http://127.0.0.1:${address.port}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

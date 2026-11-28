/**
 * @file 持有 HTTP 服务与在途请求的生命周期。
 * @implementation 统计在途写请求供重启判断，关闭时结束事件流、等待处理器并释放连接。
 * @updated 2026-12-08T12:00:00+00:00
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export function createRuntimeHttpServer(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  streams: ReadonlySet<ServerResponse>,
) {
  const requests = new Set<Promise<void>>();
  let writes = 0;
  const server = createServer((req, res) => {
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write) writes++;
    const task = handle(req, res);
    requests.add(task);
    void task.finally(() => {
      requests.delete(task);
      if (write) writes--;
    });
  });
  return {
    server,
    hasWrites: () => writes > 0,
    stopListening: () => new Promise<void>((resolve) => server.close(() => resolve())),
    async drainConnections() {
      for (const stream of streams) stream.end();
      await Promise.allSettled(requests);
      server.closeAllConnections();
    },
  };
}

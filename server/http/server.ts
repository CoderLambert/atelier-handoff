/**
 * @file 持有 HTTP 服务与在途请求的生命周期。
 * @implementation 停止接收后，结束已注册的事件流、等待处理器，并释放剩余连接。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export function createRuntimeHttpServer(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  streams: ReadonlySet<ServerResponse>,
) {
  const requests = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const task = handle(req, res);
    requests.add(task);
    void task.finally(() => requests.delete(task));
  });
  return {
    server,
    stopListening: () => new Promise<void>((resolve) => server.close(() => resolve())),
    async drainConnections() {
      for (const stream of streams) stream.end();
      await Promise.allSettled(requests);
      server.closeAllConnections();
    },
  };
}

/**
 * @file 在升级终端 WebSocket 前校验本机来源。
 * @implementation 要求请求对应当前监听端口及同源页面，关停后不接受新升级。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { IncomingMessage, Server } from 'node:http';
import { AppError } from '../../../shared/types.js';

export function validateTerminalUpgrade(
  server: Server,
  req: IncomingMessage,
  isShuttingDown: () => boolean,
): void {
  if (isShuttingDown()) throw new AppError('SHUTTING_DOWN', '服务正在关闭。', 503);
  const address = server.address();
  const host = req.headers.host;
  if (
    !address ||
    typeof address === 'string' ||
    (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}`) ||
    req.headers.origin !== `http://${host}` ||
    req.headers['sec-fetch-site'] === 'cross-site'
  )
    throw new AppError('ORIGIN_DENIED', '拒绝跨站终端连接。', 403);
}

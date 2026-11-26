/**
 * @file 定义运行时 HTTP 分发契约。
 * @implementation 提供解码后的路径和原始 URL；处理器显式标识是否已接管响应，包括长连接和已取消的请求。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: readonly string[];
  method: string;
}

export type RouteHandler = (request: RouteRequest) => boolean | Promise<boolean>;

/**
 * @file 分派已认证的人工终端 HTTP 操作。
 * @implementation 复用应用的 body/json 边界，严格解析会话和 runtime 身份并签发同源一次性连接票据。
 * @updated 2026-11-26T01:00:00+08:00
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  terminalCreateRequestSchema,
  terminalRuntimeRequestSchema,
} from '../../../shared/terminal.js';
import { AppError } from '../../../shared/types.js';
import type { TerminalManager } from './manager.js';

export interface TerminalRouteContext {
  manager: TerminalManager;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: readonly string[];
  method: string;
  body(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, value: unknown, status?: number): unknown;
}

export async function handleTerminalRoutes(context: TerminalRouteContext): Promise<boolean> {
  const { manager, req, res, parts, method, body, json } = context;
  if (
    parts.length === 3 &&
    parts[0] === 'api' &&
    parts[1] === 'terminals' &&
    parts[2] === 'capabilities' &&
    method === 'GET'
  ) {
    json(res, manager.capabilities());
    return true;
  }
  if (parts[0] !== 'api' || parts[1] !== 'sessions' || parts[3] !== 'terminals') return false;
  const sessionId = z.uuid().parse(parts[2]);
  if (parts.length === 4 && method === 'GET') {
    json(res, manager.list(sessionId));
    return true;
  }
  if (parts.length === 4 && method === 'POST') {
    json(res, await manager.create(sessionId, terminalCreateRequestSchema.parse(await body(req))));
    return true;
  }
  if (parts.length === 5 && method === 'DELETE') {
    const terminalId = z.uuid().parse(parts[4]);
    const { runtimeId } = terminalRuntimeRequestSchema.parse(await body(req));
    json(res, await manager.close(sessionId, runtimeId, terminalId));
    return true;
  }
  if (parts.length === 6 && parts[5] === 'attach-ticket' && method === 'POST') {
    const terminalId = z.uuid().parse(parts[4]);
    const { runtimeId } = terminalRuntimeRequestSchema.parse(await body(req));
    const origin = req.headers.origin;
    if (!origin) throw new AppError('ORIGIN_DENIED', '终端连接需要有效的同源请求。', 403);
    json(res, manager.ticket(sessionId, runtimeId, terminalId, origin));
    return true;
  }
  return false;
}

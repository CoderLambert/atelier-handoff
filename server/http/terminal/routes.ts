/**
 * @file 提供人工终端生命周期和连接票据的 HTTP 接口。
 * @implementation 使用应用的公共请求边界，解析会话及 runtime 身份，向终端服务申请同源一次性票据。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { z } from 'zod';
import {
  terminalCreateRequestSchema,
  terminalRuntimeRequestSchema,
} from '../../../shared/terminal.js';
import { AppError } from '../../../shared/types.js';
import type { TerminalManager } from '../../modules/terminal/manager.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

export function createTerminalRoutes(
  manager: Pick<TerminalManager, 'capabilities' | 'list' | 'create' | 'close' | 'ticket'>,
): RouteHandler {
  return async ({ req, res, parts, method }) => {
    if (
      parts.length === 3 &&
      parts[0] === 'api' &&
      parts[1] === 'terminals' &&
      parts[2] === 'capabilities' &&
      method === 'GET'
    )
      return json(res, manager.capabilities());
    if (parts[0] !== 'api' || parts[1] !== 'sessions' || parts[3] !== 'terminals') return false;
    const sessionId = z.uuid().parse(parts[2]);
    if (parts.length === 4 && method === 'GET') return json(res, manager.list(sessionId));
    if (parts.length === 4 && method === 'POST')
      return json(
        res,
        await manager.create(sessionId, terminalCreateRequestSchema.parse(await body(req))),
      );
    if (parts.length === 5 && method === 'DELETE') {
      const terminalId = z.uuid().parse(parts[4]);
      const { runtimeId } = terminalRuntimeRequestSchema.parse(await body(req));
      return json(res, await manager.close(sessionId, runtimeId, terminalId));
    }
    if (parts.length === 6 && parts[5] === 'attach-ticket' && method === 'POST') {
      const terminalId = z.uuid().parse(parts[4]);
      const { runtimeId } = terminalRuntimeRequestSchema.parse(await body(req));
      const origin = req.headers.origin;
      if (!origin) throw new AppError('ORIGIN_DENIED', '终端连接需要有效的同源请求。', 403);
      return json(res, manager.ticket(sessionId, runtimeId, terminalId, origin));
    }
    return false;
  };
}

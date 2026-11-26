/**
 * @file 提供网关配置、模型目录与托管网关登录 HTTP 接口。
 * @implementation 用精确路径处理模型和登录请求，保留 config 前缀的读写契约，并将解析后的配置交给网关服务。
 * @updated 2026-11-26T22:26:22+08:00
 */
import { z } from 'zod';
import { AppError } from '../../../shared/types.js';
import type { GatewayService } from '../../modules/gateway/service.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

const configSchema = z.object({
  gateway: z.string().url().optional(),
  managedGateway: z.boolean().optional(),
  magpieEnabled: z.boolean().optional(),
  model: z.string().min(1).max(200).optional(),
  limitExecution: z.boolean().optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(10000).max(1800000).optional(),
});

export interface GatewayRouteOptions {
  gateway: Pick<GatewayService, 'configInfo' | 'update' | 'models' | 'login'>;
  isShuttingDown(): boolean;
}

export function createGatewayRoutes({
  gateway,
  isShuttingDown,
}: GatewayRouteOptions): RouteHandler {
  return async ({ req, res, url, parts, method }) => {
    if (url.pathname === '/api/models' && method === 'GET')
      return json(res, await gateway.models(url.searchParams.get('refresh') === '1'));
    if (url.pathname === '/api/config/gateway-login' && method === 'POST') {
      if (isShuttingDown()) throw new AppError('SHUTTING_DOWN', '服务正在关闭。', 503);
      await gateway.login();
      return json(res, await gateway.configInfo());
    }
    if (parts[0] !== 'api' || parts[1] !== 'config') return false;
    if (method === 'PATCH') gateway.update(configSchema.parse(await body(req)));
    else if (method !== 'GET') throw new AppError('NOT_FOUND', '接口不存在。', 404);
    return json(res, await gateway.configInfo());
  };
}

/**
 * @file 注册独立文本增强的运行时接口。
 * @implementation 校验正文与用途，将客户端断开信号传给默认模型请求。
 * @updated 2026-11-28T18:00:00+08:00
 */
import { textEnhancementRequest } from '../../shared/text-enhancement.js';
import type { GatewayService } from '../modules/gateway/service.js';
import { createTextEnhancer } from '../modules/text-enhancement/service.js';
import { body } from './body.js';
import { withClientDisconnect } from './disconnect.js';
import { json } from './response.js';
import type { RouteHandler } from './types.js';

export function createTextEnhancementRoutes(gateway: GatewayService): RouteHandler {
  const enhance = createTextEnhancer(gateway);
  return ({ req, res, method, parts }) => {
    if (
      method !== 'POST' ||
      parts.length !== 2 ||
      parts[0] !== 'api' ||
      parts[1] !== 'text-enhancements'
    )
      return false;

    return withClientDisconnect(res, async (signal) => {
      const input = textEnhancementRequest.parse(await body(req, 256 * 1024));
      signal.throwIfAborted();
      const result = await enhance(input, signal);
      signal.throwIfAborted();
      return json(res, result);
    });
  };
}

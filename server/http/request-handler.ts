/**
 * @file 执行 HTTP 公共检查并分发领域路由。
 * @implementation 在任何领域操作前校验本机来源、写入令牌和桌面配对；仅对单任务远程触发窄口放行令牌直连并禁止浏览器跨站请求，分发后统一处理静态资源和错误。
 * @updated 2026-11-27T15:10:00+08:00
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { desktopPairingHeader } from '../../shared/desktop-host.js';
import { AppError } from '../../shared/errors.js';
import { serveClient } from '../client-assets.js';
import { sendRequestError } from './response.js';
import type { RouteHandler } from './types.js';

interface RequestHandlerOptions {
  root: string;
  csrfToken: string;
  desktopPairing?: string;
  isShuttingDown(): boolean;
  routes: readonly RouteHandler[];
}

function isRemoteScheduleTriggerPath(method: string, pathname: string): boolean {
  return method === 'POST' && /^\/api\/triggers\/schedules\/[^/]+$/.test(pathname);
}

export function createRequestHandler(options: RequestHandlerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (options.isShuttingDown()) throw new AppError('SHUTTING_DOWN', '服务正在关闭。', 503);
      const rawUrl = req.url || '/';
      if (!rawUrl.startsWith('/') || rawUrl.startsWith('//'))
        throw new AppError('INVALID_INPUT', '请求路径无效。', 400);
      const method = req.method || 'GET';
      const host = req.headers.host;
      if (!host) throw new AppError('ORIGIN_DENIED', '缺少 Host 请求头。', 403);
      const baseOrigin = 'http://' + host;
      let url: URL;
      try {
        url = new URL(rawUrl, baseOrigin);
      } catch {
        throw new AppError('INVALID_INPUT', '请求路径无效。', 400);
      }
      if (url.origin !== baseOrigin) throw new AppError('INVALID_INPUT', '请求路径无效。', 400);

      const isNarrowTrigger = isRemoteScheduleTriggerPath(method, url.pathname);
      if (isNarrowTrigger) {
        if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new AppError('ORIGIN_DENIED', '远程触发端点拒绝浏览器跨站请求。', 403);
        }
      } else {
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
          throw new AppError('ORIGIN_DENIED', '仅接受本机访问。', 403);
        if (
          (req.headers.origin && req.headers.origin !== baseOrigin) ||
          req.headers['sec-fetch-site'] === 'cross-site'
        )
          throw new AppError('ORIGIN_DENIED', '拒绝跨站请求。', 403);
        if (
          !['GET', 'HEAD'].includes(method) &&
          req.headers['x-atelier-token'] !== options.csrfToken
        )
          throw new AppError('TOKEN_REQUIRED', '本机应用令牌已更新，请刷新页面后重试。', 403);
      }

      let parts: string[];
      try {
        parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      } catch {
        throw new AppError('INVALID_INPUT', '请求路径编码无效。', 400);
      }
      if (
        !isNarrowTrigger &&
        parts[0] === 'api' &&
        options.desktopPairing &&
        req.headers[desktopPairingHeader] !== options.desktopPairing
      )
        throw new AppError('DESKTOP_PAIRING_REQUIRED', '此运行时仅接受配对的桌面窗口。', 403);
      const request = { req, res, url, parts, method };
      for (const route of options.routes) {
        const handled = route(request);
        if (typeof handled === 'boolean' ? handled : await handled) return;
      }
      if (parts[0] === 'api') throw new AppError('NOT_FOUND', '接口不存在。', 404);
      await serveClient(options.root, url.pathname, method, res);
    } catch (error) {
      sendRequestError(res, error);
    }
  };
}

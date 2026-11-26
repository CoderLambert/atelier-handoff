/**
 * @file 写入运行时 JSON 响应和统一错误。
 * @implementation 保留缓存头、校验错误格式和流已开始后的关闭语义。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { AppError } from '../../shared/types.js';

export function json(res: ServerResponse, data: unknown, status = 200): true {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
  return true;
}

export function sendRequestError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof z.ZodError) {
    json(
      res,
      {
        error: {
          code: 'INVALID_INPUT',
          message:
            '请求字段无效：' +
            error.issues
              .map((issue) => issue.path.join('.') + ' ' + issue.message)
              .slice(0, 3)
              .join('；'),
          retryable: false,
        },
      },
      400,
    );
    return;
  }
  const failure =
    error instanceof AppError
      ? error
      : new AppError('INTERNAL_ERROR', '操作失败，请检查服务日志后重试。', 500);
  if (!(error instanceof AppError))
    console.error('request failed:', error instanceof Error ? error.name : 'unknown');
  json(
    res,
    {
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    },
    failure.status,
  );
}

export function page<T>(items: T[], url: URL) {
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 50));
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}

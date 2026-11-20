/**
 * @file 提供前端 JSON、原始文件上传和二进制读取传输。
 * @implementation 统一错误解码与取消，修改请求复用 CSRF 引导及令牌续期，文档原件保留 File/Blob 请求体。
 * @updated 2026-11-21T00:00:00+08:00
 */
import type { Bootstrap } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = {
  method?: string;
  signal?: AbortSignal;
} & ({ body?: unknown; rawBody?: never } | { body?: never; rawBody: Blob });

let token: string | undefined;
let bootstrapRequest: Promise<Bootstrap> | undefined;

async function request(
  path: string,
  options: RequestOptions = {},
  csrf?: string,
): Promise<Response> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    signal: options.signal,
    headers: {
      ...(options.rawBody
        ? { 'Content-Type': 'application/octet-stream' }
        : options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      ...(csrf ? { 'X-Atelier-Token': csrf } : {}),
    },
    body:
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    const detail =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? payload.error
        : undefined;
    const message =
      typeof detail === 'object' && detail !== null && 'message' in detail
        ? detail.message
        : undefined;
    const code =
      typeof detail === 'object' && detail !== null && 'code' in detail ? detail.code : undefined;
    throw new ApiError(
      typeof message === 'string' ? message : `请求失败 (${response.status})`,
      response.status,
      typeof code === 'string' ? code : undefined,
    );
  }
  return response;
}

async function requestJson<T>(
  path: string,
  options: RequestOptions = {},
  csrf?: string,
): Promise<T> {
  const response = await request(path, options, csrf);
  return response.json() as Promise<T>;
}

export async function apiBytes(path: string, options: { signal?: AbortSignal } = {}) {
  const response = await request(path, options);
  return response.arrayBuffer();
}

export function bootstrap(): Promise<Bootstrap> {
  bootstrapRequest ??= requestJson<Bootstrap>('/api/bootstrap')
    .then((result) => {
      token = result.csrfToken;
      return result;
    })
    .finally(() => {
      bootstrapRequest = undefined;
    });
  return bootstrapRequest;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!options.method || ['GET', 'HEAD'].includes(options.method))
    return requestJson<T>(path, options);
  const current = token ?? (await bootstrap()).csrfToken;
  options.signal?.throwIfAborted();
  try {
    return await requestJson<T>(path, options, current);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'TOKEN_REQUIRED') throw error;
    const nextToken = token && token !== current ? token : (await bootstrap()).csrfToken;
    options.signal?.throwIfAborted();
    return requestJson<T>(path, options, nextToken);
  }
}

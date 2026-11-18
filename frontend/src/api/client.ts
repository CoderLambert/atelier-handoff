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

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

let token: string | undefined;
let bootstrapRequest: Promise<Bootstrap> | undefined;

async function request<T>(path: string, options: RequestOptions = {}, csrf?: string): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    signal: options.signal,
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(csrf ? { 'X-Atelier-Token': csrf } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new ApiError(
      payload?.error?.message ?? `请求失败 (${response.status})`,
      response.status,
      payload?.error?.code,
    );
  }
  return payload as T;
}

export function bootstrap(): Promise<Bootstrap> {
  bootstrapRequest ??= request<Bootstrap>('/api/bootstrap')
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
  if (!options.method || ['GET', 'HEAD'].includes(options.method)) return request<T>(path, options);
  const current = token ?? (await bootstrap()).csrfToken;
  options.signal?.throwIfAborted();
  try {
    return await request<T>(path, options, current);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'TOKEN_REQUIRED') throw error;
    const nextToken = token && token !== current ? token : (await bootstrap()).csrfToken;
    options.signal?.throwIfAborted();
    return request<T>(path, options, nextToken);
  }
}

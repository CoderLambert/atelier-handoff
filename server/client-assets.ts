import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import type { ServerResponse } from 'node:http';
import { AppError } from '../shared/types.js';

const sharedHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
const prototypeFiles = new Map([
  ['/prototype/', 'index.html'],
  ['/prototype/index.html', 'index.html'],
  ['/prototype/app.js', 'app.js'],
  ['/prototype/styles.css', 'styles.css'],
]);

export async function serveClient(
  root: string,
  pathname: string,
  method: string,
  response: ServerResponse,
) {
  const index = pathname === '/' || pathname === '/index.html';
  const prototype = prototypeFiles.get(pathname);
  const asset = /^\/assets\/([a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+)$/.exec(pathname)?.[1];
  const filename = index ? 'index.html' : (prototype ?? asset);
  const mime = filename ? contentTypes[extname(filename)] : undefined;
  if (!filename || !mime || (method !== 'GET' && method !== 'HEAD'))
    throw new AppError('NOT_FOUND', '页面不存在。', 404);
  const folder = prototype ? join(root, 'prototype') : join(root, 'dist/client');
  const file = asset ? join(folder, 'assets', filename) : join(folder, filename);
  let data: Buffer;
  try {
    const path = relative(await realpath(folder), await realpath(file));
    const expected = asset ? join('assets', filename) : filename;
    if (isAbsolute(path) || path !== expected) throw new AppError('NOT_FOUND', '页面不存在。', 404);
    data = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (index)
      throw new AppError('CLIENT_NOT_BUILT', '前端构建尚未生成，请运行 npm run build。', 503);
    throw new AppError('NOT_FOUND', '页面不存在。', 404);
  }
  response.writeHead(200, {
    ...sharedHeaders,
    'Content-Type': mime,
    'Content-Length': data.length,
    'Cache-Control': asset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  response.end(method === 'HEAD' ? undefined : data);
}

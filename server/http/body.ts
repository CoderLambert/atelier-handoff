/**
 * @file 读取和限制运行时的 JSON 请求体。
 * @implementation 逐块计量字节，以 unknown 返回解码结果，字段由领域路由校验。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { IncomingMessage } from 'node:http';
import { AppError } from '../../shared/types.js';

export async function body(req: IncomingMessage, maxBytes = 1_500_000): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new AppError('INVALID_INPUT', '请求必须使用 JSON。', 415);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) throw new AppError('UPLOAD_TOO_LARGE', '请求体过大。', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new AppError('INVALID_INPUT', 'JSON 格式无效。');
  }
}

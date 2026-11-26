/**
 * @file 提供工具输出分页和下载。
 * @implementation 保留原始与显示视图，限制响应窗口并使用可信的下载文件名。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { toolOutputFilename } from '../../../shared/tool-output-download.js';
import type { FileRecords } from '../../artifacts.js';
import type { Store } from '../../store.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

export function createToolOutputRoutes(
  store: Pick<Store, 'get'>,
  files: Pick<FileRecords, 'toolOutput'>,
): RouteHandler {
  return async ({ res, url, parts, method }) => {
    const [api, tools, id, action] = parts;
    if (
      api !== 'api' ||
      tools !== 'tools' ||
      id === undefined ||
      parts.length !== 4 ||
      action !== 'output' ||
      method !== 'GET'
    )
      return false;
    const display = url.searchParams.get('view') === 'display';
    const text = await files.toolOutput(id, display);
    if (url.searchParams.get('download') === '1') {
      const filename = toolOutputFilename(display ? store.get('tools', id).bashLog : undefined);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'no-store',
      });
      res.end(text);
      return true;
    }
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
    const limit = Math.max(
      1,
      Math.min(32000, Math.floor(Number(url.searchParams.get('limit')) || 16000)),
    );
    return json(res, {
      text: text.slice(offset, offset + limit),
      offset,
      total: text.length,
      nextOffset: offset + limit < text.length ? offset + limit : null,
    });
  };
}

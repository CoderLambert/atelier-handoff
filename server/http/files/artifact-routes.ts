/**
 * @file 提供交付物列表、内容预览和下载。
 * @implementation 保持只读的文件所有权与预览响应头；可内嵌 HTML 只在内容安全策略的沙箱中运行。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { FileRecords } from '../../artifacts.js';
import type { Store } from '../../store.js';
import { json, page } from '../response.js';
import type { RouteHandler } from '../types.js';

export function createArtifactRoutes(
  store: Pick<Store, 'list'>,
  files: Pick<FileRecords, 'content'>,
): RouteHandler {
  return async ({ res, url, parts, method }) => {
    if (parts[0] !== 'api' || parts[1] !== 'artifacts' || method !== 'GET') return false;
    if (parts.length === 2)
      return json(
        res,
        page(
          store
            .list('artifacts')
            .filter(
              (item) =>
                (!url.searchParams.get('sessionId') ||
                  item.sessionId === url.searchParams.get('sessionId')) &&
                (!url.searchParams.get('projectId') ||
                  item.projectId === url.searchParams.get('projectId')),
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          url,
        ),
      );
    const id = parts[2];
    if (parts.length !== 4 || id === undefined) return false;
    const { artifact, bytes } = await files.content(id);
    const html = /\.html?$/i.test(artifact.name);
    const image = artifact.mime === 'image/png';
    if (parts[3] === 'content')
      return json(res, {
        artifact,
        text: image
          ? ''
          : artifact.mime === 'application/pdf'
            ? 'PDF 交付物，请下载查看。'
            : bytes.toString('utf8'),
        previewable: artifact.mime !== 'application/pdf',
        previewKind: html ? 'html' : 'text',
      });
    if (parts[3] === 'preview' && image) {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'no-store',
      });
      res.end(bytes);
      return true;
    }
    if (parts[3] === 'preview' && html) {
      res.removeHeader('X-Frame-Options');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
        'Cache-Control': 'no-store',
      });
      res.end(bytes);
      return true;
    }
    if (parts[3] === 'download') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="download.txt"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'no-store',
      });
      res.end(bytes);
      return true;
    }
    return false;
  };
}

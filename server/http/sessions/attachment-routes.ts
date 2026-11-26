/**
 * @file 提供会话附件上传、预览、下载和移除。
 * @implementation 在已校验会话下收发附件，负责流式响应及文档预览的断连和临时目录清理。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { isDocumentAttachmentMime } from '../../../shared/document-attachments.js';
import { AppError } from '../../../shared/types.js';
import type { FileRecords } from '../../artifacts.js';
import { prepareDocumentView } from '../../attachment-document-reader.js';
import type { SessionAttachments } from '../../modules/sessions/attachments.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteRequest } from '../types.js';

const nameInput = z.string().min(1).max(255);
const inlineUpload = z.object({
  name: nameInput,
  mime: z.string().optional(),
  contentBase64: z.string(),
});

export function createAttachmentRoutes({
  directory,
  files,
  attachments,
}: {
  directory: string;
  files: Pick<FileRecords, 'attachmentFile' | 'attachmentContent' | 'upload' | 'uploadDocument'>;
  attachments: SessionAttachments;
}) {
  return async ({ req, res, url, parts, method }: RouteRequest, id: string): Promise<boolean> => {
    const attachmentId = parts[4];
    if (parts.length === 6 && attachmentId !== undefined && method === 'GET') {
      const { attachment, path } = files.attachmentFile(attachmentId, id);
      const document = isDocumentAttachmentMime(attachment.mime);
      if (parts[5] === 'document-preview' && document) {
        const temporary = await mkdtemp(join(directory, 'attachment-preview-'));
        const abort = new AbortController();
        const disconnect = () => abort.abort();
        res.once('close', disconnect);
        try {
          const { preview } = await prepareDocumentView({
            path,
            mime: attachment.mime,
            directory: temporary,
            signal: abort.signal,
          });
          files.attachmentFile(attachment.id, id);
          return json(res, { text: preview });
        } finally {
          res.removeListener('close', disconnect);
          await rm(temporary, { recursive: true, force: true });
        }
      }
      if (parts[5] === 'download' || parts[5] === 'content') {
        const download = parts[5] === 'download';
        const image = attachment.mime === 'image/png' || attachment.mime === 'image/jpeg';
        if (!download && !image && !document) {
          const { bytes } = await files.attachmentContent(attachment.id, id);
          return json(res, { text: bytes.toString('utf8') });
        }
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.size !== attachment.size)
          throw new AppError('ATTACHMENT_UNAVAILABLE', '附件原件不可用。', 404);
        res.writeHead(200, {
          'Content-Type': download ? 'application/octet-stream' : attachment.mime,
          'Content-Length': attachment.size,
          'Cache-Control': 'no-store',
          ...(download
            ? {
                'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
              }
            : {}),
        });
        await pipeline(createReadStream(path), res);
        return true;
      }
    }
    if (parts.length === 4 && method === 'POST') {
      const attachment = await attachments.upload(id, async () => {
        if (req.headers['content-type'] === 'application/octet-stream')
          return files.uploadDocument(id, nameInput.parse(url.searchParams.get('name')), {
            chunks: () => req.iterator({ destroyOnReturn: false }),
            declaredLength: req.headers['content-length'],
            isAborted: () => req.aborted,
          });
        const upload = inlineUpload.parse(await body(req, 7_100_000));
        return files.upload(id, upload.name, upload.contentBase64);
      });
      return json(res, { attachment }, 201);
    }
    if (parts.length === 5 && attachmentId !== undefined && method === 'DELETE') {
      await attachments.remove(id, attachmentId);
      return json(res, { ok: true });
    }
    return false;
  };
}

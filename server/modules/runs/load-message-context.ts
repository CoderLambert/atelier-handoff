/**
 * @file 加载本轮运行的项目上下文和附件。
 * @implementation 读取授权范围内的去重路径与附件，保留图片和文本的独立大小限制及上下文标记。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { isDocumentAttachmentMime } from '../../../shared/document-attachments.js';
import { AppError } from '../../../shared/types.js';
import type { AttachmentImages } from '../../agent.js';
import type { FileRecords } from '../../artifacts.js';
import { readProjectText } from '../../files.js';

export async function loadMessageContext({
  files,
  sessionId,
  workspacePath,
  resolvedInput,
  contextPaths,
  attachmentIds,
}: {
  files: Pick<FileRecords, 'attachmentFile' | 'attachmentContent'>;
  sessionId: string;
  workspacePath: string;
  resolvedInput: string;
  contextPaths: string[];
  attachmentIds: string[];
}) {
  let context = '';
  let contextBytes = Buffer.byteLength(resolvedInput);
  for (const path of [...new Set(contextPaths)]) {
    const text = await readProjectText(workspacePath, path, 128 * 1024);
    contextBytes += Buffer.byteLength(text);
    context += `\n<project_context path=${JSON.stringify(path)}>\n${text}\n</project_context>\n`;
  }
  const images: AttachmentImages = [];
  let imageBytes = 0;
  for (const id of [...new Set(attachmentIds)]) {
    const { attachment } = files.attachmentFile(id, sessionId);
    const mime = attachment.mime;
    if (isDocumentAttachmentMime(mime)) continue;
    const { bytes } = await files.attachmentContent(id, sessionId);
    if (mime === 'image/png' || mime === 'image/jpeg') {
      imageBytes += bytes.length;
      if (imageBytes > 10 * 1024 * 1024)
        throw new AppError('CONTEXT_TOO_LARGE', '每条消息的图片附件合计不能超过 10 MiB。', 413);
      images.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: bytes.toString('base64') },
      });
    } else {
      contextBytes += bytes.length;
      context += `\n<attachment name=${JSON.stringify(attachment.name)}>\n${bytes.toString('utf8')}\n</attachment>\n`;
    }
  }
  assertContextSize(contextBytes);
  return { context, images };
}

function assertContextSize(bytes: number): void {
  if (bytes > 128 * 1024)
    throw new AppError('CONTEXT_TOO_LARGE', '本轮附件与附加上下文总量不能超过 128 KiB。', 413);
}

export function emptyMessageContext(resolvedInput: string): {
  context: string;
  images: AttachmentImages;
} {
  assertContextSize(Buffer.byteLength(resolvedInput));
  return { context: '', images: [] };
}

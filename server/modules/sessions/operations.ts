/**
 * @file 协调同一会话的删除与附件上传状态。
 * @implementation 通过具名操作持有两种互斥任务的内存标记，供运行、终端和会话用例复核。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { AppError } from '../../../shared/errors.js';

export function createSessionOperations() {
  const deleting = new Set<string>();
  const uploading = new Set<string>();
  return {
    isDeleting: (id: string) => deleting.has(id),
    isUploading: (id: string) => uploading.has(id),
    async withDeletion<T>(id: string, work: () => Promise<T>): Promise<T> {
      deleting.add(id);
      try {
        return await work();
      } finally {
        deleting.delete(id);
      }
    },
    async withUpload<T>(id: string, work: () => Promise<T>): Promise<T> {
      if (deleting.has(id)) throw new AppError('SESSION_DELETING', '会话正在删除。', 409);
      if (uploading.has(id))
        throw new AppError('ATTACHMENT_UPLOAD_ACTIVE', '此会话正在上传附件，请稍后重试。', 409);
      uploading.add(id);
      try {
        return await work();
      } finally {
        uploading.delete(id);
      }
    },
  };
}

export type SessionOperations = ReturnType<typeof createSessionOperations>;

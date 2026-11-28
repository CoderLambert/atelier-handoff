/**
 * @file 保留新会话草稿中的本地附件。
 * @implementation 文件只在当前窗口暂存，保存成功的上传回执供首条消息重试。
 * @updated 2026-11-28T15:41:00+08:00
 */
interface StagedAttachment {
  id: string;
  file: File;
  uploadedId?: string;
}

const drafts = new Map<string, Map<string, StagedAttachment>>();

export function stageAttachment(draftId: string, file: File) {
  const entries = drafts.get(draftId) ?? new Map<string, StagedAttachment>();
  const id = crypto.randomUUID();
  entries.set(id, { id, file });
  drafts.set(draftId, entries);
  return id;
}

export function stagedAttachment(draftId: string, id: string) {
  return drafts.get(draftId)?.get(id);
}

export function removeStagedAttachment(draftId: string, id: string) {
  drafts.get(draftId)?.delete(id);
}

export function clearStagedAttachments(draftId: string) {
  drafts.delete(draftId);
}

/**
 * @file 管理会话附件上传和移除的操作边界。
 * @implementation 复核绑定智能体能力，在读取上传流期间阻止会话删除，并保护排队消息引用。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { AppError, type Attachment } from '../../../shared/types.js';
import type { AgentProfiles } from '../../agent-profiles.js';
import type { FileRecords } from '../../artifacts.js';
import type { MessageQueue } from '../../message-queue.js';
import type { Store } from '../../store.js';
import type { SessionOperations } from './operations.js';

export function createSessionAttachments({
  store,
  agents,
  files,
  operations,
  messageQueue,
}: {
  store: Pick<Store, 'get'>;
  agents: Pick<AgentProfiles, 'requireReady'>;
  files: Pick<FileRecords, 'removeAttachment'>;
  operations: Pick<SessionOperations, 'withUpload'>;
  messageQueue: Pick<MessageQueue, 'referencesAttachment'>;
}) {
  return {
    upload(id: string, readUpload: () => Promise<Attachment>) {
      const session = store.get('sessions', id);
      if (
        session.agentRevisionId &&
        !agents
          .requireReady(session.projectId, session.agentRevisionId)
          .config.capabilities.includes('attachments')
      )
        throw new AppError('AGENT_CAPABILITY_DENIED', '此智能体未启用附件。', 403);
      return operations.withUpload(id, readUpload);
    },
    async remove(id: string, attachmentId: string) {
      if (messageQueue.referencesAttachment(id, attachmentId))
        throw new AppError('ATTACHMENT_QUEUED', '此附件正在待处理消息中，请先撤回相关消息。', 409);
      await files.removeAttachment(attachmentId, id);
    },
  };
}

export type SessionAttachments = ReturnType<typeof createSessionAttachments>;

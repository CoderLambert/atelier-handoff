/**
 * @file 管理会话创建、归档、恢复、智能体升级和删除。
 * @implementation 复核工作树、执行、审批、终端及附件占用，再提交相关会话和清理记录。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRestoreRequest } from '../../../shared/git-workbench.js';
import { AppError, emptyDraft, now, type Session } from '../../../shared/types.js';
import type { AgentProfiles } from '../../agent-profiles.js';
import type { FileRecords } from '../../artifacts.js';
import { resolveProjectPath } from '../../files.js';
import type { MessageQueue } from '../../message-queue.js';
import { publicSession, type SessionForks } from '../../session-forks.js';
import type { Store } from '../../store.js';
import type { DevelopmentWorktrees } from '../git/development-worktrees.js';
import { assertNativeExecution } from '../runs/execution-policy.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { SessionOperations } from './operations.js';

interface SessionLifecycleOptions {
  store: Pick<
    Store,
    | 'get'
    | 'list'
    | 'put'
    | 'update'
    | 'delete'
    | 'transaction'
    | 'event'
    | 'gitWorktrees'
    | 'sessionEvents'
    | 'runReceipts'
  >;
  worktrees: Pick<
    DevelopmentWorktrees,
    'archive' | 'assertUnlocked' | 'resolveSession' | 'restore' | 'sessionWorkspace'
  >;
  files: Pick<FileRecords, 'deleteSessionFiles'>;
  agents: Pick<AgentProfiles, 'requireReady' | 'revision' | 'card'>;
  terminals: Pick<TerminalManager, 'assertSessionIdle' | 'disposeSession'>;
  forks: Pick<SessionForks, 'usingSource' | 'create'>;
  messageQueue: Pick<MessageQueue, 'hasPending'>;
  operations: SessionOperations;
  data: string;
  nativeExecution: boolean;
  sameSessionRunning(id: string): boolean;
  isShuttingDown(): boolean;
}

export function createSessionLifecycle({
  store,
  worktrees,
  files,
  agents,
  terminals,
  forks,
  messageQueue,
  operations,
  data,
  nativeExecution,
  sameSessionRunning,
  isShuttingDown,
}: SessionLifecycleOptions) {
  async function create(input: { projectId: string; agentRevisionId?: string }) {
    const project = store.get('projects', input.projectId);
    await resolveProjectPath(project.path, '', { directory: true });
    const session: Session = {
      id: randomUUID(),
      projectId: project.id,
      title: '新会话',
      status: 'active',
      sdkSessionId: null,
      createdAt: now(),
      updatedAt: now(),
      draft:
        nativeExecution && !input.agentRevisionId
          ? { ...emptyDraft(), mode: 'edit', executionPreference: 'native-v1' }
          : emptyDraft(),
      ...(input.agentRevisionId ? { agentRevisionId: input.agentRevisionId } : {}),
    };
    store.transaction(() => {
      if (input.agentRevisionId) agents.requireReady(project.id, input.agentRevisionId);
      store.put('sessions', session);
    });
    store.event('session-' + session.id, session.id, 'session.created', {});
    return session;
  }

  function fork(id: string, input: Parameters<SessionForks['create']>[1]) {
    if (isShuttingDown()) throw new AppError('SHUTTING_DOWN', '服务正在关闭。', 503);
    if (operations.isDeleting(id))
      throw new AppError('SESSION_DELETING', '来源会话正在删除。', 409);
    return forks.create(id, input);
  }

  function upgradeAgent(id: string, revisionId: string) {
    const session = store.transaction(() => {
      const current = store.get('sessions', id);
      if (
        current.status !== 'active' ||
        operations.isDeleting(id) ||
        current.agentRevisionId !== revisionId ||
        store.list('runs').some((run) => run.sessionId === id) ||
        store.list('messages').some((message) => message.sessionId === id)
      )
        throw new AppError('AGENT_CHANGED', '只有尚未发送消息的会话可以升级智能体版本。', 409);
      const previous = agents.revision(current.projectId, revisionId);
      const latest = agents.card(current.projectId, previous.agentId);
      if (latest.revisionId === revisionId)
        throw new AppError('AGENT_CHANGED', '请先发布修复后的智能体版本。', 409);
      agents.requireReady(current.projectId, latest.revisionId);
      return store.update('sessions', id, {
        agentRevisionId: latest.revisionId,
        updatedAt: now(),
      });
    });
    store.event('session-' + id, id, 'session.updated', {});
    return publicSession(session);
  }

  async function restore(current: Session, input: GitRestoreRequest) {
    const session = await worktrees.restore(current, input);
    return {
      session: publicSession(session),
      workspace: await worktrees.sessionWorkspace(session),
    };
  }

  async function update(id: string, update: Partial<Pick<Session, 'title' | 'status' | 'draft'>>) {
    const prior = store.get('sessions', id);
    if (update.status === 'archived') terminals.assertSessionIdle(id);
    if (update.draft?.executionPreference === 'native-v1')
      assertNativeExecution(nativeExecution, prior, update.draft.mode, update.draft.approvalMode);
    if (
      update.status === 'archived' &&
      (sameSessionRunning(id) ||
        messageQueue.hasPending(id) ||
        forks.usingSource(id) ||
        store
          .list('permissions')
          .some((permission) => permission.sessionId === id && permission.status === 'pending'))
    )
      throw new AppError('RUN_ACTIVE', '请先处理活动运行、审批及待处理消息再归档。', 409);
    if (update.status === 'active' && store.gitWorktrees.forSession(id)) {
      const path = await worktrees.resolveSession(prior);
      worktrees.assertUnlocked(path);
    }
    if (update.draft)
      for (const attachmentId of update.draft.attachmentIds) {
        const a = store.get('attachments', attachmentId);
        if (a.sessionId !== id || a.removed)
          throw new AppError('CONTEXT_DENIED', '草稿附件不属于当前会话。', 403);
      }
    const session = store.update('sessions', id, {
      ...update,
      updatedAt: update.title || update.status ? now() : prior.updatedAt,
    });
    const workspace =
      update.status === 'archived'
        ? await worktrees.archive(session)
        : update.status === 'active'
          ? await worktrees.sessionWorkspace(session)
          : undefined;
    if (!update.draft) store.event('session-' + id, id, 'session.updated', {});
    return { session: publicSession(session), ...(workspace ? { workspace } : {}) };
  }

  async function remove(id: string) {
    store.get('sessions', id);
    terminals.assertSessionIdle(id);
    if (sameSessionRunning(id) || messageQueue.hasPending(id))
      throw new AppError('RUN_ACTIVE', '请先处理活动运行和待处理消息再删除会话。', 409);
    if (operations.isDeleting(id)) throw new AppError('SESSION_DELETING', '会话正在删除。', 409);
    if (forks.usingSource(id))
      throw new AppError('FORK_ACTIVE', '请等分支创建结束再删除来源会话。', 409);
    if (operations.isUploading(id))
      throw new AppError('ATTACHMENT_UPLOAD_ACTIVE', '请等附件上传结束再删除会话。', 409);
    await operations.withDeletion(id, async () => {
      await terminals.disposeSession(id);
      await files.deleteSessionFiles(id);
      store.transaction(() => {
        for (const table of [
          'runs',
          'messages',
          'tools',
          'permissions',
          'artifacts',
          'attachments',
        ] as const)
          for (const item of store.list(table).filter((item) => item.sessionId === id))
            store.delete(table, item.id);
        store.delete('sessions', id);
        store.sessionEvents.deleteForSession(id);
        store.runReceipts.deleteForSession(id);
      });
      await rm(join(data, 'sdk', id), { recursive: true, force: true });
      store.event('deleted-' + id, '', 'session.deleted', { sessionId: id });
    });
  }

  return { create, fork, upgradeAgent, restore, update, remove };
}

export type SessionLifecycle = ReturnType<typeof createSessionLifecycle>;

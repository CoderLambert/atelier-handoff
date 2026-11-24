/**
 * @file 从已完成的消息创建同项目独立会话。
 * @implementation 在源会话工作目录读取 SDK 记录并复制到新会话，持久化来源和继承的工作树绑定。
 * @updated 2026-11-24T03:39:03+08:00
 */
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AppError,
  activeStatuses,
  now,
  type Message,
  type Project,
  type Run,
  type Session,
} from '../shared/types.js';
import { resolveProjectPath } from './files.js';
import { matchLegacyForkAnchors } from './session-fork-legacy.js';
import { forkSessionTranscript, readLegacyForkTurns } from './session-fork-sdk.js';
import type { Store } from './store.js';
import type { SessionSnapshotRecords } from './modules/sessions/session-snapshot-repository.js';

export const sessionForkRequest = z.strictObject({
  messageId: z.uuid(),
  idempotencyKey: z.uuid(),
  rewindFromHead: z.uuid().optional(),
});
type SessionForkRequest = z.infer<typeof sessionForkRequest>;

export function publicSession(session: Session): Session {
  const { inheritedMessages: _history, creatingFork: _creating, ...publicFields } = session;
  return publicFields;
}

export class SessionForks {
  private readonly pending = new Map<
    string,
    { sourceSessionId: string; messageId: string; rewind: boolean; result: Promise<Session> }
  >();

  private readonly legacyChecks = new Map<string, Promise<boolean> | null>();

  constructor(
    private readonly store: Store,
    private readonly forkTranscript = forkSessionTranscript,
    private readonly hasPendingMessages: (id: string) => boolean = () => false,
    private readonly resolveWorkspace?: (session: Session) => Promise<string>,
  ) {}

  async restoreLegacyAnchors({
    session,
    messages,
    runs,
    project,
  }: {
    session: Session;
    messages: Message[];
    runs: Run[];
    project: Project;
  }): Promise<boolean> {
    const checking = this.legacyChecks.get(session.id);
    if (checking !== undefined) return checking ?? false;
    if (
      session.creatingFork ||
      !session.sdkSessionId ||
      runs.some(({ status }) => activeStatuses.includes(status))
    )
      return false;
    const completed = new Set(
      runs.filter(({ status }) => status === 'completed').map(({ id }) => id),
    );
    if (
      !messages.some(
        (message) => !message.forkAnchor && message.text.trim() && completed.has(message.runId),
      )
    )
      return false;
    const check = Promise.resolve(this.resolveWorkspace?.(session) ?? project.path)
      .then((path) => readLegacyForkTurns(path, this.sdkDirectory(session.id)))
      .then((turns) => {
        const current = this.findExisting(session.id);
        if (
          !current ||
          current.sdkSessionId !== session.sdkSessionId ||
          current.sdkConfigKey !== session.sdkConfigKey
        )
          return false;
        const matches = matchLegacyForkAnchors(session, runs, messages, turns);
        if (!matches.length) return false;
        this.store.transaction(() => {
          for (const { id, anchor } of matches) {
            const message = this.store.get('messages', id);
            if (!message.forkAnchor) this.store.update('messages', id, { forkAnchor: anchor });
          }
        });
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.legacyChecks.set(session.id, null);
      });
    this.legacyChecks.set(session.id, check);
    return check;
  }

  usingSource(sessionId: string): boolean {
    return [...this.pending.values()].some((pending) => pending.sourceSessionId === sessionId);
  }

  async recover(): Promise<void> {
    for (const session of this.store.list('sessions')) {
      if (session.creatingFork && z.uuid().safeParse(session.id).success) {
        await this.removeUnfinished(session.id);
      }
    }
  }

  async create(sourceSessionId: string, request: SessionForkRequest): Promise<Session> {
    const { idempotencyKey, messageId } = request;
    const rewind = Boolean(request.rewindFromHead);
    const pending = this.pending.get(idempotencyKey);
    if (pending) {
      if (
        pending.sourceSessionId !== sourceSessionId ||
        pending.messageId !== messageId ||
        pending.rewind !== rewind
      )
        throw new AppError('FORK_REQUEST_CONFLICT', '分支请求已用于其他消息。', 409);
      return pending.result;
    }
    const existing = this.findExisting(idempotencyKey);
    if (existing) {
      if (
        existing.fork?.sourceSessionId !== sourceSessionId ||
        existing.fork.sourceMessageId !== messageId ||
        (existing.fork.kind === 'rewind') !== rewind
      )
        throw new AppError('FORK_REQUEST_CONFLICT', '分支请求已用于其他消息。', 409);
      if (existing.creatingFork)
        throw new AppError('FORK_NOT_READY', '分支仍在创建，请重试。', 409, true);
      return publicSession(existing);
    }
    if (
      rewind &&
      [...this.pending.values()].some(
        (item) => item.rewind && item.sourceSessionId === sourceSessionId,
      )
    )
      throw new AppError('REWIND_PENDING', '此会话正在回退，请稍后重试。', 409, true);
    const result = this.createFromMessage(sourceSessionId, request);
    this.pending.set(idempotencyKey, { sourceSessionId, messageId, rewind, result });
    try {
      return await result;
    } finally {
      this.pending.delete(idempotencyKey);
    }
  }

  private findExisting(id: string) {
    try {
      return this.store.get('sessions', id);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'NOT_FOUND') throw error;
      return undefined;
    }
  }

  private async createFromMessage(
    sourceSessionId: string,
    { messageId, idempotencyKey: id, rewindFromHead }: SessionForkRequest,
  ) {
    const initial = this.store.sessionSnapshots.read(sourceSessionId);
    const message = initial.messages.find((item) => item.id === messageId);
    const recovered = message && !message.forkAnchor && (await this.restoreLegacyAnchors(initial));
    const records = recovered ? this.store.sessionSnapshots.read(sourceSessionId) : initial;
    const { session: source, messages, runs, project } = records;
    const index = messages.findIndex((message) => message.id === messageId);
    const anchor = messages[index]?.forkAnchor;
    const run = runs.find((item) => item.id === messages[index]?.runId);
    if (source.creatingFork || !anchor || !run || activeStatuses.includes(run.status))
      throw new AppError('FORK_POINT_UNAVAILABLE', '该消息目前没有可用的分支起点。', 409);
    if (rewindFromHead) this.validateRewind(records, messageId, rewindFromHead);
    const targetDirectory = this.sdkDirectory(id);
    const existingDirectory = await lstat(targetDirectory).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existingDirectory)
      throw new AppError('FORK_REQUEST_CONFLICT', '分支保存位置已存在，请重新发起分支操作。', 409);
    const title = rewindFromHead ? source.title : `${source.title.slice(0, 155)} · 分支`;
    const at = now();
    this.store.put('sessions', {
      id,
      projectId: project.id,
      ...(source.agentRevisionId ? { agentRevisionId: source.agentRevisionId } : {}),
      title,
      status: 'active',
      sdkSessionId: null,
      sdkMode: run.mode,
      sdkConfigKey: anchor.configKey,
      createdAt: at,
      updatedAt: at,
      creatingFork: true,
      fork: {
        sourceSessionId,
        sourceMessageId: messageId,
        sourceTitle: source.title,
        ...(rewindFromHead ? { kind: 'rewind' } : {}),
      },
      inheritedMessages: [
        ...(source.inheritedMessages ?? []),
        ...messages
          .slice(0, index + 1)
          .map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
      ],
      draft: {
        text: '',
        contextPaths: [],
        attachmentIds: [],
        mode: run.mode,
        model: run.config.model,
        effort: run.config.effort,
      },
    });
    try {
      const projectPath = await (this.resolveWorkspace?.(source) ??
        resolveProjectPath(project.path, '', { directory: true }));
      const sdkSessionId = await this.forkTranscript({
        projectPath,
        sourceDirectory: this.sdkDirectory(source.id),
        targetDirectory: this.sdkDirectory(id),
        sourceSessionId: anchor.sdkSessionId,
        upToMessageId: anchor.messageId,
        title,
      });
      const session = this.store.transaction(() => {
        if (rewindFromHead)
          this.validateRewind(
            this.store.sessionSnapshots.read(sourceSessionId),
            messageId,
            rewindFromHead,
          );
        const worktree = this.store.gitWorktrees.forSession(source.id);
        if (worktree) this.store.gitWorktrees.bind(id, worktree.id);
        const ready = this.store.update('sessions', id, { sdkSessionId, creatingFork: undefined });
        this.store.event(`session-${id}`, id, 'session.created', { sourceSessionId });
        return ready;
      });
      return publicSession(session);
    } catch (error) {
      await this.removeUnfinished(id);
      if (error instanceof AppError) throw error;
      throw new AppError('FORK_POINT_UNAVAILABLE', '无法读取该消息的分支起点，请重新选择。', 409);
    }
  }

  private validateRewind(
    { session, messages, runs, permissions }: SessionSnapshotRecords,
    messageId: string,
    expectedHead: string,
  ): void {
    if (session.status === 'archived')
      throw new AppError('SESSION_ARCHIVED', '请先恢复归档会话再回退。', 409);
    if (
      runs.some(({ status }) => activeStatuses.includes(status)) ||
      permissions.some(({ status }) => status === 'pending') ||
      this.hasPendingMessages(session.id)
    )
      throw new AppError('REWIND_BUSY', '请先处理此会话的运行、待审批和排队消息。', 409);
    if (messages.at(-1)?.id !== expectedHead || expectedHead === messageId)
      throw new AppError('REWIND_CHANGED', '会话已变化，请重新选择回退位置。', 409);
  }

  private sdkDirectory(id: string): string {
    return join(this.store.directory, 'sdk', z.uuid().parse(id));
  }

  private async removeUnfinished(id: string) {
    await rm(this.sdkDirectory(id), { recursive: true, force: true });
    this.store.delete('sessions', id);
  }
}

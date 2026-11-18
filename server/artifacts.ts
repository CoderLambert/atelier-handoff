import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { AppError, now, type Run } from '../shared/types.js';
import { Store } from './store.js';
import { fingerprint, mimeFor, safeName, textExtensions } from './files.js';

export class FileRecords {
  constructor(private readonly store: Store) {}
  private path(kind: 'artifacts' | 'attachments', id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError('NOT_FOUND', '文件记录不存在。', 404);
    return join(this.store.directory, kind, id);
  }
  async upload(sessionId: string, name: string, contentBase64: string) {
    this.store.get('sessions', sessionId);
    name = safeName(name);
    if (!textExtensions.has(extname(name).toLowerCase()))
      throw new AppError('UNSUPPORTED_FILE', '首版仅接受支持的 UTF-8 文本文件。');
    if (
      contentBase64.length > 1_400_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)
    )
      throw new AppError('INVALID_UPLOAD', '附件编码无效或文件过大。', 413);
    const bytes = Buffer.from(contentBase64, 'base64');
    if (bytes.length > 1024 * 1024)
      throw new AppError('UPLOAD_TOO_LARGE', '单个附件不能超过 1 MiB。', 413);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (bytes.includes(0)) throw new Error();
    } catch {
      throw new AppError('UNSUPPORTED_ENCODING', '请上传 UTF-8 文本文件。');
    }
    const attachment = {
      id: randomUUID(),
      sessionId,
      name,
      mime: mimeFor(name),
      size: bytes.length,
      status: 'ready' as const,
      createdAt: now(),
    };
    await mkdir(join(this.store.directory, 'attachments'), { recursive: true, mode: 0o700 });
    await writeFile(this.path('attachments', attachment.id), bytes, { flag: 'wx', mode: 0o600 });
    this.store.put('attachments', attachment);
    this.store.event('session-' + sessionId, sessionId, 'attachment.created', {
      attachmentId: attachment.id,
    });
    return attachment;
  }
  async attachmentText(id: string, sessionId: string): Promise<string> {
    const attachment = this.store.get('attachments', id);
    if (attachment.sessionId !== sessionId || attachment.removed)
      throw new AppError('CONTEXT_DENIED', '附件不属于当前会话或已移除。', 403);
    return readFile(this.path('attachments', id), 'utf8');
  }
  async removeAttachment(id: string, sessionId: string): Promise<void> {
    const item = this.store.get('attachments', id);
    if (item.sessionId !== sessionId)
      throw new AppError('CONTEXT_DENIED', '附件不属于当前会话。', 403);
    this.store.update('attachments', id, { removed: true });
    const session = this.store.get('sessions', sessionId);
    this.store.update('sessions', sessionId, {
      draft: {
        ...session.draft,
        attachmentIds: session.draft.attachmentIds.filter((value) => value !== id),
      },
    });
    // Used content remains immutable for previous run snapshots.
    if (item.status === 'ready') await unlink(this.path('attachments', id)).catch(() => {});
    this.store.event('session-' + sessionId, sessionId, 'attachment.removed', { attachmentId: id });
  }
  async publish(run: Run, name: string, content: string) {
    if (Buffer.byteLength(content) > 1024 * 1024)
      throw new AppError('ARTIFACT_TOO_LARGE', '成果超过 1 MiB 文本限制。', 413);
    name = safeName(name);
    const artifact = {
      id: randomUUID(),
      runId: run.id,
      sessionId: run.sessionId,
      projectId: run.projectId,
      name,
      mime: mimeFor(name),
      size: Buffer.byteLength(content),
      fingerprint: fingerprint(content),
      availability: 'available' as const,
      createdAt: now(),
    };
    await mkdir(join(this.store.directory, 'artifacts'), { recursive: true, mode: 0o700 });
    await writeFile(this.path('artifacts', artifact.id), content, { mode: 0o600, flag: 'wx' });
    this.store.put('artifacts', artifact);
    this.store.event(run.id, run.sessionId, 'artifact.created', { artifactId: artifact.id });
    return artifact;
  }
  async content(id: string) {
    const artifact = this.store.get('artifacts', id);
    this.store.get('sessions', artifact.sessionId);
    try {
      const bytes = await readFile(this.path('artifacts', id));
      if (fingerprint(bytes) !== artifact.fingerprint) throw new Error('changed');
      return { artifact, bytes };
    } catch {
      this.store.update('artifacts', id, { availability: 'unavailable' });
      throw new AppError('ARTIFACT_UNAVAILABLE', '成果文件丢失或版本不匹配。', 409);
    }
  }
  saveOutput(id: string, output: string): void {
    mkdirSync(join(this.store.directory, 'tool-output'), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.store.directory, 'tool-output', fingerprint(id)), output, {
      mode: 0o600,
    });
  }
  async toolOutput(id: string): Promise<string> {
    const tool = this.store.get('tools', id);
    this.store.get('sessions', tool.sessionId);
    if (!tool.outputTruncated) return tool.output;
    try {
      return await readFile(join(this.store.directory, 'tool-output', fingerprint(id)), 'utf8');
    } catch {
      throw new AppError('OUTPUT_UNAVAILABLE', '完整工具输出已丢失，短预览仍可查看。', 404);
    }
  }
  async deleteSessionFiles(sessionId: string): Promise<void> {
    for (const tool of this.store.list('tools').filter((tool) => tool.sessionId === sessionId))
      await unlink(join(this.store.directory, 'tool-output', fingerprint(tool.id))).catch(() => {});
    for (const kind of ['attachments', 'artifacts'] as const)
      for (const item of this.store.list(kind).filter((item) => item.sessionId === sessionId))
        await unlink(this.path(kind, item.id)).catch(() => {});
  }
}

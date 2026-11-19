import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile, unlink } from 'node:fs/promises';
import { join, extname, relative, sep } from 'node:path';
import { AppError, now, type Artifact, type Run } from '../shared/types.js';
import { Store } from './store.js';
import { fingerprint, mimeFor, resolveProjectPath, safeName, textExtensions } from './files.js';

const MAX_TEXT_ARTIFACT = 1024 * 1024;
const MAX_PDF_ARTIFACT = 16 * 1024 * 1024;

async function readOutputFile(root: string, path: string, limit: number): Promise<Buffer> {
  const target = await resolveProjectPath(root, path);
  const parts = relative(root, target).split(sep);
  const directoryFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
  let directory;
  let handle;
  try {
    directory = await open(root, directoryFlags);
    const rootStat = await directory.stat();
    const expectedRoot = await lstat(root);
    if (
      (await realpath(root)) !== root ||
      !expectedRoot.isDirectory() ||
      rootStat.dev !== expectedRoot.dev ||
      rootStat.ino !== expectedRoot.ino
    )
      throw new AppError('PATH_DENIED', '成果输出目录已改变。', 403);
    // Resolve one component at a time from an open directory. The scratch writer can
    // replace names concurrently; O_NOFOLLOW alone only protects the final component.
    for (const part of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, directoryFlags);
      await directory.close();
      directory = next;
    }
    handle = await open(
      `/proc/self/fd/${directory.fd}/${parts.at(-1)!}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      throw new AppError('PATH_DENIED', '成果必须是没有链接的普通文件。', 403);
    if (before.size > BigInt(limit))
      throw new AppError('ARTIFACT_TOO_LARGE', '成果文件超过大小限制。', 413);
    // One extra byte detects growth without an unbounded readFile allocation.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (size > limit) throw new AppError('ARTIFACT_TOO_LARGE', '成果文件超过大小限制。', 413);
    if (
      BigInt(size) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.nlink !== 1n
    )
      throw new AppError('ARTIFACT_CHANGED', '成果文件在发布期间变化，请重试。', 409);
    return buffer.subarray(0, size);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new AppError('PATH_DENIED', '成果路径包含链接或非目录。', 403);
    throw new AppError('FILE_UNAVAILABLE', '成果文件不存在或不可访问。', 404);
  } finally {
    await handle?.close();
    await directory?.close();
  }
}

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
    await mkdir(join(this.store.directory, 'attachments'), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(this.path('attachments', attachment.id), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
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
    this.store.event('session-' + sessionId, sessionId, 'attachment.removed', {
      attachmentId: id,
    });
  }
  async publish(run: Run, name: string, content: string): Promise<Artifact> {
    if (Buffer.byteLength(content) > MAX_TEXT_ARTIFACT)
      throw new AppError('ARTIFACT_TOO_LARGE', '成果超过 1 MiB 文本限制。', 413);
    name = safeName(name);
    return this.publishBytes(run, name, Buffer.from(content), mimeFor(name));
  }
  async publishFile(run: Run, outputRoot: string, path: string): Promise<Artifact> {
    const name = safeName(path);
    const extension = extname(name).toLowerCase();
    const pdf = extension === '.pdf';
    if (!pdf && !textExtensions.has(extension))
      throw new AppError('UNSUPPORTED_FILE', '成果仅支持 PDF 和 UTF-8 文本文件。');
    const bytes = await readOutputFile(
      outputRoot,
      path,
      pdf ? MAX_PDF_ARTIFACT : MAX_TEXT_ARTIFACT,
    );
    if (pdf) {
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
        throw new AppError('UNSUPPORTED_FILE', '成果文件不是有效的 PDF。');
    } else {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (bytes.includes(0)) throw new Error();
      } catch {
        throw new AppError('UNSUPPORTED_ENCODING', '成果文本文件必须使用 UTF-8 编码。');
      }
    }
    const mime = pdf
      ? 'application/pdf'
      : extension === '.csv'
        ? 'text/csv'
        : mimeFor(name.toLowerCase());
    return this.publishBytes(run, name, bytes, mime);
  }
  private async publishBytes(
    run: Run,
    name: string,
    bytes: Buffer,
    mime: string,
  ): Promise<Artifact> {
    const artifact: Artifact = {
      id: randomUUID(),
      runId: run.id,
      sessionId: run.sessionId,
      projectId: run.projectId,
      name,
      mime,
      size: bytes.length,
      fingerprint: fingerprint(bytes),
      availability: 'available',
      createdAt: now(),
    };
    await mkdir(join(this.store.directory, 'artifacts'), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(this.path('artifacts', artifact.id), bytes, {
      mode: 0o600,
      flag: 'wx',
    });
    this.store.put('artifacts', artifact);
    this.store.event(run.id, run.sessionId, 'artifact.created', {
      artifactId: artifact.id,
    });
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
    mkdirSync(join(this.store.directory, 'tool-output'), {
      recursive: true,
      mode: 0o700,
    });
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

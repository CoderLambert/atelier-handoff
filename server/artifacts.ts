/**
 * @file 管理会话附件、交付物与工具结果的本地原件。
 * @implementation 流式接收文档并核对归属，保存工具回执和 SDK 提供的 Bash 日志，按会话读取与清理。
 * @updated 2026-11-22T21:17:02+08:00
 */
import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, writeFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { join, extname, relative, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { documentAttachmentMime } from '../shared/document-attachments.js';
import { validateDocumentFile } from './attachment-document-reader.js';
import {
  captureSdkBashLog,
  captureSdkBashTaskLog,
  discardCapturedBashLog,
  publishBashLog,
  readCapturedBashLog,
} from './bash-log-capture.js';
import {
  AppError,
  attachmentImageMime,
  maxImageAttachmentBytes,
  now,
  type Artifact,
  type Run,
  type ToolCall,
} from '../shared/types.js';
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
    const image = attachmentImageMime(name);
    if (!image && !textExtensions.has(extname(name).toLowerCase()))
      throw new AppError('UNSUPPORTED_FILE', '仅接受 PNG、JPEG 和支持的 UTF-8 文本文件。');
    const limit = image ? maxImageAttachmentBytes : 1024 * 1024;
    if (contentBase64.length > Math.ceil(limit / 3) * 4 || /[^A-Za-z0-9+/=]/.test(contentBase64))
      throw new AppError('INVALID_UPLOAD', '附件编码无效或文件过大。', 413);
    const bytes = Buffer.from(contentBase64, 'base64');
    if (bytes.length > limit || bytes.toString('base64') !== contentBase64)
      throw new AppError('INVALID_UPLOAD', '附件编码无效或文件过大。', 413);
    if (image) {
      const valid =
        image === 'image/png'
          ? bytes.length >= 33 &&
            bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
            bytes.readUInt32BE(8) === 13 &&
            bytes.toString('ascii', 12, 16) === 'IHDR' &&
            bytes.readUInt32BE(16) > 0 &&
            bytes.readUInt32BE(20) > 0 &&
            bytes.readUInt32BE(16) * bytes.readUInt32BE(20) <= 20_000_000
          : bytes.length >= 8 &&
            bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) &&
            bytes.subarray(-2).equals(Buffer.from('ffd9', 'hex'));
      if (!valid) throw new AppError('INVALID_IMAGE', '图片格式无效或尺寸超出限制。', 422);
    } else {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (bytes.includes(0)) throw new Error();
      } catch {
        throw new AppError('UNSUPPORTED_ENCODING', '请上传 UTF-8 文本文件。');
      }
    }
    const attachment = {
      id: randomUUID(),
      sessionId,
      name,
      mime: image ?? mimeFor(name),
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
  async uploadDocument(sessionId: string, name: string, request: IncomingMessage) {
    this.store.get('sessions', sessionId);
    name = safeName(name);
    const mime = documentAttachmentMime(name);
    if (!mime) throw new AppError('UNSUPPORTED_FILE', '此文件格式不支持文档上传。', 415);
    const directory = join(this.store.directory, 'attachments');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const disk = await statfs(directory, { bigint: true });
    const declared = request.headers['content-length'];
    const free = disk.bavail * disk.bsize;
    if (declared && BigInt(declared) > free)
      throw new AppError('ATTACHMENT_DISK_FULL', '磁盘空间不足，无法保存附件。', 507);
    const staging = await mkdtemp(join(directory, '.upload-'));
    const temporary = join(staging, name);
    let size = 0;
    try {
      const output = await open(temporary, 'wx', 0o600);
      try {
        for await (const input of request.iterator({ destroyOnReturn: false })) {
          const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input as Uint8Array);
          size += chunk.length;
          if (BigInt(size) > free)
            throw new AppError('ATTACHMENT_DISK_FULL', '磁盘空间不足，无法保存附件。', 507);
          for (let offset = 0; offset < chunk.length;) {
            const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
            offset += bytesWritten;
          }
        }
      } finally {
        await output.close();
      }
      if (request.aborted || !size || (declared && BigInt(size) !== BigInt(declared)))
        throw new AppError('INVALID_UPLOAD', '文档上传未完成或文件为空。', 400);
      await validateDocumentFile(temporary, mime);
      this.store.get('sessions', sessionId);
      const attachment = {
        id: randomUUID(),
        sessionId,
        name,
        mime,
        size,
        status: 'ready' as const,
        createdAt: now(),
      };
      const destination = this.path('attachments', attachment.id);
      await rename(temporary, destination);
      try {
        this.store.put('attachments', attachment);
      } catch (error) {
        await unlink(destination);
        throw error;
      }
      this.store.event('session-' + sessionId, sessionId, 'attachment.created', {
        attachmentId: attachment.id,
      });
      return attachment;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC')
        throw new AppError('ATTACHMENT_DISK_FULL', '磁盘空间不足，无法保存附件。', 507);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  attachmentFile(id: string, sessionId: string) {
    const attachment = this.store.get('attachments', id);
    if (attachment.sessionId !== sessionId || attachment.removed)
      throw new AppError('CONTEXT_DENIED', '附件不属于当前会话或已移除。', 403);
    return { attachment, path: this.path('attachments', id) };
  }
  async attachmentContent(id: string, sessionId: string) {
    const { attachment, path } = this.attachmentFile(id, sessionId);
    return { attachment, bytes: await readFile(path) };
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
  async publishScreenshot(run: Run, data: string) {
    const max = 768 * 1024;
    if (data.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
      throw new AppError('INVALID_SCREENSHOT', '浏览器截图数据无效或超过大小限制。', 422);
    const bytes = Buffer.from(data, 'base64');
    if (
      bytes.length < 33 ||
      bytes.length > max ||
      !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw new AppError('INVALID_SCREENSHOT', '浏览器没有返回有效的 PNG 截图。', 422);
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > 16_000_000)
      throw new AppError('INVALID_SCREENSHOT', '浏览器截图尺寸超出限制。', 422);
    return this.publishBytes(run, '网页截图.png', bytes, 'image/png');
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
  async captureBashLog(
    id: string,
    sdkRoot: string,
    sdkSessionId: string,
    toolUseId: string,
    response: unknown,
    signal?: AbortSignal,
    sdkActorId?: string,
    task?: { scratch: string; id: string; outputFile: string },
  ): Promise<ToolCall['bashLog']> {
    try {
      signal?.throwIfAborted();
      const tool = this.store.get('tools', id);
      const run = this.store.get('runs', tool.runId);
      const session = this.store.get('sessions', tool.sessionId);
      const project = this.store.get('projects', run.projectId);
      const assertCurrent = () => {
        signal?.throwIfAborted();
        const currentTool = this.store.get('tools', id);
        const currentRun = this.store.get('runs', run.id);
        const currentSession = this.store.get('sessions', session.id);
        const currentProject = this.store.get('projects', project.id);
        if (
          currentTool.name !== 'Bash' ||
          currentTool.runId !== run.id ||
          currentTool.sessionId !== session.id ||
          currentTool.subagentId !== tool.subagentId ||
          (currentTool.status !== 'running' && currentTool.status !== 'awaiting_permission') ||
          currentRun.sessionId !== session.id ||
          currentRun.projectId !== project.id ||
          !['running', 'awaiting_permission'].includes(currentRun.status) ||
          currentSession.projectId !== project.id ||
          currentSession.sdkSessionId !== sdkSessionId ||
          currentProject.path !== project.path ||
          sdkRoot !== join(this.store.directory, 'sdk', session.id) ||
          !/^[a-zA-Z0-9_-]{1,200}$/.test(toolUseId) ||
          Boolean(tool.subagentId) !== Boolean(sdkActorId) ||
          id !== `${run.id}:${sdkActorId ? `${sdkActorId}:` : ''}${toolUseId}`
        )
          throw new Error('Bash log ownership changed');
      };
      assertCurrent();
      // Only the caller can bind the opaque spill filename to this exact SDK Hook.
      // Keep response and toolUseId paired; serialize duplicate completion/cancel cleanup.
      const cwd = run.workspacePath ?? project.path;
      const snapshot = task
        ? await captureSdkBashTaskLog(task.scratch, cwd, sdkSessionId, task, signal)
        : await captureSdkBashLog(sdkRoot, cwd, sdkSessionId, response, signal);
      if (!snapshot) return undefined;
      return await publishBashLog(
        this.store.directory,
        fingerprint(id),
        snapshot,
        assertCurrent,
        signal,
      );
    } catch {
      signal?.throwIfAborted();
      return { status: 'unavailable' };
    }
  }
  async discardBashLog(id: string): Promise<void> {
    await discardCapturedBashLog(this.store.directory, fingerprint(id));
  }
  async toolOutput(id: string, display = false): Promise<string> {
    const tool = this.store.get('tools', id);
    this.store.get('sessions', tool.sessionId);
    if (
      display &&
      tool.name === 'Bash' &&
      tool.bashLog &&
      ['complete', 'partial'].includes(tool.bashLog.status)
    ) {
      try {
        return await readCapturedBashLog(this.store.directory, fingerprint(id), tool.bashLog);
      } catch {
        throw new AppError(
          'OUTPUT_UNAVAILABLE',
          '已采集的命令日志丢失或损坏，原始回执仍可查看。',
          404,
        );
      }
    }
    let text = tool.output;
    if (tool.outputTruncated) {
      try {
        text = await readFile(join(this.store.directory, 'tool-output', fingerprint(id)), 'utf8');
      } catch {
        throw new AppError('OUTPUT_UNAVAILABLE', '完整工具输出已丢失，短预览仍可查看。', 404);
      }
    }
    if (!display || !['Bash', 'mcp__atelier__run_command', 'run_command'].includes(tool.name))
      return text;
    try {
      const result: unknown = JSON.parse(text);
      if (typeof result !== 'object' || result === null) return text;
      if (
        tool.name === 'Bash' &&
        'stdout' in result &&
        'stderr' in result &&
        typeof result.stdout === 'string' &&
        typeof result.stderr === 'string'
      ) {
        return (
          [result.stdout && `stdout\n${result.stdout}`, result.stderr && `stderr\n${result.stderr}`]
            .filter(Boolean)
            .join('\n\n') || text
        );
      }
      if (
        tool.name !== 'Bash' &&
        'output' in result &&
        typeof result.output === 'string' &&
        result.output
      )
        return result.output;
    } catch {
      /* Historic text and command errors can be rendered directly. */
    }
    return text;
  }
  async deleteSessionFiles(sessionId: string): Promise<void> {
    for (const tool of this.store.list('tools').filter((tool) => tool.sessionId === sessionId)) {
      await unlink(join(this.store.directory, 'tool-output', fingerprint(tool.id))).catch(() => {});
      if (tool.bashLog?.status === 'complete' || tool.bashLog?.status === 'partial')
        await this.discardBashLog(tool.id);
    }
    for (const kind of ['attachments', 'artifacts'] as const)
      for (const item of this.store.list(kind).filter((item) => item.sessionId === sessionId))
        await unlink(this.path(kind, item.id)).catch(() => {});
  }
}

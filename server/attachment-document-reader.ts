/**
 * @file 为附件准备可分段读取的本地纯文本视图。
 * @implementation 在有堆预算和超时的独立 worker 中校验、解析文档；取消或失败后终止 worker 并删除本次临时输出。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { access, lstat, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AppError } from '../shared/errors.js';
import {
  documentMimeSchema,
  documentParserLimits,
  documentReplySchema,
  type DocumentJob,
  type DocumentReply,
} from './attachment-document-protocol.js';

export { documentParserLimits } from './attachment-document-protocol.js';

export interface DocumentView {
  files: { name: string; path: string; description: string }[];
  preview: string;
}

async function workerEntry(): Promise<URL> {
  const compiled = new URL('./attachment-document-worker.js', import.meta.url);
  try {
    await access(compiled);
    return compiled;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  // Installed builds use .js directly and never resolve this development dependency.
  const source = new URL('./attachment-document-worker.ts', import.meta.url);
  await access(source);
  const bootstrap = `import { tsImport } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
await tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)});`;
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
}

async function runWorker(
  job: DocumentJob,
  signal?: AbortSignal,
): Promise<Extract<DocumentReply, { ok: true }>> {
  signal?.throwIfAborted();
  const entry = await workerEntry();
  signal?.throwIfAborted();
  const worker = new Worker(entry, {
    workerData: job,
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: documentParserLimits.oldGenerationMb,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 8,
    },
    // Parser diagnostics must not copy attachment text to the runtime's logs.
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  try {
    const reply = await new Promise<DocumentReply>((resolveReply, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        worker.removeListener('message', onMessage);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const onAbort = () =>
        fail(signal?.reason ?? new DOMException('Document parsing cancelled.', 'AbortError'));
      const onMessage = (value: unknown) => {
        const parsed = documentReplySchema.safeParse(value);
        if (!parsed.success) {
          fail(
            new AppError(
              'DOCUMENT_WORKER_FAILED',
              'Document parser returned an invalid result.',
              422,
            ),
          );
          return;
        }
        cleanup();
        resolveReply(parsed.data);
      };
      const onError = (error: Error) =>
        fail(
          new AppError(
            'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? 'DOCUMENT_RESOURCE_LIMIT'
              : 'DOCUMENT_WORKER_FAILED',
            'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? `Document parsing exceeded its ${documentParserLimits.oldGenerationMb} MiB worker heap budget.`
              : 'Document parser worker could not finish.',
            422,
          ),
        );
      const onExit = () =>
        fail(
          new AppError('DOCUMENT_WORKER_FAILED', 'Document parser exited without a result.', 422),
        );
      const timer = setTimeout(
        () =>
          fail(
            new AppError(
              'DOCUMENT_TIMEOUT',
              `Document parsing exceeded its ${documentParserLimits.timeoutMs / 1000} second time budget.`,
              422,
            ),
          ),
        documentParserLimits.timeoutMs,
      );
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    if (!reply.ok) throw new AppError(reply.code, reply.message, 422);
    return reply;
  } finally {
    // Wait for termination before deleting output: no parser can recreate a partial file afterward.
    await worker.terminate();
  }
}

/** Basic signatures and Office named entries only; does not inflate or parse document content. */
export async function validateDocumentFile(path: string, mime: string): Promise<void> {
  const parsed = documentMimeSchema.safeParse(mime);
  if (!parsed.success)
    throw new AppError('DOCUMENT_UNSUPPORTED', 'Unsupported document MIME type.', 415);
  await runWorker({ operation: 'validate', path: resolve(path), mime: parsed.data });
}

/** The caller supplies an existing private directory and retains ownership of successful output. */
export async function prepareDocumentView(input: {
  path: string;
  mime: string;
  directory: string;
  signal?: AbortSignal;
}): Promise<DocumentView> {
  input.signal?.throwIfAborted();
  const parsed = documentMimeSchema.safeParse(input.mime);
  if (!parsed.success)
    throw new AppError('DOCUMENT_UNSUPPORTED', 'Unsupported document MIME type.', 415);
  const directory = resolve(input.directory);
  const info = await lstat(directory);
  if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
    throw new AppError(
      'DOCUMENT_DIRECTORY_INVALID',
      'Document output requires an existing private directory.',
      422,
    );
  const destination = await mkdtemp(join(directory, 'document-'));
  try {
    const result = await runWorker(
      {
        operation: 'prepare',
        path: resolve(input.path),
        mime: parsed.data,
        directory: destination,
      },
      input.signal,
    );
    input.signal?.throwIfAborted();
    const files = result.files.map((file) => ({ ...file, path: join(destination, file.name) }));
    for (const file of files) {
      const output = await lstat(file.path);
      if (!output.isFile())
        throw new AppError('DOCUMENT_WORKER_FAILED', 'Document parser output is unavailable.', 422);
    }
    return { files, preview: result.preview };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

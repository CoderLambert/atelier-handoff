/**
 * @file 将原生 SDK 会话分支安装到独立的子会话配置目录。
 * @implementation 只暂存源 transcript，在独立环境的 worker 内调用 forkSession，原子安装结果后清理本次暂存；不修改宿主环境或源配置。
 * @updated 2026-11-21T22:00:00+08:00
 */
import { constants, createWriteStream } from 'node:fs';
import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import {
  legacyForkReplySchema,
  sessionForkJobSchema,
  sessionForkReplySchema,
  sessionForkRequestSchema,
  type SessionForkRequest,
} from './session-fork-sdk-protocol.js';

const timeoutMs = 30_000;

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function ordinaryDirectory(path: string): Promise<string> {
  if (!(await lstat(path)).isDirectory())
    throw new Error('Session fork requires ordinary directories.');
  return realpath(path);
}

// Resolve missing roots before creating anything, so overlap rejection never writes into the source.
async function prospectiveDirectory(path: string): Promise<string> {
  try {
    return await ordinaryDirectory(path);
  } catch (error) {
    if (!missing(error)) throw error;
    return join(await prospectiveDirectory(dirname(path)), basename(path));
  }
}

async function ensureDirectory(path: string): Promise<string> {
  try {
    await lstat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    await ensureDirectory(dirname(path));
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (mkdirError) {
      if (!(mkdirError instanceof Error && 'code' in mkdirError && mkdirError.code === 'EEXIST'))
        throw mkdirError;
    }
  }
  return ordinaryDirectory(path);
}

function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

async function sourceTranscript(directory: string, sessionId: string): Promise<string> {
  const projects = await ordinaryDirectory(join(directory, 'projects'));
  let found: string | undefined;
  for (const entry of await readdir(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
    try {
      if (!(await lstat(candidate)).isFile())
        throw new Error('Session fork source transcript must be an ordinary file.');
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (found) throw new Error('Session fork source transcript is ambiguous.');
    found = candidate;
  }
  if (!found) throw new Error('Session fork source transcript was not found.');
  return found;
}

async function workerEntry(): Promise<URL> {
  const compiled = new URL('./session-fork-sdk-worker.js', import.meta.url);
  try {
    await access(compiled);
    return compiled;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  // The installed runtime contains .js helpers and does not need tsx.
  const source = new URL('./session-fork-sdk-worker.ts', import.meta.url);
  await access(source);
  const bootstrap = `import { tsImport } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
await tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)});`;
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
}

async function runSessionWorker<T>(
  job: z.infer<typeof sessionForkJobSchema>,
  directory: string,
  reply: z.ZodType<T>,
  budget = timeoutMs,
): Promise<T> {
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CONFIG_DIR: directory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  };
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'])
    if (process.env[key]) env[key] = process.env[key];
  const worker = new Worker(await workerEntry(), {
    env,
    execArgv: [],
    workerData: job,
    stdout: true,
    stderr: true,
  });
  // Native diagnostics must not copy transcript contents into runtime logs.
  worker.stdout.resume();
  worker.stderr.resume();
  try {
    return await new Promise<T>((resolveReply, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeListener('message', onMessage);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onMessage = (value: unknown) => {
        const parsed = reply.safeParse(value);
        if (!parsed.success)
          return fail(new Error('Session fork helper returned an invalid result.'));
        cleanup();
        resolveReply(parsed.data);
      };
      const onError = () => fail(new Error('Session fork helper failed.'));
      const onExit = () => fail(new Error('Session fork helper exited without a result.'));
      const timer = setTimeout(
        () => fail(new Error('SDK session worker exceeded its time budget.')),
        budget,
      );
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
    });
  } finally {
    // Stop all native writes before the caller removes owned staging.
    await worker.terminate();
  }
}

async function nativeFork(job: SessionForkRequest, directory: string): Promise<string> {
  const result = await runSessionWorker(
    {
      kind: 'fork',
      projectPath: job.projectPath,
      sourceSessionId: job.sourceSessionId,
      upToMessageId: job.upToMessageId,
      title: job.title,
    },
    directory,
    sessionForkReplySchema,
  );
  if (!result.ok) throw new Error(result.message);
  return result.sessionId;
}

export async function readLegacyForkTurns(projectPath: string, directory: string) {
  const configDirectory = await ordinaryDirectory(directory);
  const projects = await ordinaryDirectory(join(configDirectory, 'projects'));
  const found = new Set<string>();
  for (const folder of await readdir(projects, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const file of await readdir(join(projects, folder.name), { withFileTypes: true })) {
      if (!file.name.endsWith('.jsonl')) continue;
      const id = z.uuid().safeParse(file.name.slice(0, -6));
      if (!id.success) continue;
      if (!file.isFile() || found.has(id.data))
        throw new Error('SDK transcript ownership is ambiguous.');
      found.add(id.data);
    }
  }
  if (!found.size || found.size > 128) return [];
  const result = await runSessionWorker(
    { kind: 'read', projectPath, sourceSessionIds: [...found] },
    configDirectory,
    legacyForkReplySchema,
    2500,
  );
  if (!result.ok) throw new Error('Legacy SDK transcript could not be read.');
  return result.turns;
}

/** Fork locally, returning only after the child config owns its complete native transcript. */
export async function forkSessionTranscript(input: {
  projectPath: string;
  sourceDirectory: string;
  targetDirectory: string;
  sourceSessionId: string;
  upToMessageId: string;
  title: string;
}): Promise<string> {
  const job = sessionForkRequestSchema.parse(input);
  job.projectPath = await ordinaryDirectory(resolve(job.projectPath));
  job.sourceDirectory = await ordinaryDirectory(resolve(job.sourceDirectory));
  job.targetDirectory = await prospectiveDirectory(resolve(job.targetDirectory));
  if (
    contains(job.sourceDirectory, job.targetDirectory) ||
    contains(job.targetDirectory, job.sourceDirectory)
  )
    throw new Error('Source and child SDK config directories must be separate.');
  const source = await sourceTranscript(job.sourceDirectory, job.sourceSessionId);
  await ensureDirectory(job.targetDirectory);
  const transcriptPath = relative(job.sourceDirectory, source);
  const staging = await mkdtemp(join(tmpdir(), 'atelier-session-fork-'));
  let temporary: string | undefined;
  try {
    const stagedSource = join(staging, transcriptPath);
    await mkdir(dirname(stagedSource), { recursive: true, mode: 0o700 });
    const handle = await open(
      source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile())
        throw new Error('Session fork source transcript must be an ordinary file.');
      await pipeline(
        handle.createReadStream(),
        createWriteStream(stagedSource, { flags: 'wx', mode: 0o600 }),
      );
    } finally {
      await handle.close();
    }
    const sessionId = await nativeFork(job, staging);
    if (sessionId === job.sourceSessionId)
      throw new Error('Native SDK did not create a new session.');
    const nativeTranscript = await sourceTranscript(staging, sessionId);
    const destination = join(job.targetDirectory, relative(staging, nativeTranscript));
    // Check every existing child component, including projects/, before publishing beneath it.
    let destinationDirectory = job.targetDirectory;
    for (const component of relative(job.targetDirectory, dirname(destination)).split(sep))
      destinationDirectory = await ensureDirectory(join(destinationDirectory, component));
    const temporaryPath = join(destinationDirectory, `.${sessionId}.${randomUUID()}.tmp`);
    await copyFile(nativeTranscript, temporaryPath, constants.COPYFILE_EXCL);
    temporary = temporaryPath;
    const installed = await open(temporary, 'r');
    try {
      await installed.sync();
    } finally {
      await installed.close();
    }
    // link publishes a complete file atomically and fails if the child ID already exists.
    await link(temporary, destination);
    return sessionId;
  } finally {
    await Promise.all([
      ...(temporary ? [rm(temporary, { force: true })] : []),
      rm(staging, { recursive: true, force: true }),
    ]);
  }
}

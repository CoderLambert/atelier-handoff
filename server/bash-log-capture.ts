/**
 * @file 安全读取锁定 SDK 明示的 Bash 日志并保存独立副本。
 * @implementation 校验 config/project/session 路径，以固定目录和文件描述符拒绝链接、特殊文件及竞态，限幅 UTF-8 后原子发布。
 * @updated 2026-11-22T22:30:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import type { ToolCall } from '../shared/types.js';

export const MAX_BASH_LOG_BYTES = 8 * 1024 * 1024;
type BashLog = NonNullable<ToolCall['bashLog']>;
type Snapshot = { bytes: Buffer; sourceBytes: number };
type Directory = { handle: FileHandle; info: BigIntStats; parent?: FileHandle; name: string };

// Linux O_PATH pins an inode without opening a device or blocking on a FIFO.
// Other platforms fail closed until they have an equivalent descriptor walk.
const O_PATH = 0x200000;
const descriptorPath = (handle: FileHandle, name?: string) =>
  `/proc/self/fd/${handle.fd}${name === undefined ? '' : `/${name}`}`;
const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const uid = () => {
  if (process.platform !== 'linux' || !process.geteuid)
    throw new Error('Unsupported safe file access');
  return BigInt(process.geteuid());
};

async function withDirectory<T>(
  root: string,
  children: string[],
  createLast: boolean,
  signal: AbortSignal | undefined,
  work: (directory: FileHandle, verify: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const owner = uid();
  if (!isAbsolute(root) || root === '/' || normalize(root) !== root || root.includes('\0'))
    throw new Error('Invalid trusted root');
  const rootParts = root.slice(1).split('/');
  if (
    [...rootParts, ...children].some(
      (part) => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\0'),
    )
  )
    throw new Error('Invalid path component');
  const chain: Directory[] = [];
  let rootDevice: bigint | undefined;
  const check = (info: BigIntStats, index: number) => {
    const withinRoot = index >= rootParts.length;
    if (
      !info.isDirectory() ||
      (withinRoot ? info.uid !== owner : info.uid !== owner && info.uid !== 0n)
    )
      throw new Error('Directory ownership changed');
    // A sticky system temporary directory is a permitted ancestor, never a config/data directory.
    if ((info.mode & 0o022n) !== 0n && (withinRoot || (info.mode & 0o1000n) === 0n))
      throw new Error('Writable directory');
    if (index === rootParts.length) rootDevice ??= info.dev;
    if (withinRoot && info.dev !== rootDevice) throw new Error('Directory device changed');
  };
  try {
    const parts = ['/', ...rootParts, ...children];
    for (const [index, name] of parts.entries()) {
      signal?.throwIfAborted();
      const parent = chain.at(-1)?.handle;
      const path = parent ? descriptorPath(parent, name) : name;
      if (createLast && index === parts.length - 1)
        await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        });
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const entry: Directory = { handle, info: await handle.stat({ bigint: true }), parent, name };
      chain.push(entry);
      check(entry.info, index);
    }
    const verify = async () => {
      signal?.throwIfAborted();
      for (const [index, entry] of chain.entries()) {
        const current = await entry.handle.stat({ bigint: true });
        const named = await lstat(entry.parent ? descriptorPath(entry.parent, entry.name) : '/', {
          bigint: true,
        });
        check(current, index);
        if (
          !sameInode(current, entry.info) ||
          !sameInode(named, entry.info) ||
          !named.isDirectory()
        )
          throw new Error('Directory replaced');
      }
    };
    const directory = chain.at(-1);
    if (!directory) throw new Error('Missing directory');
    await verify();
    return await work(directory.handle, verify);
  } finally {
    for (const entry of chain.reverse()) await entry.handle.close();
  }
}

function regular(info: BigIntStats, device: bigint): void {
  if (
    !info.isFile() ||
    info.nlink !== 1n ||
    info.uid !== uid() ||
    info.dev !== device ||
    (info.mode & 0o022n) !== 0n ||
    info.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error('Log is not an owned, unlinked regular file');
}
function unchanged(before: BigIntStats, after: BigIntStats): void {
  if (
    !sameInode(before, after) ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.mode !== after.mode ||
    before.uid !== after.uid ||
    after.nlink !== 1n
  )
    throw new Error('Log changed during capture');
}

async function readSnapshot(
  root: string,
  parts: string[],
  signal?: AbortSignal,
): Promise<Snapshot> {
  const name = parts.at(-1);
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
    throw new Error('Invalid log name');
  return withDirectory(root, parts.slice(0, -1), false, signal, async (directory, verify) => {
    const path = descriptorPath(directory, name);
    const pin = await open(path, O_PATH | constants.O_NOFOLLOW);
    let input: FileHandle | undefined;
    try {
      const before = await pin.stat({ bigint: true });
      regular(before, (await directory.stat({ bigint: true })).dev);
      input = await open(descriptorPath(pin), constants.O_RDONLY | constants.O_NONBLOCK);
      unchanged(before, await input.stat({ bigint: true }));
      const sourceBytes = Number(before.size);
      const wanted = Math.min(sourceBytes, MAX_BASH_LOG_BYTES + 1);
      const buffer = Buffer.alloc(wanted);
      let read = 0;
      while (read < wanted) {
        signal?.throwIfAborted();
        const { bytesRead } = await input.read(buffer, read, wanted - read, read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      if (read !== wanted) throw new Error('Incomplete log read');
      unchanged(before, await input.stat({ bigint: true }));
      unchanged(before, await pin.stat({ bigint: true }));
      unchanged(before, await lstat(path, { bigint: true }));
      await verify();
      // A streaming decoder drops only an unfinished final UTF-8 sequence at the cap.
      // ignoreBOM preserves the BOM bytes in the retained log and byte accounting.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, MAX_BASH_LOG_BYTES),
        { stream: sourceBytes > MAX_BASH_LOG_BYTES },
      );
      if (text.includes('\0')) throw new Error('Binary log');
      return { bytes: Buffer.from(text, 'utf8'), sourceBytes };
    } finally {
      await input?.close();
      await pin.close();
    }
  });
}

// Matches tH/IQ in the locked 2.1.326 CLI; project names over 200 characters
// include the absolute path's signed 32-bit hash, expressed as positive base36.
function projectKey(path: string): string {
  const key = path.replace(/[^a-zA-Z0-9]/g, '-');
  if (key.length <= 200) return key;
  let hash = 0;
  for (let index = 0; index < path.length; index++)
    hash = ((hash << 5) - hash + path.charCodeAt(index)) | 0;
  return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

const sourceSchema = z.object({
  persistedOutputPath: z.string(),
  persistedOutputSize: z.number().int().nonnegative().safe(),
  isImage: z.boolean().optional(),
});

export async function captureSdkBashLog(
  sdkRoot: string,
  projectPath: string,
  sdkSessionId: string,
  response: unknown,
  signal?: AbortSignal,
): Promise<Snapshot | undefined> {
  signal?.throwIfAborted();
  if (
    typeof response !== 'object' ||
    response === null ||
    !('persistedOutputPath' in response) ||
    response.persistedOutputPath === undefined
  )
    return undefined;
  const source = sourceSchema.parse(response);
  if (
    source.isImage ||
    !/^[a-zA-Z0-9_-]{1,200}$/.test(sdkSessionId) ||
    !isAbsolute(projectPath) ||
    normalize(projectPath) !== projectPath ||
    projectPath.includes('\0')
  )
    throw new Error('Invalid SDK log identity');
  const directories = ['projects', projectKey(projectPath), sdkSessionId, 'tool-results'];
  const name = basename(source.persistedOutputPath);
  if (
    !/^[a-zA-Z0-9_-]{1,200}\.txt$/.test(name) ||
    dirname(source.persistedOutputPath) !== join(sdkRoot, ...directories) ||
    source.persistedOutputPath !== join(sdkRoot, ...directories, name)
  )
    throw new Error('SDK log outside the expected project/session');
  const snapshot = await readSnapshot(sdkRoot, [...directories, name], signal);
  if (snapshot.sourceBytes !== source.persistedOutputSize)
    throw new Error('SDK log size disagrees with receipt');
  return snapshot;
}

export async function publishBashLog(
  dataRoot: string,
  key: string,
  snapshot: Snapshot,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<BashLog> {
  return withDirectory(dataRoot, ['tool-output'], true, signal, async (directory, verify) => {
    const temporary = `${key}.${randomUUID()}.tmp`;
    const target = `${key}.log`;
    const output = await open(
      descriptorPath(directory, temporary),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let published = false;
    const identity = await output.stat({ bigint: true });
    try {
      await output.writeFile(snapshot.bytes, signal ? { signal } : undefined);
      await output.sync();
      await verify();
      unchanged(
        await output.stat({ bigint: true }),
        await lstat(descriptorPath(directory, temporary), { bigint: true }),
      );
      assertCurrent();
      signal?.throwIfAborted();
      await rename(descriptorPath(directory, temporary), descriptorPath(directory, target));
      published = true;
      await verify();
      assertCurrent();
      return {
        status: snapshot.bytes.length === snapshot.sourceBytes ? 'complete' : 'partial',
        bytes: snapshot.bytes.length,
        sourceBytes: snapshot.sourceBytes,
      };
    } catch (error) {
      if (published) {
        const path = descriptorPath(directory, target);
        const current = await lstat(path, { bigint: true }).catch(() => undefined);
        if (current && sameInode(identity, current)) await unlink(path);
      }
      throw error;
    } finally {
      await output.close();
      await unlink(descriptorPath(directory, temporary)).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      });
    }
  });
}

// After migration an app-owned sidecar can be read on a platform without Linux procfs.
// The filename is derived from the database ID and the file must stay under the data library.
async function retainedPath(dataRoot: string, key: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid retained log ID');
  const parent = join(await realpath(dataRoot), 'tool-output');
  if ((await realpath(parent)) !== parent) throw new Error('Invalid retained log directory');
  return join(parent, `${key}.log`);
}

export async function readCapturedBashLog(
  dataRoot: string,
  key: string,
  log: BashLog,
): Promise<string> {
  if (
    (log.status !== 'complete' && log.status !== 'partial') ||
    log.bytes === undefined ||
    !Number.isSafeInteger(log.bytes) ||
    log.bytes < 0 ||
    log.bytes > MAX_BASH_LOG_BYTES ||
    (log.sourceBytes !== undefined &&
      (!Number.isSafeInteger(log.sourceBytes) ||
        log.sourceBytes < log.bytes ||
        (log.status === 'complete' && log.sourceBytes !== log.bytes)))
  )
    throw new Error('Invalid retained log metadata');
  if (process.platform !== 'linux') {
    const file = await retainedPath(dataRoot, key);
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(log.bytes))
      throw new Error('Invalid retained log file');
    const input = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      unchanged(before, await input.stat({ bigint: true }));
      const bytes = Buffer.alloc(log.bytes);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await input.read(bytes, count, bytes.length - count, count);
        if (!bytesRead) throw new Error('Incomplete retained log');
        count += bytesRead;
      }
      unchanged(before, await input.stat({ bigint: true }));
      unchanged(before, await lstat(await retainedPath(dataRoot, key), { bigint: true }));
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } finally {
      await input.close();
    }
  }
  const result = await readSnapshot(dataRoot, ['tool-output', `${key}.log`]);
  if (result.sourceBytes !== log.bytes || result.bytes.length !== log.bytes)
    throw new Error('Retained log size mismatch');
  return result.bytes.toString('utf8');
}

export async function discardCapturedBashLog(dataRoot: string, key: string): Promise<void> {
  try {
    if (process.platform !== 'linux') {
      await unlink(await retainedPath(dataRoot, key));
      return;
    }
    await withDirectory(dataRoot, ['tool-output'], false, undefined, async (directory, verify) => {
      await verify();
      await unlink(descriptorPath(directory, `${key}.log`));
    });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

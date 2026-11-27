/**
 * @file 收口 Git 多提交与工作树共用的安全文件读取和目录校验原语。
 * @implementation 使用 O_NOFOLLOW 避免符号链接跟随，核对硬链接计数与前后 stat/lstat inode、时间戳及长度防 TOCTOU，并校验检出目录身份与 HEAD 引用目标。
 * @updated 2026-11-27T21:40:00+08:00
 */
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { fileIdentity, LocalGit } from './git-cli.js';

export const OPEN_REGULAR_READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const OPEN_DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export const errnoIs = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code;

export const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;

export const statIdentity = (info: BigIntStats) => `${info.dev}:${info.ino}`;

export type SafeRegularReadResult =
  | { status: 'ok'; bytes: Buffer; stat: BigIntStats }
  | { status: 'missing' }
  | { status: 'unsafe'; reason: 'open' | 'stat' | 'size' | 'replaced'; cause?: unknown }
  | { status: 'changed' };

export async function readRegularFileSafely(
  path: string,
  options: {
    maxBytes: number;
    requireSingleLink?: boolean;
    verifyPathInode?: boolean;
    preStat?: boolean;
    validateStat?: (info: BigIntStats) => void;
    signal?: AbortSignal;
  },
): Promise<SafeRegularReadResult> {
  const {
    maxBytes,
    requireSingleLink = true,
    verifyPathInode = true,
    preStat = false,
    validateStat,
    signal,
  } = options;
  let namedPre: BigIntStats | undefined;
  if (preStat) {
    try {
      namedPre = await lstat(path, { bigint: true });
    } catch (error) {
      if (errnoIs(error, 'ENOENT')) return { status: 'missing' };
      throw error;
    }
    validateStat?.(namedPre);
  }
  let handle: FileHandle;
  try {
    handle = await open(path, OPEN_REGULAR_READ_FLAGS);
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return { status: 'missing' };
    return { status: 'unsafe', reason: 'open', cause: error };
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || (requireSingleLink && before.nlink !== 1n)) {
      return { status: 'unsafe', reason: 'stat' };
    }
    validateStat?.(before);
    if (namedPre && !sameInode(namedPre, before)) {
      return { status: 'unsafe', reason: 'stat' };
    }
    if (before.size > BigInt(maxBytes)) {
      return { status: 'unsafe', reason: 'size' };
    }
    // Allocate +1 byte to detect writers extending the file past before.size during reading.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    validateStat?.(after);
    if (
      BigInt(offset) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      !sameInode(before, after)
    ) {
      return { status: 'changed' };
    }
    if (verifyPathInode) {
      const current = await lstat(path, { bigint: true });
      validateStat?.(current);
      if (!sameInode(after, current)) {
        return { status: 'unsafe', reason: 'replaced' };
      }
    }
    return { status: 'ok', bytes: buffer.subarray(0, offset), stat: after };
  } finally {
    await handle.close();
  }
}

export async function readHeadTarget(
  git: LocalGit,
  signal?: AbortSignal,
): Promise<{ ref: string; head: string | null }> {
  const [reference, head] = await Promise.all([
    git.text(['symbolic-ref', '--quiet', 'HEAD'], { allowExit: [1], signal }),
    git.oid('HEAD', signal),
  ]);
  return { ref: reference.trim() || 'HEAD', head: head ?? null };
}

export async function verifyCheckoutDirectories(
  git: LocalGit,
  expected: {
    repositoryId: string;
    rootIdentity: string;
    adminIdentity: string;
    adminInfo: BigIntStats;
    expectedCommon?: string;
  },
  signal?: AbortSignal,
): Promise<LocalGit | null> {
  const checkout = await LocalGit.open(git.root, signal);
  const [rootIdentity, adminIdentity, currentAdminInfo] = await Promise.all([
    fileIdentity(git.root),
    fileIdentity(git.admin),
    lstat(git.admin, { bigint: true }),
  ]);
  if (
    checkout.repositoryId !== expected.repositoryId ||
    checkout.admin !== git.admin ||
    (expected.expectedCommon !== undefined && checkout.common !== expected.expectedCommon) ||
    !sameInode(expected.adminInfo, currentAdminInfo) ||
    adminIdentity !== expected.adminIdentity ||
    rootIdentity !== expected.rootIdentity
  ) {
    return null;
  }
  return checkout;
}

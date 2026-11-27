/**
 * @file 保存多提交操作的恢复证据与版本化状态。
 * @implementation 原子发布私有日志及独立索引备份，保存锁设备与 inode 身份，仅对账执行器提供的 Git 状态，绝不修改引用或索引。
 * @updated 2026-11-27T12:18:00-06:00
 */
import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import {
  errnoIs as errorIs,
  OPEN_DIRECTORY_FLAGS,
  readRegularFileSafely,
  sameInode,
} from './git-safe-io.js';
import {
  CommitJournalError,
  MAX_COMMIT_JOURNAL_INDEX_BYTES,
  backupPath,
  digest,
  encode,
  failure,
  hashCommitJournalIndex,
  hashCommitJournalRequest,
  id,
  isLegalJournalAdvance,
  maxRecordBytes,
  observationSchema,
  parse,
  prepareSchema,
  recordSchema,
  requestKey,
  transitionSchema,
  validTransition,
  type CommitJournalErrorCode,
  type CommitJournalObservation,
  type CommitJournalPrepare,
  type CommitJournalReconciliation,
  type CommitJournalRecord,
  type CommitJournalState,
  type CommitJournalTransition,
} from './commit-journal-model.js';

export {
  CommitJournalError,
  MAX_COMMIT_JOURNAL_INDEX_BYTES,
  hashCommitJournalIndex,
  hashCommitJournalRequest,
  isLegalJournalAdvance,
  type CommitJournalErrorCode,
  type CommitJournalObservation,
  type CommitJournalPrepare,
  type CommitJournalReconciliation,
  type CommitJournalRecord,
  type CommitJournalState,
  type CommitJournalTransition,
};

const descriptorPath = (handle: FileHandle, name: string) => `/proc/self/fd/${handle.fd}/${name}`;
const directoryFlags = OPEN_DIRECTORY_FLAGS;
function owned(info: BigIntStats, directory: boolean): void {
  if (
    !process.geteuid ||
    info.uid !== BigInt(process.geteuid()) ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n) ||
    (info.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
  )
    failure('UNSAFE_PATH', 'Journal storage must be private, owned and free of links.');
}

/**
 * Linux descriptor-relative storage. dataRoot must already exist, be canonical and owned mode 0700.
 * Immutable <operationId>.<revision>/entry.json directories are published with rename; a competing
 * nonempty revision cannot be replaced. Interrupted .pending-* directories are retained as evidence.
 * The first revision owns separate, fsynced original.index and target.index files. Record file paths
 * are relative to dataRoot and remain stable; an absent index has a zero-byte evidence file while
 * its hash/bytes stay null. Every read verifies these files against the embedded index images.
 * indexLockIdentity must come from the executor's owned index.lock stat before preparing.
 * Optional owner metadata freezes project/request attribution for coordinator-led orphan recovery;
 * production coordinators must supply it. This journal never recreates SQLite claims on its own.
 * Abandonment persists aborting before executor-owned lock cleanup, then aborted after cleanup;
 * aborting stays pending and aborted never reports successful commits. This class never removes locks.
 * Journal CAS protects its records only: the executor must hold its Git/worktree lease separately.
 */
export class CommitJournal {
  constructor(private readonly dataRoot: string) {
    if (process.platform !== 'linux')
      failure('UNSUPPORTED_PLATFORM', 'Safe journal storage requires Linux.');
    if (
      typeof dataRoot !== 'string' ||
      !isAbsolute(dataRoot) ||
      dataRoot === '/' ||
      normalize(dataRoot) !== dataRoot ||
      dataRoot.endsWith('/') ||
      dataRoot.includes('\0')
    )
      failure('INVALID_INPUT', 'Expected a canonical absolute private data root.');
  }

  private async directory<T>(
    create: boolean,
    work: (directory: FileHandle, verify: () => Promise<void>) => Promise<T>,
  ): Promise<T | undefined> {
    const chain: { handle: FileHandle; info: BigIntStats; path: string }[] = [];
    const parts = ['/', ...this.dataRoot.slice(1).split('/'), 'commit-journal'];
    const rootIndex = parts.length - 2;
    try {
      for (const [index, part] of parts.entries()) {
        const parent = chain.at(-1)?.handle;
        const path = parent ? descriptorPath(parent, part) : part;
        if (create && index === parts.length - 1) {
          try {
            await mkdir(path, { mode: 0o700 });
          } catch (error) {
            if (!errorIs(error, 'EEXIST')) throw error;
          }
          await parent?.sync();
        }
        let handle: FileHandle;
        try {
          handle = await open(path, directoryFlags);
        } catch (error) {
          if (!create && index === parts.length - 1 && errorIs(error, 'ENOENT')) return undefined;
          throw error;
        }
        // Add before inspecting so every opened descriptor is closed on validation failure.
        const info = await handle.stat({ bigint: true }).catch(async (error: unknown) => {
          await handle.close();
          throw error;
        });
        chain.push({ handle, info, path });
        if (index >= rootIndex) owned(info, true);
        else if (
          !info.isDirectory() ||
          !process.geteuid ||
          (info.uid !== 0n && info.uid !== BigInt(process.geteuid())) ||
          ((info.mode & 0o022n) !== 0n && (info.mode & 0o1000n) === 0n)
        )
          failure('UNSAFE_PATH', 'Journal ancestor is not trusted.');
      }
      const verify = async () => {
        for (const [index, entry] of chain.entries()) {
          const current = await entry.handle.stat({ bigint: true });
          const named = await lstat(entry.path, { bigint: true });
          if (
            !sameInode(current, entry.info) ||
            !sameInode(named, entry.info) ||
            !named.isDirectory()
          )
            failure('UNSAFE_PATH', 'Journal directory was replaced.');
          if (index >= rootIndex) owned(current, true);
          else if (current.uid !== entry.info.uid || current.mode !== entry.info.mode)
            failure('UNSAFE_PATH', 'Journal ancestor permissions changed.');
        }
      };
      const directory = chain.at(-1)?.handle;
      if (!directory) return failure('UNSAFE_PATH', 'Missing journal directory.');
      await verify();
      return await work(directory, verify);
    } catch (error) {
      if (error instanceof CommitJournalError) throw error;
      if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOENT'].some((code) => errorIs(error, code)))
        return failure('UNSAFE_PATH', 'Journal path is unavailable or unsafe.');
      return failure(
        'IO_ERROR',
        'Commit journal I/O failed; retain evidence and reread before retrying.',
      );
    } finally {
      for (const entry of chain.reverse()) await entry.handle.close();
    }
  }

  private async entries(directory: FileHandle): Promise<Map<string, number[]>> {
    const entries = new Map<string, number[]>();
    for (const name of await readdir(descriptorPath(directory, '.'))) {
      if (/^\.pending-[a-f0-9-]{36}$/u.test(name)) continue;
      const match = /^([a-f0-9-]{36})\.([1-3])$/u.exec(name);
      const operationId = match?.[1];
      const revision = Number(match?.[2]);
      if (!operationId || !id.safeParse(operationId).success)
        return failure('CORRUPT', 'Unexpected entry in commit journal.');
      const revisions = entries.get(operationId) ?? [];
      revisions.push(revision);
      entries.set(operationId, revisions);
    }
    return entries;
  }

  private async readBytes(folder: FileHandle, name: string, limit: number): Promise<Buffer> {
    const result = await readRegularFileSafely(descriptorPath(folder, name), {
      maxBytes: limit,
      preStat: true,
      validateStat: (info) => owned(info, false),
    });
    if (result.status === 'ok') return result.bytes;
    if (result.status === 'missing') return failure('CORRUPT', 'Journal evidence file is missing.');
    if (result.status === 'changed')
      return failure('CORRUPT', 'Journal evidence changed during reading.');
    if (result.reason === 'replaced')
      return failure('UNSAFE_PATH', 'Journal evidence was replaced.');
    if (result.reason === 'open') throw result.cause;
    return failure('CORRUPT', 'Journal evidence is changed or oversized.');
  }

  private async load(
    directory: FileHandle,
    operationId: string,
  ): Promise<CommitJournalRecord | undefined> {
    const revisions = (await this.entries(directory)).get(operationId)?.sort() ?? [];
    let previous: CommitJournalRecord | undefined;
    for (const [index, revision] of revisions.entries()) {
      if (revision !== index + 1) return failure('CORRUPT', 'Journal revision history has a gap.');
      const path = descriptorPath(directory, operationId + '.' + revision);
      const folder = await open(path, directoryFlags);
      try {
        const folderInfo = await folder.stat({ bigint: true });
        owned(folderInfo, true);
        const bytes = await this.readBytes(folder, 'entry.json', maxRecordBytes);
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          return failure('CORRUPT', 'Journal record is not valid UTF-8 JSON.');
        }
        const value = parse(recordSchema, decoded, 'CORRUPT');
        if (revision === 1) {
          for (const kind of ['original', 'target'] as const) {
            const image = kind === 'original' ? value.originalIndex : value.targetIndex;
            const backup = await this.readBytes(
              folder,
              kind + '.index',
              MAX_COMMIT_JOURNAL_INDEX_BYTES,
            );
            if (!backup.equals(image.bytes ?? Buffer.alloc(0)))
              return failure('CORRUPT', 'Index backup file does not match journal evidence.');
          }
        }
        if (
          value.operationId !== operationId ||
          value.revision !== revision ||
          (!previous && value.state !== 'prepared') ||
          (previous &&
            (requestKey(previous) !== requestKey(value) ||
              previous.createdAt !== value.createdAt ||
              previous.updatedAt > value.updatedAt ||
              !validTransition(previous.state, value.state)))
        )
          return failure('CORRUPT', 'Journal history failed validation.');
        if (!sameInode(folderInfo, await lstat(path, { bigint: true })))
          return failure('UNSAFE_PATH', 'Journal revision was replaced.');
        previous = value;
      } finally {
        await folder.close();
      }
    }
    // A reader may observe a rename before its writer syncs the directory; sync before using it.
    await directory.sync();
    return previous;
  }

  private async publish(
    directory: FileHandle,
    verify: () => Promise<void>,
    record: CommitJournalRecord,
  ): Promise<void> {
    const temporary = '.pending-' + randomUUID();
    const path = descriptorPath(directory, temporary);
    await mkdir(path, { mode: 0o700 });
    const folder = await open(path, directoryFlags);
    const folderInfo = await folder.stat({ bigint: true });
    let published = false;
    try {
      owned(folderInfo, true);
      const payloads: [string, string | Buffer][] =
        record.revision === 1
          ? [
              ['original.index', record.originalIndex.bytes ?? Buffer.alloc(0)],
              ['target.index', record.targetIndex.bytes ?? Buffer.alloc(0)],
            ]
          : [];
      payloads.push(['entry.json', encode(record)]);
      for (const [name, bytes] of payloads) {
        const file = await open(
          descriptorPath(folder, name),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          owned(await file.stat({ bigint: true }), false);
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      await folder.sync();
      await verify();
      const destination = descriptorPath(directory, record.operationId + '.' + record.revision);
      try {
        await lstat(destination);
        return failure('VERSION_CONFLICT', 'Journal revision already exists.');
      } catch (error) {
        if (!errorIs(error, 'ENOENT')) throw error;
      }
      try {
        await rename(path, destination);
      } catch (error) {
        if (errorIs(error, 'EEXIST') || errorIs(error, 'ENOTEMPTY'))
          return failure('VERSION_CONFLICT', 'A concurrent writer published this revision.');
        throw error;
      }
      published = true;
      await directory.sync();
      await verify();
    } finally {
      await folder.close();
      if (!published) {
        const current = await lstat(path, { bigint: true }).catch(() => undefined);
        if (current && sameInode(current, folderInfo)) {
          for (const name of ['entry.json', 'original.index', 'target.index']) {
            await unlink(descriptorPath(directory, temporary + '/' + name)).catch(
              (error: unknown) => {
                if (!errorIs(error, 'ENOENT')) throw error;
              },
            );
          }
          await rmdir(path);
          await directory.sync();
        }
      }
    }
  }

  async prepare(input: unknown): Promise<CommitJournalRecord> {
    // Copy buffers before the first await so caller mutation cannot change persisted evidence.
    const parsed = parse(prepareSchema, input);
    const request: CommitJournalPrepare = {
      ...parsed,
      commits: [...parsed.commits],
      originalIndex: {
        hash: parsed.originalIndex.hash,
        bytes: parsed.originalIndex.bytes && Buffer.from(parsed.originalIndex.bytes),
      },
      targetIndex: {
        hash: parsed.targetIndex.hash,
        bytes: parsed.targetIndex.bytes && Buffer.from(parsed.targetIndex.bytes),
      },
    };
    const result = await this.directory(true, async (directory, verify) => {
      const existing = await this.load(directory, request.operationId);
      if (existing) {
        if (requestKey(existing) !== requestKey(request))
          return failure('REQUEST_CONFLICT', 'Operation ID belongs to another request.');
        await verify();
        return existing;
      }
      const timestamp = new Date().toISOString();
      const record: CommitJournalRecord = {
        ...request,
        originalIndex: {
          ...request.originalIndex,
          file: backupPath(request.operationId, 'original'),
        },
        targetIndex: { ...request.targetIndex, file: backupPath(request.operationId, 'target') },
        version: 1,
        revision: 1,
        state: 'prepared',
        recoveryReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        await this.publish(directory, verify, record);
        return record;
      } catch (error) {
        if (!(error instanceof CommitJournalError) || error.code !== 'VERSION_CONFLICT')
          throw error;
        const winner = await this.load(directory, request.operationId);
        await verify();
        if (winner && requestKey(winner) === requestKey(request)) return winner;
        return failure(
          'REQUEST_CONFLICT',
          'Operation ID was concurrently assigned to another request.',
        );
      }
    });
    if (!result) return failure('IO_ERROR', 'Journal was not created.');
    return result;
  }

  async read(operationId: unknown): Promise<CommitJournalRecord | undefined> {
    const key = parse(id, operationId);
    return this.directory(false, async (directory, verify) => {
      const result = await this.load(directory, key);
      await verify();
      return result;
    });
  }

  async pending(): Promise<CommitJournalRecord[]> {
    return (
      (await this.directory(false, async (directory, verify) => {
        const result: CommitJournalRecord[] = [];
        for (const key of [...(await this.entries(directory)).keys()].sort()) {
          const record = await this.load(directory, key);
          if (record && record.state !== 'completed' && record.state !== 'aborted')
            result.push(record);
        }
        await verify();
        return result;
      })) ?? []
    );
  }

  async transition(input: unknown): Promise<CommitJournalRecord> {
    const request = parse(transitionSchema, input);
    const result = await this.directory(false, async (directory, verify) => {
      const previous = await this.load(directory, request.operationId);
      if (!previous) return failure('NOT_FOUND', 'Commit operation does not exist.');
      if (previous.requestHash !== request.requestHash)
        return failure('REQUEST_CONFLICT', 'Operation ID belongs to another request.');
      const reason = request.recoveryReason ?? null;
      const isRetry = (record: CommitJournalRecord) =>
        record.revision === request.expectedRevision + 1 &&
        record.state === request.state &&
        record.recoveryReason === reason;
      if (isRetry(previous)) {
        await verify();
        return previous;
      }
      if (previous.revision !== request.expectedRevision)
        return failure('VERSION_CONFLICT', 'Journal revision changed; reread before proceeding.');
      if (!validTransition(previous.state, request.state))
        return failure('INVALID_TRANSITION', 'Commit journal state transition is not allowed.');
      const record: CommitJournalRecord = {
        ...previous,
        revision: previous.revision + 1,
        state: request.state,
        recoveryReason: reason,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(previous.updatedAt))).toISOString(),
      };
      try {
        await this.publish(directory, verify, record);
        return record;
      } catch (error) {
        if (!(error instanceof CommitJournalError) || error.code !== 'VERSION_CONFLICT')
          throw error;
        const winner = await this.load(directory, request.operationId);
        await verify();
        if (winner && isRetry(winner)) return winner;
        return failure(
          'VERSION_CONFLICT',
          'Another journal transition won; reread before proceeding.',
        );
      }
    });
    if (!result) return failure('NOT_FOUND', 'Commit operation does not exist.');
    return result;
  }

  /** Observations must be captured by the executor under its lease; recommendations confer no authority. */
  async reconcile(
    operationId: unknown,
    observation: unknown,
  ): Promise<CommitJournalReconciliation> {
    const observed = parse(observationSchema, observation);
    const operation = await this.read(operationId);
    if (!operation) return failure('NOT_FOUND', 'Commit operation does not exist.');
    const answer = (decision: CommitJournalReconciliation['decision'], reason: string) => ({
      operation,
      decision,
      reason,
    });
    if (operation.state === 'recovery_required')
      return answer('recovery_required', 'Recovery was explicitly blocked.');
    const scopeFields = ['repositoryId', 'worktreeIdentity', 'adminIdentity', 'ref'] as const;
    if (scopeFields.some((key) => operation[key] !== observed[key]))
      return answer('recovery_required', 'Repository, checkout or reference identity changed.');
    if (
      observed.indexLock.state === 'foreign' ||
      observed.indexLock.state === 'unknown' ||
      (observed.indexLock.state === 'owned' &&
        (observed.indexLock.operationId !== operation.operationId ||
          observed.indexLock.identity !== operation.indexLockIdentity))
    )
      return answer('recovery_required', 'Index lock ownership is not established.');
    if (operation.state === 'aborting' || operation.state === 'aborted') {
      if (
        observed.head !== operation.oldHead ||
        observed.indexHash !== operation.originalIndex.hash
      )
        return answer(
          'recovery_required',
          'Abandoned operation no longer matches its original HEAD and index.',
        );
      if (operation.state === 'aborting')
        return answer(
          'aborting',
          observed.indexLock.state === 'absent'
            ? 'Owned lock is absent; executor may durably finish the abandonment.'
            : 'Executor must safely remove its owned index lock before finishing abandonment.',
        );
      return observed.indexLock.state === 'absent'
        ? answer('aborted', 'Operation was abandoned with the original HEAD and index intact.')
        : answer('recovery_required', 'An aborted operation still has an index lock.');
    }
    if (observed.head === operation.newHead && observed.indexHash === operation.targetIndex.hash)
      return answer('completed', 'Expected HEAD and target index are already present.');
    if (operation.state === 'completed')
      return answer('recovery_required', 'Completed operation no longer matches observed state.');
    if (observed.indexLock.state !== 'owned')
      return answer('recovery_required', 'Executor must acquire and verify its index lock.');
    if (
      observed.head === operation.oldHead &&
      observed.indexHash === operation.originalIndex.hash &&
      operation.state === 'prepared'
    )
      return answer('ready', 'Original HEAD and index still match.');
    if (observed.head === operation.newHead && observed.indexHash === operation.originalIndex.hash)
      return answer(
        'publish_index',
        'Expected new HEAD is present and original index still matches.',
      );
    return answer(
      'recovery_required',
      'Observed HEAD or index contains an external or ambiguous change.',
    );
  }
}

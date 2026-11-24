/**
 * @file 将旧工作区迁入另一个本机数据目录。
 * @implementation 独占并备份来源，核对工作树和多提交操作及其恢复证据，阻止未完成或证据不一致的迁移，再验证并发布目标目录。
 * @updated 2026-11-24T16:13:10+08:00
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { acquireDataOwner } from './data-owner.js';
import { Store } from './store.js';
import { fingerprint } from './files.js';
import { AppError } from '../shared/types.js';
import { WorktreeSnapshots } from './modules/git/worktree-snapshots.js';
import { readCapturedBashLog } from './bash-log-capture.js';
import { CommitJournal, type CommitJournalRecord } from './modules/git/commit-journal.js';
import {
  hashCommitRepositoryIdentity,
  type CommitOperationPage,
  type CommitOperationRecord,
} from './modules/git/commit-operation-repository.js';

const databases = 'atelier.sqlite';
const fileLibraries = [
  'attachments',
  'artifacts',
  'sdk',
  'tool-output',
  'worktree-snapshots',
  'commit-journal',
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function copyPrivateFile(source: string, target: string): Promise<void> {
  const named = await lstat(source, { bigint: true });
  const input = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await input.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.dev !== named.dev ||
      before.ino !== named.ino
    )
      throw new Error('数据文件不是普通文件或在复制前已变化。');
    const output = await open(target, 'wx', 0o600);
    const hash = createHash('sha256');
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        hash.update(chunk);
        await output.writeFile(chunk);
      }
    } finally {
      await output.close();
    }
    const after = await input.stat({ bigint: true });
    const current = await lstat(source, { bigint: true });
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.nlink !== 1n ||
      after.nlink !== 1n ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      hash.digest('hex') !== (await hashFile(target))
    )
      throw new Error('文件在复制期间变化或校验失败，数据没有迁入。');
  } finally {
    await input.close();
  }
}

async function copyLibrary(source: string, target: string): Promise<number> {
  const info = await lstat(source);
  if (!info.isDirectory()) throw new Error('数据文件库必须是普通目录。');
  await mkdir(target, { mode: 0o700 });
  let copied = 0;
  for (const name of await readdir(source)) {
    const from = join(source, name);
    const to = join(target, name);
    const entry = await lstat(from);
    if (entry.isDirectory()) {
      copied += await copyLibrary(from, to);
    } else if (entry.isFile()) {
      if (entry.nlink !== 1) throw new Error('数据目录包含硬链接文件。');
      if (basename(source) === 'tool-output' && /^[a-f0-9]{64}\.log$/.test(name)) {
        const text = await readCapturedBashLog(dirname(source), name.slice(0, -4), {
          status: 'complete',
          bytes: entry.size,
        });
        await writeFile(to, text, { flag: 'wx', mode: 0o600 });
      } else await copyPrivateFile(from, to);
      await chmod(to, 0o600);
      if ((await hashFile(from)) !== (await hashFile(to)))
        throw new Error('文件校验失败，数据没有迁入。');
      copied++;
    } else {
      throw new Error('数据目录包含符号链接或其他特殊文件。');
    }
  }
  const current = await lstat(source);
  if (!current.isDirectory() || current.dev !== info.dev || current.ino !== info.ino)
    throw new Error('数据文件库在复制期间已变化。');
  return copied;
}

function integrity(db: {
  prepare(source: string): { get(): Record<string, unknown> | undefined };
}): void {
  if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
    throw new Error('SQLite 数据库完整性检查失败。');
}

async function verifyWorktreeMigration(source: string, databaseCopy: string) {
  const store = new Store(databaseCopy);
  try {
    const linked = store
      .list('projects')
      .flatMap(({ id }) => store.gitWorktrees.byProject(id))
      .filter(({ mode }) => mode === 'linked');
    const live = await Promise.all(linked.map(({ id }) => exists(join(source, 'worktrees', id))));
    if (
      store.gitWorktrees.pendingOperations().length ||
      live.some(Boolean) ||
      linked.some(({ retained }) => retained === 'relocated')
    )
      throw new AppError(
        'GIT_MIGRATION_LIVE',
        '请先在旧工作台完成工作树操作并回收独立检出，再迁入到新数据目录。',
        409,
      );
  } finally {
    store.close();
  }
}

function commitEvidenceAgrees(
  operation: CommitOperationRecord,
  evidence: CommitJournalRecord,
): boolean {
  // The execution request hash and SQLite's confirmed-preview digest are distinct.
  // New journals bind the latter through owner; older evidence has no such field.
  return (
    operation.operationId === evidence.operationId &&
    operation.repositoryId === hashCommitRepositoryIdentity(evidence.repositoryId) &&
    operation.worktreeIdentity === evidence.worktreeIdentity &&
    operation.adminIdentity === evidence.adminIdentity &&
    (!evidence.owner ||
      (operation.projectId === evidence.owner.projectId &&
        operation.requestHash === evidence.owner.requestDigest)) &&
    operation.state === evidence.state &&
    operation.revision === evidence.revision &&
    operation.ref === evidence.ref &&
    operation.oldHead === evidence.oldHead &&
    operation.newHead === evidence.newHead &&
    JSON.stringify(operation.commits) === JSON.stringify(evidence.commits) &&
    (operation.originalIndex?.hash ?? null) === evidence.originalIndex.hash &&
    (operation.originalIndex?.file ?? null) ===
      (evidence.originalIndex.hash === null ? null : evidence.originalIndex.file) &&
    operation.targetIndex.hash === evidence.targetIndex.hash &&
    operation.targetIndex.file === evidence.targetIndex.file
  );
}

async function verifyCommitMigration(path: string, store: Store): Promise<void> {
  const unfinished = () =>
    new AppError(
      'GIT_MIGRATION_COMMIT_PENDING',
      '旧工作台存在未完成的多提交操作或中断的恢复日志，请保留旧目录并先在旧工作台完成恢复，再迁入。',
      409,
    );
  const invalid = () =>
    new AppError(
      'GIT_MIGRATION_COMMIT_INVALID',
      '多提交恢复证据缺失、损坏或与数据库记录不一致，迁入已停止。请保留旧目录并先核对恢复证据。',
      409,
    );
  const terminal = (state: string) => state === 'completed' || state === 'aborted';
  try {
    const operations = new Map<string, CommitOperationRecord>();
    for (const project of store.list('projects')) {
      let after: CommitOperationPage['after'];
      for (;;) {
        const page = store.gitCommitOperations.listForProject(project.id, {
          limit: 200,
          ...(after ? { after } : {}),
        });
        for (const operation of page) {
          if (!terminal(operation.state)) throw unfinished();
          operations.set(operation.operationId, operation);
        }
        const last = page.at(-1);
        if (page.length < 200 || !last) break;
        after = { createdAt: last.createdAt, operationId: last.operationId };
      }
    }
    const directory = join(path, 'commit-journal');
    const operationIds = new Set<string>();
    if (await exists(directory)) {
      for (const name of await readdir(directory)) {
        // CommitJournal readers deliberately retain/ignore interrupted publication directories.
        // Migration cannot prove those writes harmless, so it leaves recovery at the old root.
        if (name.startsWith('.pending-')) throw unfinished();
        const match = /^([a-f0-9-]{36})\.([1-3])$/u.exec(name);
        const operationId = match?.[1];
        if (!operationId) throw invalid();
        const expected =
          match?.[2] === '1' ? ['entry.json', 'original.index', 'target.index'] : ['entry.json'];
        const files = (await readdir(join(directory, name))).sort();
        if (JSON.stringify(files) !== JSON.stringify(expected)) throw invalid();
        operationIds.add(operationId);
      }
    }
    const journal = operationIds.size ? new CommitJournal(path) : undefined;
    for (const operationId of operationIds) {
      // Reading the latest record validates every revision and both independent index files,
      // including the zero-byte evidence file for a previously absent index.
      const evidence = await journal?.read(operationId);
      if (!evidence) throw invalid();
      if (!terminal(evidence.state)) throw unfinished();
      const operation = operations.get(operationId);
      if (operation && !commitEvidenceAgrees(operation, evidence)) throw invalid();
      operations.delete(operationId);
      // Completed/aborted evidence may outlive a deleted project's receipt; keep it intact.
    }
    if (operations.size) throw invalid();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  }
}

async function validateStaged(path: string) {
  const store = new Store(path);
  try {
    integrity(store.db);
    try {
      store.assertForeignKeyIntegrity();
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'DATABASE_FOREIGN_KEY_VIOLATION'
      )
        throw new AppError(
          'DATABASE_FOREIGN_KEY_VIOLATION',
          '旧数据库存在不完整的外键引用，迁入已停止。请保留旧目录并先核对数据。',
          409,
        );
      throw error;
    }
    await verifyCommitMigration(path, store);
    const projects = store.list('projects');
    const sessions = store.list('sessions');
    const snapshots = new WorktreeSnapshots(path);
    for (const { id } of projects)
      for (const row of store.gitWorktrees.byProject(id))
        if (row.snapshotId && row.snapshotDigest)
          await snapshots.manifest(row.snapshotId, row.snapshotDigest);
    const runs = store.list('runs');
    const artifacts = store.list('artifacts');
    const attachments = store.list('attachments');
    const projectIds = new Set(projects.map(({ id }) => id));
    const sessionIds = new Set(sessions.map(({ id }) => id));
    const runIds = new Set(runs.map(({ id }) => id));
    if (
      sessions.some(({ projectId }) => !projectIds.has(projectId)) ||
      runs.some(
        ({ projectId, sessionId }) => !projectIds.has(projectId) || !sessionIds.has(sessionId),
      )
    )
      throw new Error('旧版项目、会话或运行的引用不完整。');
    const checkFile = async (
      library: 'attachments' | 'artifacts',
      id: string,
      size: number,
      hash?: string,
    ) => {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('文件记录编号无效。');
      const file = join(path, library, id);
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.size !== size ||
        (hash !== undefined && (await hashFile(file)) !== hash)
      )
        throw new Error('附件或成果文件校验失败。');
    };
    for (const item of artifacts) {
      if (
        !sessionIds.has(item.sessionId) ||
        !projectIds.has(item.projectId) ||
        !runIds.has(item.runId)
      )
        throw new Error('成果引用的会话或运行不存在。');
      if (item.availability === 'available')
        await checkFile('artifacts', item.id, item.size, item.fingerprint);
    }
    for (const item of attachments) {
      if (!sessionIds.has(item.sessionId)) throw new Error('附件引用的会话不存在。');
      if (!item.removed || item.status === 'used')
        await checkFile('attachments', item.id, item.size);
    }
    for (const tool of store.list('tools')) {
      if (tool.outputTruncated)
        await access(join(path, 'tool-output', fingerprint(tool.id)), constants.R_OK);
      if (tool.bashLog && ['complete', 'partial'].includes(tool.bashLog.status)) {
        if (
          tool.name !== 'Bash' ||
          !sessionIds.has(tool.sessionId) ||
          !runIds.has(tool.runId) ||
          runs.find((run) => run.id === tool.runId)?.sessionId !== tool.sessionId
        )
          throw new Error('命令日志引用的会话或运行不匹配。');
        try {
          await readCapturedBashLog(path, fingerprint(tool.id), tool.bashLog);
        } catch {
          throw new Error('命令日志文件校验失败。');
        }
      }
    }
    return {
      projects: projects.length,
      sessions: sessions.length,
      artifacts: artifacts.length,
      attachments: attachments.length,
    };
  } finally {
    store.close();
  }
}

export async function migrateWorkspace(oldPath: string, newPath: string) {
  if (!isAbsolute(oldPath) || !isAbsolute(newPath)) throw new Error('迁入目录必须使用绝对路径。');
  const source = await realpath(oldPath);
  const parent = await realpath(dirname(newPath));
  const target = join(parent, basename(newPath));
  if (contains(source, target) || contains(target, source) || (await exists(target)))
    throw new Error('新工作台目录必须尚未创建，且与旧工作台目录分开。');
  const sourceFile = join(source, databases);
  if (!(await lstat(sourceFile)).isFile()) throw new Error('所选目录没有有效的旧版工作台数据库。');
  const release = acquireDataOwner(source);
  let backupPath: string | undefined;
  let stage: string | undefined;
  let published = false;
  try {
    backupPath = await mkdtemp(join(parent, `${basename(target)}.backup-`));
    const db = new DatabaseSync(sourceFile, { readOnly: true });
    let version = 0;
    try {
      integrity(db);
      version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version < 1 || version > 10) throw new Error('旧版工作台数据库版本不支持。');
      const copy = join(backupPath, databases);
      await backup(db, copy);
      await chmod(copy, 0o600);
    } finally {
      db.close();
    }
    let files = 0;
    for (const library of fileLibraries) {
      const from = join(source, library);
      if (await exists(from)) files += await copyLibrary(from, join(backupPath, library));
    }
    stage = await mkdtemp(join(parent, '.atelier-migration-'));
    await cp(backupPath, stage, { recursive: true });
    // Store initialization can upgrade old schemas. Only the staged database may be upgraded;
    // the rollback copy must retain the source schema and records.
    if (version >= 8) await verifyWorktreeMigration(source, stage);
    const report = await validateStaged(stage);
    if (await exists(target)) throw new Error('目标在迁入过程中已创建，请选择其他位置。');
    await rename(stage, target);
    published = true;
    return { ...report, files, target, backupPath };
  } finally {
    release();
    if (stage && !published) await rm(stage, { recursive: true, force: true });
    if (backupPath && !published) await rm(backupPath, { recursive: true, force: true });
  }
}

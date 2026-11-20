/**
 * @file 将旧版工作区数据迁入独立的本机数据目录。
 * @implementation 独占来源，生成 SQLite 快照并复制文件库，校验后发布新目录和回退副本。
 * @updated 2026-11-20T02:00+08:00
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { acquireDataOwner } from './data-owner.js';
import { Store } from './store.js';
import { fingerprint } from './files.js';

const databases = 'atelier.sqlite';
const fileLibraries = ['attachments', 'artifacts', 'sdk', 'tool-output'] as const;

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
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, 0o600);
      if ((await hashFile(from)) !== (await hashFile(to)))
        throw new Error('文件校验失败，数据没有迁入。');
      copied++;
    } else {
      throw new Error('数据目录包含符号链接或其他特殊文件。');
    }
  }
  return copied;
}

function integrity(db: DatabaseSync): void {
  if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
    throw new Error('SQLite 数据库完整性检查失败。');
}

async function validateStaged(path: string) {
  const store = new Store(path);
  try {
    integrity(store.db);
    const projects = store.list('projects');
    const sessions = store.list('sessions');
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
    try {
      integrity(db);
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version < 1 || version > 4) throw new Error('旧版工作台数据库版本不支持。');
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

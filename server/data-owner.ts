/**
 * @file 限制一个数据目录只有一个运行时写入。
 * @implementation 以独立 SQLite 写事务持有跨进程租约，兼容已有 PID 占用记录。
 * @updated 2026-11-20T02:00+08:00
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class DataOwnerError extends Error {
  constructor(
    readonly code: 'DATA_LOCKED' | 'DATA_PATH',
    message: string,
  ) {
    super(message);
  }
}

export function acquireDataOwner(data: string): () => void {
  const legacy = join(data, 'server.lock');
  const lease = join(data, '.atelier-owner.sqlite');
  const uid = process.getuid?.();
  const safeFile = (path: string) => {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || (uid !== undefined && info.uid !== uid))
        throw new DataOwnerError('DATA_PATH', '工作台锁文件必须是当前用户所有的普通文件。');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    }
  };
  let db: DatabaseSync | undefined;
  try {
    if (!isAbsolute(data)) throw new DataOwnerError('DATA_PATH', '工作台数据必须使用绝对路径。');
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const info = lstatSync(data);
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid))
      throw new DataOwnerError('DATA_PATH', '工作台数据目录必须由当前用户所有。');
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) chmodSync(data, 0o700);
    safeFile(lease);
    const owner = new DatabaseSync(lease);
    db = owner;
    try {
      owner.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === 5)
        throw new DataOwnerError('DATA_LOCKED', '此工作台数据正由另一个运行时使用。');
      throw error;
    }
    if (safeFile(legacy)) {
      const text = readFileSync(legacy, 'utf8');
      const pid = Number(text);
      if (!/^[1-9]\d{0,9}$/.test(text) || pid > 0x7fffffff)
        throw new DataOwnerError('DATA_PATH', '旧版工作台锁文件格式无效。');
      try {
        process.kill(pid, 0);
        throw new DataOwnerError('DATA_LOCKED', '此工作台数据正由另一个运行时使用。');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      unlinkSync(legacy);
    }
    try {
      writeFileSync(legacy, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new DataOwnerError('DATA_LOCKED', '此工作台数据正由另一个运行时使用。');
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(legacy);
      } finally {
        owner.close();
      }
    };
  } catch (error) {
    db?.close();
    if (error instanceof DataOwnerError) throw error;
    throw new DataOwnerError('DATA_PATH', '无法打开工作台数据目录或锁文件。');
  }
}

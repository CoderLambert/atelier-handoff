/**
 * @file 管理授权项目内的文件访问、检索与文本修改。
 * @implementation 限制路径及敏感文件访问，检查文件类型、大小和编码，提供目录浏览、搜索、文本差异与安全写入能力。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { constants } from 'node:fs';
import {
  lstat,
  realpath,
  readFile,
  readdir,
  mkdir,
  open,
  rename,
  unlink,
  link,
} from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, sep, dirname, basename, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { AppError } from '../shared/errors.js';

export const fingerprint = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
export const MAX_TEXT = 256 * 1024;
export const credentialNames = new Set([
  '.git',
  '.claude',
  '.codex',
  '.ssh',
  '.aws',
  '.config',
  '.data',
  '.local',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.gemini',
]);
export const blockedNames = new Set([...credentialNames, 'node_modules', 'dist', '.cache']);
export const isSensitiveCredentialName = (part: string) =>
  credentialNames.has(part) ||
  /^\.env(?:\.|$)/i.test(part) ||
  /^(id_rsa|id_ed25519)$|\.(pem|key|p12)$/i.test(part);
const sensitive = (part: string) => blockedNames.has(part) || isSensitiveCredentialName(part);
export const sensitiveProjectPath = (path: string) => path.split(/[\\/]/u).some(sensitive);
export function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}
export async function authorizeRoot(input: string): Promise<string> {
  if (!isAbsolute(input) || input.includes('\0'))
    throw new AppError('INVALID_INPUT', '请选择本机项目的绝对目录。');
  let root: string;
  try {
    root = await realpath(input);
    if (!(await lstat(root)).isDirectory()) throw new Error();
  } catch {
    throw new AppError('PROJECT_UNAVAILABLE', '目录不存在或无法访问。');
  }
  if (root === '/' || root === homedir())
    throw new AppError('INVALID_INPUT', '请选择具体项目目录，不要选择根目录或整个用户目录。');
  return root;
}
export async function resolveProjectPath(
  root: string,
  input: string,
  options: { directory?: boolean; create?: boolean } = {},
): Promise<string> {
  if (input.includes('\0') || input.startsWith('~') || input.split(/[\\/]/).includes('..'))
    throw new AppError('PATH_DENIED', '路径包含不允许的跳转。', 403);
  const target = resolve(root, input || '.');
  const part = relative(root, target);
  if (!inside(root, target) || (!part && !options.directory))
    throw new AppError('PATH_DENIED', '路径超出授权项目。', 403);
  const parts = part.split(sep).filter(Boolean);
  if (parts.some(sensitive))
    throw new AppError('PATH_DENIED', '凭据、内部数据或依赖目录不向 Agent 开放。', 403);
  try {
    if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory()) throw new Error();
  } catch {
    throw new AppError('PROJECT_UNAVAILABLE', '授权项目已移动或不可用。', 409);
  }
  let current = root;
  for (const [index, segment] of parts.entries()) {
    current = resolve(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (options.create && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new AppError('FILE_UNAVAILABLE', '文件不存在或不可访问。', 404);
    }
    if (stat.isSymbolicLink()) throw new AppError('PATH_DENIED', '首版不访问符号链接。', 403);
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new AppError('PATH_DENIED', '父路径不是目录。', 403);
    if (stat.isFile() && stat.nlink !== 1)
      throw new AppError('PATH_DENIED', '首版不访问多硬链接文件。', 403);
    if (!stat.isFile() && !stat.isDirectory())
      throw new AppError('PATH_DENIED', '不支持特殊文件。', 403);
    if (index === parts.length - 1 && (options.directory ? !stat.isDirectory() : !stat.isFile()))
      throw new AppError('INVALID_INPUT', options.directory ? '请选择目录。' : '请选择普通文件。');
  }
  return target;
}
export async function readProjectText(
  root: string,
  input: string,
  limit = MAX_TEXT,
): Promise<string> {
  const target = await resolveProjectPath(root, input);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.size > limit)
      throw new AppError(
        'FILE_TOO_LARGE',
        `文件大小为 ${stat.size} 字节，超过 ${Math.round(limit / 1024)} KiB 文本限制。`,
        413,
      );
    if (!stat.isFile() || stat.nlink !== 1)
      throw new AppError('PATH_DENIED', '文件状态已改变。', 409);
    const data = await handle.readFile();
    if (data.length > limit)
      throw new AppError(
        'FILE_TOO_LARGE',
        `文件大小为 ${data.length} 字节，超过 ${Math.round(limit / 1024)} KiB 文本限制。`,
        413,
      );
    if (data.includes(0))
      throw new AppError(
        'BINARY_FILE',
        `二进制文件，大小 ${data.length} 字节。当前工具仅处理 UTF-8 文本。`,
      );
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      throw new AppError(
        'UNSUPPORTED_ENCODING',
        `文件大小 ${data.length} 字节，编码并非有效 UTF-8。`,
      );
    }
  } finally {
    await handle.close();
  }
}
export async function listProjectFiles(root: string, input = '') {
  const target = await resolveProjectPath(root, input, { directory: true });
  const entries = await readdir(target, { withFileTypes: true });
  const items = [];
  for (const entry of entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  )) {
    if (
      sensitive(entry.name) ||
      entry.isSymbolicLink() ||
      (!entry.isDirectory() && !entry.isFile())
    )
      continue;
    const full = join(target, entry.name);
    let stat;
    try {
      stat = await lstat(full);
    } catch {
      continue;
    }
    if (stat.isFile() && stat.nlink !== 1) continue;
    items.push({
      name: entry.name,
      path: relative(root, full),
      isDirectory: entry.isDirectory(),
      size: stat.size,
    });
    if (items.length >= 500) break;
  }
  return { path: relative(root, target), items };
}
export async function findProjectFiles(root: string, query = '', limit = 50) {
  const toPosix = (p: string) => p.replace(/\\/g, '/');
  const rawQuery = query.trim().replace(/^[/\\]+/, '');
  const normalized = toPosix(rawQuery);

  const hasSlash = normalized.includes('/');
  let startDir = '';
  let filter = normalized.toLowerCase();

  if (hasSlash) {
    const lastSlash = normalized.lastIndexOf('/');
    const candidateDir = normalized.slice(0, lastSlash);
    const filterPart = normalized.slice(lastSlash + 1).toLowerCase();
    try {
      await resolveProjectPath(root, candidateDir, { directory: true });
      startDir = candidateDir;
      filter = filterPart;
    } catch {
      startDir = '';
      filter = normalized.toLowerCase();
    }
  }

  const directDirs: { name: string; path: string; isDirectory: boolean; size: number }[] = [];
  const directFiles: { name: string; path: string; isDirectory: boolean; size: number }[] = [];
  const nestedMatches: { name: string; path: string; isDirectory: boolean; size: number }[] = [];
  let examined = 0;

  let startEntries;
  try {
    const target = await resolveProjectPath(root, startDir, { directory: true });
    startEntries = await readdir(target, { withFileTypes: true });
  } catch {
    return { path: startDir, items: [] };
  }

  const sortedStart = [...startEntries].sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  );

  for (const entry of sortedStart) {
    if (
      sensitive(entry.name) ||
      entry.isSymbolicLink() ||
      (!entry.isDirectory() && !entry.isFile())
    )
      continue;

    examined++;
    const rel = startDir ? `${startDir}/${entry.name}` : entry.name;
    const lowerName = entry.name.toLowerCase();
    const isMatch = !filter || lowerName.includes(filter);

    if (entry.isDirectory()) {
      if (isMatch) {
        directDirs.push({
          name: entry.name,
          path: rel,
          isDirectory: true,
          size: 0,
        });
      }
    } else if (entry.isFile()) {
      if (isMatch) {
        let stat;
        try {
          stat = await lstat(join(root, rel));
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1) continue;
        directFiles.push({
          name: entry.name,
          path: rel,
          isDirectory: false,
          size: stat.size,
        });
      }
    }
  }

  const walk = async (dir: string, depth: number) => {
    if (
      depth > 8 ||
      examined >= 2000 ||
      directDirs.length + directFiles.length + nestedMatches.length >= limit
    )
      return;

    let entries;
    try {
      const target = await resolveProjectPath(root, dir, { directory: true });
      entries = await readdir(target, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        sensitive(entry.name) ||
        entry.isSymbolicLink() ||
        (!entry.isDirectory() && !entry.isFile())
      )
        continue;

      examined++;
      const rel = `${dir}/${entry.name}`;
      const lowerName = entry.name.toLowerCase();
      const lowerRel = rel.toLowerCase();
      const isMatch = !filter || lowerName.includes(filter) || lowerRel.includes(filter);

      if (entry.isDirectory()) {
        if (isMatch && filter) {
          nestedMatches.push({
            name: entry.name,
            path: rel,
            isDirectory: true,
            size: 0,
          });
        }
        await walk(rel, depth + 1);
        if (directDirs.length + directFiles.length + nestedMatches.length >= limit) return;
      } else if (entry.isFile()) {
        if (isMatch) {
          let stat;
          try {
            stat = await lstat(join(root, rel));
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.nlink !== 1) continue;
          nestedMatches.push({
            name: entry.name,
            path: rel,
            isDirectory: false,
            size: stat.size,
          });
          if (directDirs.length + directFiles.length + nestedMatches.length >= limit) return;
        }
      }
    }
  };

  for (const entry of sortedStart) {
    if (entry.isDirectory() && !sensitive(entry.name) && !entry.isSymbolicLink()) {
      const rel = startDir ? `${startDir}/${entry.name}` : entry.name;
      await walk(rel, 1);
      if (directDirs.length + directFiles.length + nestedMatches.length >= limit) break;
    }
  }

  let results: { name: string; path: string; isDirectory: boolean; size: number }[];
  if (filter) {
    const combined = [...directDirs, ...directFiles, ...nestedMatches];
    combined.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aExact = aName === filter;
      const bExact = bName === filter;
      if (aExact !== bExact) return aExact ? -1 : 1;
      const aStarts = aName.startsWith(filter);
      const bStarts = bName.startsWith(filter);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      const aContains = aName.includes(filter);
      const bContains = bName.includes(filter);
      if (aContains !== bContains) return aContains ? -1 : 1;
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    results = combined.slice(0, limit);
  } else {
    results = [...directDirs, ...directFiles, ...nestedMatches].slice(0, limit);
  }

  return { path: startDir, items: results };
}
export async function searchProject(root: string, query: string, signal: AbortSignal) {
  const matches: { path: string; line: number; text: string }[] = [];
  let examined = 0;
  let truncated = false;
  const walk = async (directory: string, depth: number) => {
    if (depth > 12 || examined >= 1500 || matches.length >= 100) {
      truncated = true;
      return;
    }
    signal.throwIfAborted();
    const { items } = await listProjectFiles(root, directory);
    for (const item of items) {
      signal.throwIfAborted();
      if (++examined > 1500 || matches.length >= 100) {
        truncated = true;
        break;
      }
      if (item.isDirectory) await walk(item.path, depth + 1);
      else if (item.size <= MAX_TEXT) {
        try {
          const text = await readProjectText(root, item.path);
          for (const [index, line] of text.split('\n').entries())
            if (line.toLowerCase().includes(query.toLowerCase())) {
              matches.push({ path: item.path, line: index + 1, text: line.slice(0, 300) });
              if (matches.length >= 100) break;
            }
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      }
    }
  };
  await walk('', 0);
  return { matches, truncated, examined };
}
export async function applyText(
  root: string,
  path: string,
  before: string | null,
  after: string | null,
  signal: AbortSignal,
  beforeApply?: () => void,
): Promise<string | null> {
  signal.throwIfAborted();
  const target = await resolveProjectPath(root, path, { create: before === null });
  let current: string | null;
  try {
    current = await readProjectText(root, path);
  } catch (error) {
    if (error instanceof AppError && error.code === 'FILE_UNAVAILABLE') current = null;
    else throw error;
  }
  if (current !== before)
    throw new AppError('OPERATION_CHANGED', '文件已在等待审批期间变化，请重新生成修改。', 409);
  signal.throwIfAborted();
  if (after === null) {
    beforeApply?.();
    await unlink(target);
    return null;
  }
  await mkdir(dirname(target), { recursive: true });
  await resolveProjectPath(root, path, { create: true });
  signal.throwIfAborted();
  const temporary = join(dirname(target), `.atelier-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    if (current !== null) await handle.chmod((await lstat(target)).mode & 0o777);
    await handle.writeFile(after, 'utf8');
    await handle.sync();
    await handle.close();
    const latest =
      current === null
        ? await lstat(target).then(
            () => 'exists',
            () => null,
          )
        : await readProjectText(root, path);
    if (latest !== before)
      throw new AppError('OPERATION_CHANGED', '文件基线已变化，没有应用修改。', 409);
    signal.throwIfAborted();
    beforeApply?.();
    if (before === null) {
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new AppError('OPERATION_CHANGED', '目标已存在，请重新审批。', 409);
        throw error;
      }
    } else await rename(temporary, target);
    return fingerprint(after);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
export function textDiff(path: string, before: string | null, after: string | null): string {
  const oldPath = before === null ? '/dev/null' : path;
  const newPath = after === null ? '/dev/null' : path;
  const patch = createTwoFilesPatch(
    oldPath,
    newPath,
    before ?? '',
    after ?? '',
    undefined,
    undefined,
    { context: 3, maxEditLength: 4000, timeout: 100 },
  );
  return (
    patch ??
    `--- ${oldPath}\n+++ ${newPath}\n差异规模超过预览限制。原文件 ${Buffer.byteLength(before ?? '')} 字节，操作后 ${Buffer.byteLength(after ?? '')} 字节。`
  );
}
export const textExtensions = new Set([
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.css',
  '.html',
  '.yaml',
  '.yml',
  '.log',
  '.py',
]);
export function safeName(name: string): string {
  return (
    basename(name.replaceAll('\\', '/'))
      .replace(/[\x00-\x1f]/g, '')
      .slice(0, 160) || 'file.txt'
  );
}
export function mimeFor(name: string): string {
  return extname(name) === '.md'
    ? 'text/markdown'
    : extname(name) === '.json'
      ? 'application/json'
      : 'text/plain';
}

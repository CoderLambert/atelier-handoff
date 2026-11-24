/**
 * @file 创建并验证开发工作树的恢复快照。
 * @implementation 保存独立的索引和工作目录 patch、未跟踪文件及校验值，并用实际 Git 状态核对恢复结果。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readlink, symlink } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { gitBranchName, gitOid, gitPath } from '../../../shared/git-workbench.js';
import { fingerprint } from '../../files.js';
import { fileIdentity, gitError, gitText, type LocalGit } from './git-cli.js';
import { readGitStatus } from './git-reader.js';

const bytesLimit = 64 * 1024 * 1024;
const maxEntries = 15_000;
const maxTrackedEntries = 75_000;
const readLimit = 1024 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const fileEntry = z.strictObject({
  path: gitPath,
  untracked: z.boolean(),
  type: z.enum(['file', 'link', 'missing']),
  mode: z.int().min(0).max(0o777),
  hash: digest,
  size: z.int().min(0).max(bytesLimit),
});
const manifestSchema = z.strictObject({
  version: z.literal(1),
  oid: gitOid,
  branch: gitBranchName,
  index: digest,
  workingTree: digest,
  staged: digest,
  unstaged: digest,
  files: z
    .array(fileEntry)
    .max(maxEntries)
    .refine((files) => new Set(files.map(({ path }) => path)).size === files.length),
});
type Manifest = z.infer<typeof manifestSchema>;
type FileEntry = z.infer<typeof fileEntry>;
interface Capture {
  manifest: Manifest;
  staged: Buffer;
  unstaged: Buffer;
  untracked: Map<string, Buffer>;
}

function unsupported() {
  return gitError('SNAPSHOT_UNSUPPORTED', '当前 Git 索引或文件类型无法完整恢复。');
}
function changed() {
  return gitError('WORKTREE_CHANGED', '工作树在快照期间发生变化。');
}
function corrupt() {
  return gitError('SNAPSHOT_CORRUPT', '工作树快照未通过完整性校验。');
}

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function localFile(root: string, path: string, createParents: boolean) {
  const parts = gitPath.parse(path).split('/');
  if (isAbsolute(path) || (sep === '\\' && path.includes('\\'))) throw unsupported();
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (createParents) {
      await mkdir(current, { mode: 0o755 }).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      });
    }
    if (!(await lstat(current)).isDirectory()) throw unsupported();
  }
  return join(root, ...parts);
}

async function readRegular(path: string, limit: number, retainBytes = true) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) throw unsupported();
    const size = Number(before.size);
    const buffer = Buffer.alloc(retainBytes ? size : Math.min(size, 64 * 1024));
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < size) {
      const start = retainBytes ? offset : 0;
      const length = Math.min(buffer.length - start, size - offset);
      const read = await handle.read(buffer, start, length, offset);
      if (!read.bytesRead) throw changed();
      hash.update(buffer.subarray(start, start + read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      before.size !== after.size
    )
      throw changed();
    return { buffer, mode: Number(before.mode) & 0o777, size, hash: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function readWorkingFile(root: string, path: string, untracked: boolean, limit: number) {
  try {
    const target = await localFile(root, path, false);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      const bytes = await readlink(target, { encoding: 'buffer' });
      return {
        bytes,
        entry: {
          path,
          untracked,
          type: 'link',
          mode: 0,
          hash: fingerprint(bytes),
          size: bytes.length,
        } satisfies FileEntry,
      };
    }
    // A tracked deletion may leave a real directory containing untracked files in its place.
    if (!untracked && stat.isDirectory())
      return {
        entry: {
          path,
          untracked,
          type: 'missing',
          mode: 0,
          hash: fingerprint(''),
          size: 0,
        } satisfies FileEntry,
      };
    const { buffer, mode, size, hash } = await readRegular(target, limit, untracked);
    return {
      bytes: buffer,
      entry: {
        path,
        untracked,
        type: 'file',
        mode,
        hash,
        size,
      } satisfies FileEntry,
    };
  } catch (error) {
    if (!isMissing(error) || untracked) throw error;
    return {
      entry: {
        path,
        untracked,
        type: 'missing',
        mode: 0,
        hash: fingerprint(''),
        size: 0,
      } satisfies FileEntry,
    };
  }
}

export async function captureCheckout(
  git: LocalGit,
  branch: string,
  rebuildable: string[] = [],
): Promise<Capture> {
  const patchOptions = [
    '--binary',
    '--full-index',
    '--no-renames',
    '--no-textconv',
    '--no-ext-diff',
    '--no-color',
    '--ignore-submodules=none',
    '--src-prefix=a/',
    '--dst-prefix=b/',
  ];
  const options = { maxBuffer: bytesLimit };
  const [oid, status, index, flags, staged, unstaged] = await Promise.all([
    git.oid('HEAD'),
    readGitStatus(git),
    git.run(['ls-files', '--stage', '-z'], options),
    git.text(['ls-files', '-v', '-z'], options),
    git.run(['diff', '--cached', ...patchOptions, 'HEAD', '--'], options),
    git.run(['diff', ...patchOptions, '--'], options),
  ]);
  if (!oid) throw changed();
  if (
    status.ignored.some(
      (path) => !rebuildable.some((cache) => path === cache || path.startsWith(cache + '/')),
    )
  )
    throw gitError('IGNORED_FILES', '工作树中有未标记为可重建的忽略文件。');
  const indexed = gitText(index).split('\0').filter(Boolean);
  if (
    indexed.some((row) => /^(?:160000 |[0-7]+ [a-f0-9]+ [123]\t)/u.test(row)) ||
    flags.split('\0').some((row) => /^[Sa-z] /u.test(row)) ||
    status.files.some(
      (file) => file.kind === 'conflict' || (file.index === '.' && file.worktree === 'A'),
    )
  )
    throw unsupported();
  const paths = new Map(status.files.map((file) => [file.path, file.kind === 'untracked']));
  for (const row of indexed) {
    const separator = row.indexOf('\t');
    if (separator < 0) throw unsupported();
    const path = gitPath.parse(row.slice(separator + 1));
    if (!paths.has(path)) paths.set(path, false);
  }
  if (paths.size > maxTrackedEntries) throw unsupported();
  const files: FileEntry[] = [];
  const untracked = new Map<string, Buffer>();
  const workingTree = createHash('sha256');
  let remaining = bytesLimit - staged.length - unstaged.length;
  let remainingRead = readLimit;
  for (const path of [...paths.keys()].sort()) {
    if (remaining < 0 || remainingRead < 0) throw unsupported();
    const isUntracked = paths.get(path) === true;
    const { entry, bytes } = await readWorkingFile(
      git.root,
      path,
      isUntracked,
      isUntracked ? Math.min(remaining, remainingRead) : remainingRead,
    );
    workingTree.update(JSON.stringify(entry) + '\n');
    remainingRead -= entry.size;
    if (isUntracked && bytes) {
      untracked.set(path, bytes);
      remaining -= entry.size;
      files.push(entry);
    }
  }
  if (remaining < 0 || remainingRead < 0 || files.length > maxEntries) throw unsupported();
  return {
    manifest: {
      version: 1,
      oid,
      branch,
      files,
      index: fingerprint(index),
      workingTree: workingTree.digest('hex'),
      staged: fingerprint(staged),
      unstaged: fingerprint(unstaged),
    },
    staged,
    unstaged,
    untracked,
  };
}

async function writeDurable(path: string, bytes: string | Buffer) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class WorktreeSnapshots {
  private readonly directory: string;
  constructor(data: string) {
    this.directory = join(data, 'worktree-snapshots');
  }

  private folder(id: string) {
    return join(this.directory, z.uuid().parse(id));
  }

  async save(id: string, capture: Capture) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fileIdentity(this.directory);
    const folder = this.folder(id);
    await mkdir(folder, { mode: 0o700 });
    await writeDurable(join(folder, 'staged.patch'), capture.staged);
    await writeDurable(join(folder, 'unstaged.patch'), capture.unstaged);
    for (const [i, file] of capture.manifest.files.entries()) {
      if (!file.untracked) continue;
      const bytes = capture.untracked.get(file.path);
      if (!bytes) throw changed();
      await writeDurable(join(folder, 'file-' + i), bytes);
    }
    const manifest = JSON.stringify(capture.manifest);
    await writeDurable(join(folder, 'manifest.json'), manifest);
    await syncDirectory(folder);
    await syncDirectory(this.directory);
    await syncDirectory(join(this.directory, '..'));
    return fingerprint(manifest);
  }

  async manifest(id: string, expectedDigest: string): Promise<Manifest> {
    try {
      const folder = this.folder(id);
      await fileIdentity(folder);
      const manifest = await readRegular(join(folder, 'manifest.json'), 8 * 1024 * 1024);
      if (fingerprint(manifest.buffer) !== expectedDigest) throw corrupt();
      return manifestSchema.parse(JSON.parse(gitText(manifest.buffer)));
    } catch {
      throw corrupt();
    }
  }

  async apply(id: string, git: LocalGit, manifest: Manifest) {
    const folder = this.folder(id);
    const payload = async (name: string, hash: string, limit: number) => {
      try {
        const { buffer } = await readRegular(join(folder, name), limit);
        if (fingerprint(buffer) !== hash) throw corrupt();
        return buffer;
      } catch {
        throw corrupt();
      }
    };
    let remaining = bytesLimit;
    for (const [name, hash, options] of [
      ['staged.patch', manifest.staged, ['--index']],
      ['unstaged.patch', manifest.unstaged, []],
    ] as const) {
      const bytes = await payload(name, hash, remaining);
      remaining -= bytes.length;
      if (bytes.length) {
        const args = ['apply', '--whitespace=nowarn', ...options];
        await git.run([...args, '--check', '-'], { input: bytes });
        await git.run([...args, '-'], { input: bytes });
      }
    }
    for (const [i, file] of manifest.files.entries()) {
      if (!file.untracked) continue;
      if (file.type === 'missing' || file.size > remaining) throw corrupt();
      const bytes = await payload('file-' + i, file.hash, file.size);
      if (bytes.length !== file.size) throw corrupt();
      remaining -= bytes.length;
      const target = await localFile(git.root, file.path, true);
      if (file.type === 'link') await symlink(gitText(bytes), target);
      else {
        const handle = await open(target, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.chmod(file.mode);
        } finally {
          await handle.close();
        }
      }
    }
  }

  async verify(git: LocalGit, expected: Manifest, rebuildable: string[] = []) {
    const current = await captureCheckout(git, expected.branch, rebuildable);
    // Compare properties in a stable order rather than depending on the persisted JSON key order.
    if (JSON.stringify(manifestSchema.parse(current.manifest)) !== JSON.stringify(expected))
      throw changed();
  }
}

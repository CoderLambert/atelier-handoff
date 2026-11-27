/**
 * @file 冻结 AI 多提交规划的 HEAD、索引、工作区及完整候选单元。
 * @implementation 只读 Git 和受保护的本机文件，内存计算索引树；双次采集拒绝竞态，导出可校验的三态和依赖契约。
 * @updated 2026-11-27T21:40:00+08:00
 */
import { applyPatch, structuredPatch } from 'diff';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { gitOid, gitPath } from '../../../shared/git-workbench.js';
import { AppError } from '../../../shared/errors.js';
import { fingerprint, MAX_TEXT, resolveProjectPath } from '../../files.js';
import { fileIdentity, gitError, gitText, type LocalGit } from './git-cli.js';
import { readGitStatus } from './git-reader.js';
import { OPEN_REGULAR_READ_FLAGS, readHeadTarget, readRegularFileSafely } from './git-safe-io.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const mode = z.string().regex(/^[0-7]{6}$/u);
export const gitCommitPlanReasonSchema = z.enum([
  'restrictedPath',
  'unreadable',
  'tooLarge',
  'budget',
  'specialFile',
  'specialMode',
  'conflict',
  'indexFlags',
  'intentToAdd',
  'attributes',
  'rename',
  'copy',
  'binary',
  'addition',
  'deletion',
  'modeChange',
  'lineEndings',
  'diffLimit',
]);
/** Content is server-owned. Only text from supported units belongs in model context. */
export const gitCommitPlanFileStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('missing') }),
  z.strictObject({
    kind: z.literal('file'),
    mode,
    oid: gitOid,
    digest,
    size: z.int().nonnegative(),
    encoding: z.enum(['utf8', 'base64']),
    content: z.string(),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: gitCommitPlanReasonSchema,
    mode: mode.nullable(),
    oid: gitOid.nullable(),
    fingerprint: digest,
  }),
]);
export const gitCommitPlanIndexEntrySchema = z.strictObject({
  path: gitPath,
  mode,
  oid: gitOid,
  stage: z.int().min(0).max(3),
  flags: z.int().nonnegative(),
});
const statusSchema = z.strictObject({
  path: z.string(), // Embedded repositories can be reported with a trailing slash.
  previousPath: gitPath.optional(),
  index: z.string().length(1),
  worktree: z.string().length(1),
  kind: z.enum(['tracked', 'untracked', 'conflict']),
});
export const gitCommitPlanFileSchema = z.strictObject({
  id: digest,
  path: gitPath,
  previousPath: gitPath.optional(),
  statuses: z.array(statusSchema),
  head: gitCommitPlanFileStateSchema,
  index: gitCommitPlanFileStateSchema,
  worktree: gitCommitPlanFileStateSchema,
  conflictStages: z.array(gitCommitPlanIndexEntrySchema),
  attributes: z.array(
    z.strictObject({ source: z.enum(['index', 'worktree']), name: z.string(), value: z.string() }),
  ),
});
export const gitCommitPlanHunkSchema = z.strictObject({
  oldStart: z.int().nonnegative(),
  oldLines: z.int().nonnegative(),
  newStart: z.int().nonnegative(),
  newLines: z.int().nonnegative(),
  lines: z.array(z.string()),
});
export const gitCommitPlanUnitSchema = z.strictObject({
  id: digest,
  fileId: digest,
  path: gitPath,
  previousPath: gitPath.optional(),
  layer: z.enum(['staged', 'unstaged', 'untracked', 'conflict']),
  kind: z.enum(['hunk', 'atomic', 'unsupported']),
  reason: gitCommitPlanReasonSchema.nullable(),
  /** All staged units touching this path must precede a workspace unit. */
  dependsOn: z.array(digest),
  hunk: gitCommitPlanHunkSchema.nullable(),
});
export const gitCommitPlanSnapshotSchema = z.strictObject({
  formatVersion: z.literal(1),
  version: digest,
  repositoryId: z.string(),
  rootIdentity: z.string(),
  adminIdentity: z.string(),
  objectFormat: z.enum(['sha1', 'sha256']),
  target: z.strictObject({ ref: z.string(), head: gitOid.nullable(), tree: gitOid.nullable() }),
  index: z.strictObject({
    fingerprint: digest.nullable(),
    tree: gitOid.nullable(),
    treeUnavailableReason: z.enum(['conflict', 'specialMode']).nullable(),
    entries: z.array(gitCommitPlanIndexEntrySchema),
  }),
  configuration: z.string(),
  ignored: z.array(gitPath),
  files: z.array(gitCommitPlanFileSchema),
  units: z.array(gitCommitPlanUnitSchema),
});
export type GitCommitPlanReason = z.infer<typeof gitCommitPlanReasonSchema>;
export type GitCommitPlanFileState = z.infer<typeof gitCommitPlanFileStateSchema>;
export type GitCommitPlanIndexEntry = z.infer<typeof gitCommitPlanIndexEntrySchema>;
export type GitCommitPlanFile = z.infer<typeof gitCommitPlanFileSchema>;
export type GitCommitPlanHunk = z.infer<typeof gitCommitPlanHunkSchema>;
export type GitCommitPlanUnit = z.infer<typeof gitCommitPlanUnitSchema>;
export type GitCommitPlanSnapshot = z.infer<typeof gitCommitPlanSnapshotSchema>;

const maxMetadata = 32 * 1024 * 1024;
const maxContent = 16 * 1024 * 1024;
const maxCandidates = 15_000;
const intentToAdd = 0x20000000;
const skipWorktree = 0x40000000;
const assumeUnchanged = 0x8000;
const relevantFlags = intentToAdd + skipWorktree + assumeUnchanged;
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const changed = () => gitError('PLAN_STALE', '工作树在规划快照期间发生变化，请重新读取。');
const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code));

function objectId(format: 'sha1' | 'sha256', type: 'tree' | 'blob', bytes: Buffer) {
  return createHash(format)
    .update(type + ' ' + bytes.length + '\0')
    .update(bytes)
    .digest('hex');
}

// Hash the exact Git tree serialization; never write-tree, even against a copied index.
function indexTree(entries: GitCommitPlanIndexEntry[], format: 'sha1' | 'sha256') {
  if (entries.some((entry) => entry.stage !== 0))
    return { tree: null, treeUnavailableReason: 'conflict' as const };
  if (entries.some((entry) => !['100644', '100755', '120000', '160000'].includes(entry.mode)))
    return { tree: null, treeUnavailableReason: 'specialMode' as const };
  interface Tree {
    files: Map<string, GitCommitPlanIndexEntry>;
    directories: Map<string, Tree>;
  }
  const root: Tree = { files: new Map(), directories: new Map() };
  for (const entry of entries) {
    if (entry.flags & intentToAdd) continue; // Git excludes CE_INTENT_TO_ADD from write-tree.
    const parts = entry.path.split('/');
    const name = parts.pop();
    if (!name) throw gitError('OUTPUT_INVALID', '无法识别 Git 索引路径。');
    let node = root;
    for (const part of parts) {
      let next = node.directories.get(part);
      if (!next) {
        next = { files: new Map(), directories: new Map() };
        node.directories.set(part, next);
      }
      node = next;
    }
    node.files.set(name, entry);
  }
  const hash = (node: Tree): string => {
    const items = [
      ...[...node.files].map(([name, entry]) => ({
        name,
        mode: entry.mode.replace(/^0/u, ''),
        oid: entry.oid,
        sort: name,
      })),
      ...[...node.directories].map(([name, tree]) => ({
        name,
        mode: '40000',
        oid: hash(tree),
        sort: name + '/',
      })),
    ].sort((a, b) => compare(a.sort, b.sort));
    return objectId(
      format,
      'tree',
      Buffer.concat(
        items.map((item) =>
          Buffer.concat([
            Buffer.from(item.mode + ' ' + item.name + '\0'),
            Buffer.from(item.oid, 'hex'),
          ]),
        ),
      ),
    );
  };
  return { tree: hash(root), treeUnavailableReason: null };
}

function parseIndex(text: string): GitCommitPlanIndexEntry[] {
  const entries: GitCommitPlanIndexEntry[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf('\0', offset);
    const header = /^(\d{6}) ([a-f0-9]+) ([0-3])\t(.*)$/su.exec(text.slice(offset, end));
    const debug =
      /^  ctime: [^\n]*\n  mtime: [^\n]*\n  dev: [^\n]*\n  uid: [^\n]*\n  size: [^\n]*\tflags: ([a-f0-9]+)\n/u.exec(
        text.slice(end + 1),
      );
    if (end < 0 || !header || !debug)
      throw gitError('OUTPUT_INVALID', '无法完整识别 Git 索引及扩展标志。');
    entries.push(
      gitCommitPlanIndexEntrySchema.parse({
        mode: header[1],
        oid: header[2],
        stage: Number(header[3]),
        path: header[4],
        flags: parseInt(debug[1] ?? '', 16),
      }),
    );
    offset = end + 1 + debug[0].length;
  }
  return entries.sort((a, b) => compare(a.path, b.path) || a.stage - b.stage);
}

async function target(git: LocalGit, signal?: AbortSignal) {
  const { ref, head } = await readHeadTarget(git, signal);
  if ((!ref.startsWith('refs/heads/') && ref !== 'HEAD') || (ref === 'HEAD' && !head))
    throw gitError('WORKTREE_CHANGED', '无法确认当前 Git 提交目标。');
  const tree = head
    ? gitOid.parse((await git.text(['rev-parse', head + '^{tree}'], { signal })).trim())
    : null;
  return { ref, head, tree };
}

async function indexFingerprint(git: LocalGit) {
  const result = await readRegularFileSafely(join(git.admin, 'index'), {
    maxBytes: maxMetadata,
    verifyPathInode: false,
  });
  if (result.status === 'missing') return null;
  if (result.status === 'unsafe') {
    if (result.reason === 'open' && !isMissing(result.cause)) throw result.cause;
    throw gitError('PLAN_INDEX_UNSUPPORTED', '当前 Git 索引无法安全读取。');
  }
  if (result.status === 'changed') throw changed();
  return fingerprint(result.bytes);
}

function unavailable(
  reason: GitCommitPlanReason,
  observed: unknown,
  fileMode: string | null = null,
  oid: string | null = null,
): GitCommitPlanFileState {
  return {
    kind: 'unavailable',
    reason,
    mode: fileMode,
    oid,
    fingerprint: fingerprint(JSON.stringify(observed)),
  };
}
function content(
  bytes: Buffer,
  fileMode: string,
  format: 'sha1' | 'sha256',
): GitCommitPlanFileState {
  let text: string | undefined;
  if (!bytes.includes(0)) {
    try {
      text = gitText(bytes);
    } catch {
      /* Exact bytes remain available as an atomic binary. */
    }
  }
  return {
    kind: 'file',
    mode: fileMode,
    oid: objectId(format, 'blob', bytes),
    digest: fingerprint(bytes),
    size: bytes.length,
    encoding: text === undefined ? 'base64' : 'utf8',
    content: text ?? bytes.toString('base64'),
  };
}

async function capture(git: LocalGit, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const beforeIndex = await indexFingerprint(git);
  const initialTarget = await target(git, signal);
  const [objectFormat, status, listing, treeListing, configuration, rootIdentity, adminIdentity] =
    await Promise.all([
      git
        .text(['rev-parse', '--show-object-format'], { signal })
        .then((value) => z.enum(['sha1', 'sha256']).parse(value.trim())),
      readGitStatus(git, signal),
      git.text(['ls-files', '--stage', '--debug', '-z'], { signal, maxBuffer: maxMetadata }),
      initialTarget.head
        ? git.text(['ls-tree', '-r', '-z', '--full-tree', initialTarget.head], {
            signal,
            maxBuffer: maxMetadata,
          })
        : '',
      git.text(
        [
          'config',
          '--null',
          '--get-regexp',
          '^(core\.(autocrlf|eol|filemode|symlinks|ignorecase|precomposeunicode)|filter\.|extensions\.)',
        ],
        { signal, allowExit: [1], maxBuffer: maxMetadata },
      ),
      fileIdentity(git.root),
      fileIdentity(git.admin),
    ]);
  const entries = parseIndex(listing);
  const conflicts = new Map<string, GitCommitPlanIndexEntry[]>();
  for (const entry of entries) {
    if (!entry.stage) continue;
    const stages = conflicts.get(entry.path) ?? [];
    stages.push(entry);
    conflicts.set(entry.path, stages);
  }
  const indexed = new Map(
    entries.filter((entry) => entry.stage === 0).map((entry) => [entry.path, entry]),
  );
  const heads = new Map<string, { mode: string; oid: string }>();
  for (const row of treeListing.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]+)\t(.*)$/su.exec(row);
    if (!match) throw gitError('OUTPUT_INVALID', '无法识别 HEAD 文件树。');
    heads.set(gitPath.parse(match[3]), { mode: mode.parse(match[1]), oid: gitOid.parse(match[2]) });
  }
  const candidates = new Map<string, z.infer<typeof statusSchema>[]>();
  for (const record of status.files) {
    const path = gitPath.parse(record.path.replace(/\/$/u, ''));
    const rows = candidates.get(path) ?? [];
    rows.push(statusSchema.parse(record));
    candidates.set(path, rows);
  }
  // These flags can conceal actual modifications from status. Keep them explicit and non-executable.
  for (const entry of entries) {
    if (entry.flags & relevantFlags && !candidates.has(entry.path)) candidates.set(entry.path, []);
  }
  if (candidates.size > maxCandidates)
    throw gitError('PLAN_LIMIT', '候选文件超过完整快照读取上限。', 413);
  let remaining = maxContent;
  const files: GitCommitPlanFile[] = [];
  const blobs = new Map<string, GitCommitPlanFileState>();
  const blob = async (
    entry: { mode: string; oid: string } | undefined,
    restricted: boolean,
  ): Promise<GitCommitPlanFileState> => {
    if (!entry) return { kind: 'missing' };
    if (restricted) return unavailable('restrictedPath', entry, entry.mode, entry.oid);
    if (!['100644', '100755'].includes(entry.mode))
      return unavailable('specialMode', entry, entry.mode, entry.oid);
    const key = entry.mode + ':' + entry.oid;
    const cached = blobs.get(key);
    if (cached) {
      if (cached.kind === 'file') {
        if (cached.size > remaining) return unavailable('budget', entry, entry.mode, entry.oid);
        remaining -= cached.size; // Count every serialized occurrence, including shared blobs.
      }
      return cached;
    }
    const size = Number((await git.text(['cat-file', '-s', entry.oid], { signal })).trim());
    if (!Number.isSafeInteger(size) || size < 0)
      throw gitError('OUTPUT_INVALID', '无法识别 Git 对象大小。');
    let result: GitCommitPlanFileState;
    if (size > MAX_TEXT || size > remaining)
      result = unavailable(size > MAX_TEXT ? 'tooLarge' : 'budget', entry, entry.mode, entry.oid);
    else {
      const bytes = await git.run(['cat-file', 'blob', entry.oid], {
        signal,
        maxBuffer: MAX_TEXT + 1,
      });
      if (bytes.length !== size || objectId(objectFormat, 'blob', bytes) !== entry.oid)
        throw changed();
      remaining -= size;
      result = content(bytes, entry.mode, objectFormat);
    }
    blobs.set(key, result);
    return result;
  };
  for (const [path, statuses] of [...candidates].sort(([a], [b]) => compare(a, b))) {
    signal?.throwIfAborted();
    const previousPath = statuses.find((row) => row.previousPath)?.previousPath;
    let restricted = false;
    for (const name of [path, ...(previousPath ? [previousPath] : [])]) {
      if (isAbsolute(name) || (sep === '\\' && name.includes('\\'))) {
        restricted = true;
        continue;
      }
      try {
        await resolveProjectPath(git.root, name, { create: true });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        restricted = true;
      }
    }
    const head = await blob(heads.get(previousPath ?? path), restricted);
    const entry = indexed.get(path);
    const index =
      entry?.flags && entry.flags & intentToAdd
        ? { kind: 'missing' as const }
        : await blob(entry, restricted);
    let worktree: GitCommitPlanFileState;
    // Metadata alone invalidates restricted/unsupported candidates without disclosing their bytes.
    let observation: unknown = 'missing';
    try {
      const info = await lstat(join(git.root, path), { bigint: true });
      observation = [
        String(info.dev),
        String(info.ino),
        String(info.mode),
        String(info.size),
        String(info.ctimeNs),
        String(info.mtimeNs),
      ];
      if (restricted) worktree = unavailable('restrictedPath', observation);
      else if (!info.isFile() || info.nlink !== 1n)
        worktree = unavailable('specialFile', observation);
      else if (info.size > BigInt(MAX_TEXT) || info.size > BigInt(remaining))
        worktree = unavailable(info.size > BigInt(MAX_TEXT) ? 'tooLarge' : 'budget', observation);
      else {
        const safePath = await resolveProjectPath(git.root, path);
        const handle = await open(safePath, OPEN_REGULAR_READ_FLAGS);
        try {
          const opened = await handle.stat({ bigint: true });
          if (
            !opened.isFile() ||
            opened.nlink !== 1n ||
            opened.ino !== info.ino ||
            opened.dev !== info.dev
          )
            throw changed();
          await resolveProjectPath(git.root, path);
          const bytes = Buffer.alloc(Number(info.size));
          let offset = 0;
          while (offset < bytes.length) {
            signal?.throwIfAborted();
            const read = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!read.bytesRead) throw changed();
            offset += read.bytesRead;
          }
          const after = await handle.stat({ bigint: true });
          if (
            after.ctimeNs !== info.ctimeNs ||
            after.mtimeNs !== info.mtimeNs ||
            after.size !== info.size
          )
            throw changed();
          await resolveProjectPath(git.root, path);
          remaining -= bytes.length;
          worktree = content(bytes, info.mode & 0o100n ? '100755' : '100644', objectFormat);
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'GIT_PLAN_STALE') throw error;
      if (isMissing(error))
        worktree = restricted ? unavailable('restrictedPath', observation) : { kind: 'missing' };
      else worktree = unavailable(restricted ? 'restrictedPath' : 'unreadable', observation);
    }
    const attributes: GitCommitPlanFile['attributes'] = [];
    if (!restricted) {
      for (const source of ['index', 'worktree'] as const) {
        const values = (
          await git.text(
            [
              'check-attr',
              ...(source === 'index' ? ['--cached'] : []),
              '-z',
              '--stdin',
              'filter',
              'text',
              'eol',
              'working-tree-encoding',
              'diff',
            ],
            { signal, input: Buffer.from(path + '\0') },
          )
        ).split('\0');
        if (values.pop() !== '' || values.length !== 15)
          throw gitError('OUTPUT_INVALID', '无法识别 Git 文件属性。');
        for (let i = 0; i < values.length; i += 3) {
          const name = values[i + 1];
          const value = values[i + 2];
          if (values[i] !== path || name === undefined || value === undefined)
            throw gitError('OUTPUT_INVALID', '无法识别 Git 文件属性。');
          attributes.push({ source, name, value });
        }
      }
    }
    files.push({
      id: fingerprint(JSON.stringify([git.repositoryId, path, previousPath ?? null])),
      path,
      ...(previousPath ? { previousPath } : {}),
      statuses,
      head,
      index,
      worktree,
      attributes,
      conflictStages: conflicts.get(path) ?? [],
    });
  }
  if (
    beforeIndex !== (await indexFingerprint(git)) ||
    JSON.stringify(initialTarget) !== JSON.stringify(await target(git, signal))
  )
    throw changed();
  return {
    formatVersion: 1 as const,
    repositoryId: git.repositoryId,
    rootIdentity,
    adminIdentity,
    objectFormat,
    target: initialTarget,
    index: { fingerprint: beforeIndex, ...indexTree(entries, objectFormat), entries },
    configuration,
    ignored: status.ignored.sort(compare),
    files,
  };
}

function unitsFor(
  file: GitCommitPlanFile,
  entry: GitCommitPlanIndexEntry | undefined,
  configuration: string,
): GitCommitPlanUnit[] {
  const units: GitCommitPlanUnit[] = [];
  const add = (
    layer: GitCommitPlanUnit['layer'],
    kind: GitCommitPlanUnit['kind'],
    reason: GitCommitPlanReason | null,
    from: GitCommitPlanFileState,
    to: GitCommitPlanFileState,
    hunk: GitCommitPlanHunk | null = null,
  ) => {
    const value = {
      fileId: file.id,
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      layer,
      kind,
      reason,
      dependsOn: [] as string[],
      hunk,
    };
    const identity = (state: GitCommitPlanFileState) =>
      state.kind === 'file' ? [state.kind, state.mode, state.oid, state.digest] : state;
    units.push({
      id: fingerprint(JSON.stringify([value, identity(from), identity(to)])),
      ...value,
    });
  };
  if (file.conflictStages.length || file.statuses.some((row) => row.kind === 'conflict')) {
    add('conflict', 'unsupported', 'conflict', file.index, file.worktree);
    return units;
  }
  const layer = (
    name: 'staged' | 'unstaged' | 'untracked',
    from: GitCommitPlanFileState,
    to: GitCommitPlanFileState,
  ) => {
    if (from.kind === 'unavailable') {
      add(name, 'unsupported', from.reason, from, to);
      return;
    }
    if (to.kind === 'unavailable') {
      add(name, 'unsupported', to.reason, from, to);
      return;
    }
    if (entry && entry.flags & (skipWorktree + assumeUnchanged)) {
      add(name, 'unsupported', 'indexFlags', from, to);
      return;
    }
    if (entry && entry.flags & intentToAdd) {
      add(name, 'unsupported', 'intentToAdd', from, to);
      return;
    }
    if (
      file.attributes.some((attr) => attr.value !== 'unspecified') ||
      /core\.autocrlf\n(?:true|input)\0/u.test(configuration)
    ) {
      add(name, 'unsupported', 'attributes', from, to);
      return;
    }
    if (file.statuses.some((status) => status.index === 'C' || status.worktree === 'C')) {
      add(name, 'unsupported', 'copy', from, to);
      return;
    }
    if (name === 'staged' && file.previousPath) {
      add(name, 'atomic', 'rename', from, to);
      return;
    }
    if (from.kind === 'missing' || to.kind === 'missing') {
      add(name, 'atomic', from.kind === 'missing' ? 'addition' : 'deletion', from, to);
      return;
    }
    if (from.encoding !== 'utf8' || to.encoding !== 'utf8') {
      add(name, 'atomic', 'binary', from, to);
      return;
    }
    if (from.mode !== to.mode) {
      add(name, 'atomic', 'modeChange', from, to);
      return;
    }
    if (from.content.includes('\r') || to.content.includes('\r')) {
      add(name, 'atomic', 'lineEndings', from, to);
      return;
    }
    const patch = structuredPatch(
      file.path,
      file.path,
      from.content,
      to.content,
      undefined,
      undefined,
      { context: 3, maxEditLength: 4000 },
    );
    if (
      !patch ||
      !patch.hunks.length ||
      applyPatch(from.content, patch, { fuzzFactor: 0, autoConvertLineEndings: false }) !==
        to.content
    ) {
      add(name, 'atomic', 'diffLimit', from, to);
      return;
    }
    for (const hunk of patch.hunks)
      add(name, 'hunk', null, from, to, gitCommitPlanHunkSchema.parse(hunk));
  };
  if (file.statuses.some((row) => row.kind === 'tracked' && row.index !== '.'))
    layer('staged', file.head, file.index);
  if (file.statuses.some((row) => row.kind === 'untracked'))
    layer('untracked', file.index, file.worktree);
  else if (
    file.statuses.some((row) => row.kind === 'tracked' && row.worktree !== '.') ||
    (entry && entry.flags & relevantFlags)
  )
    layer('unstaged', file.index, file.worktree);
  return units;
}

/**
 * Read only; no index, worktree, object, or reference writes. Callers must hold their worktree
 * lease and revalidate `version` immediately before execution. Two matching observations detect
 * ordinary concurrent edits, not adversarial ABA changes. Unsupported units must stay visible.
 * Ignored paths are explicitly listed, never read. Nothing here authorizes a commit or model call.
 */
export async function readCommitPlanSnapshot(
  git: LocalGit,
  signal?: AbortSignal,
): Promise<GitCommitPlanSnapshot> {
  const first = await capture(git, signal);
  const second = await capture(git, signal);
  const version = fingerprint(JSON.stringify(first));
  if (version !== fingerprint(JSON.stringify(second))) throw changed();
  const indexed = new Map(
    first.index.entries.filter((entry) => entry.stage === 0).map((entry) => [entry.path, entry]),
  );
  const units = first.files.flatMap((file) =>
    unitsFor(file, indexed.get(file.path), first.configuration),
  );
  const stagedByPath = new Map<string, string[]>();
  for (const unit of units) {
    if (unit.layer !== 'staged') continue;
    for (const path of [unit.path, ...(unit.previousPath ? [unit.previousPath] : [])]) {
      const ids = stagedByPath.get(path) ?? [];
      ids.push(unit.id);
      stagedByPath.set(path, ids);
    }
  }
  for (const unit of units) {
    if (unit.layer !== 'unstaged' && unit.layer !== 'untracked') continue;
    const touched = [unit.path, ...(unit.previousPath ? [unit.previousPath] : [])];
    unit.dependsOn = [...new Set(touched.flatMap((path) => stagedByPath.get(path) ?? []))];
  }
  return gitCommitPlanSnapshotSchema.parse({ ...first, version, units });
}

/**
 * @file 将已确认的变更分组编译成有序提交树和保留暂存语义的索引覆盖。
 * @implementation 只在内存按冻结的两层基线重建精确内容，严格核对分组、依赖和块坐标；输出不可变覆盖，不读取文件或执行 Git。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gitCommitMessage } from '../../../shared/git-workbench.js';
import { AppError } from '../../../shared/errors.js';
import {
  gitCommitPlanSnapshotSchema,
  type GitCommitPlanFile,
  type GitCommitPlanFileState,
  type GitCommitPlanHunk,
  type GitCommitPlanSnapshot,
  type GitCommitPlanUnit,
} from './commit-plan-snapshot.js';

const id = z.string().min(1).max(128);
export const gitCommitPlanCompilationSchema = z.strictObject({
  groups: z
    .array(gitCommitMessage.extend({ unitIds: z.array(id).min(1).max(15_000) }))
    .min(1)
    .max(512),
  excludedUnitIds: z.array(id).max(15_000),
});
export type GitCommitPlanCompilationInput = z.input<typeof gitCommitPlanCompilationSchema>;
export type GitCommitPlanCompiledState = Readonly<
  Exclude<GitCommitPlanFileState, { kind: 'unavailable' }>
>;
export interface GitCommitPlanCompiledFile {
  readonly path: string;
  /** Exact blob bytes are represented by encoding/content; missing removes the path. */
  readonly state: GitCommitPlanCompiledState;
}
export interface GitCommitPlanCompiledTree {
  readonly base: 'head';
  /** Cumulative overrides of the ORIGINAL snapshot HEAD tree, not the preceding commit. */
  readonly files: readonly GitCommitPlanCompiledFile[];
}
export interface GitCommitPlanCompiledIndex {
  readonly base: 'index';
  /** Cumulative overrides of the ORIGINAL index. Preserve all untouched entries and flags. */
  readonly files: readonly GitCommitPlanCompiledFile[];
}
export interface GitCommitPlanCompiledCommit {
  readonly title: string;
  readonly body: string;
  /** Dependency order within this commit; the user's group ordering remains unchanged. */
  readonly unitIds: readonly string[];
  readonly tree: GitCommitPlanCompiledTree;
  readonly index: GitCommitPlanCompiledIndex;
}
export interface GitCommitPlanCompilation {
  readonly snapshotVersion: string;
  readonly repositoryId: string;
  readonly target: Readonly<GitCommitPlanSnapshot['target']>;
  readonly indexFingerprint: string | null;
  readonly commits: readonly GitCommitPlanCompiledCommit[];
  readonly finalIndex: GitCommitPlanCompiledIndex;
  readonly excludedUnitIds: readonly string[];
}

const fail = (code: string, message: string): never => {
  throw new AppError('GIT_PLAN_' + code, message, 409);
};
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const missing: GitCommitPlanCompiledState = Object.freeze({ kind: 'missing' });
const equal = (a: GitCommitPlanFileState, b: GitCommitPlanFileState) =>
  a.kind === 'missing'
    ? b.kind === 'missing'
    : a.kind === 'file' && b.kind === 'file' && a.mode === b.mode && a.digest === b.digest;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const blobId = (format: GitCommitPlanSnapshot['objectFormat'], bytes: Buffer) =>
  createHash(format)
    .update('blob ' + bytes.length + '\0')
    .update(bytes)
    .digest('hex');

function exactState(state: GitCommitPlanFileState, format: GitCommitPlanSnapshot['objectFormat']) {
  if (state.kind !== 'file') return;
  const bytes = Buffer.from(state.content, state.encoding === 'utf8' ? 'utf8' : 'base64');
  if (
    bytes.toString(state.encoding === 'utf8' ? 'utf8' : 'base64') !== state.content ||
    bytes.length !== state.size ||
    hash(bytes) !== state.digest ||
    (state.oid !== null && blobId(format, bytes) !== state.oid)
  )
    fail('INVALID_SNAPSHOT', '快照文件内容与其指纹不一致。');
}
function copyState(state: GitCommitPlanFileState): GitCommitPlanCompiledState {
  if (state.kind === 'unavailable') return fail('UNSUPPORTED', '所选变更的完整文件内容不可用。');
  return state.kind === 'missing' ? missing : Object.freeze({ ...state });
}
function textState(
  text: string,
  source: GitCommitPlanCompiledState,
  format: GitCommitPlanSnapshot['objectFormat'],
): GitCommitPlanCompiledState {
  if (source.kind !== 'file') return fail('UNSAFE_HUNK', '文本变更块缺少原始文件。');
  const bytes = Buffer.from(text);
  return Object.freeze({
    kind: 'file',
    mode: source.mode,
    encoding: 'utf8',
    content: text,
    oid: blobId(format, bytes),
    digest: hash(bytes),
    size: bytes.length,
  });
}

interface Replacement {
  start: number;
  count: number;
  added: string[];
}
interface Layer {
  units: GitCommitPlanUnit[];
  from: GitCommitPlanCompiledState;
  to: GitCommitPlanCompiledState;
  lines: string[] | null;
  replacements: Map<string, Replacement>;
}
const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];

/** Decode at the stated coordinate only. No context search, offsets, fuzz, or newline conversion. */
function replacement(
  hunk: GitCommitPlanHunk,
  source: string[],
  target: string[],
  delta: number,
): Replacement {
  // diff's structuredPatch coordinates are always 1-based, including empty ranges.
  // Only its unified-patch serializer subtracts another line for a zero-length range.
  const start = hunk.oldStart - 1;
  const newStart = hunk.newStart - 1;
  if (
    start < 0 ||
    newStart < 0 ||
    newStart !== start + delta ||
    start + hunk.oldLines > source.length ||
    newStart + hunk.newLines > target.length
  )
    return fail('UNSAFE_HUNK', '变更块坐标与冻结文件不一致。');
  const removed: string[] = [];
  const added: string[] = [];
  let changes = 0;
  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i];
    if (line === undefined || ![' ', '+', '-'].includes(line[0] ?? '') || /[\r\n]/u.test(line))
      return fail('UNSAFE_HUNK', '变更块包含无效行。');
    const noNewline = hunk.lines[i + 1] === '\\ No newline at end of file';
    const token = line.slice(1) + (noNewline ? '' : '\n');
    if (line[0] !== '+') removed.push(token);
    if (line[0] !== '-') added.push(token);
    if (line[0] !== ' ') changes++;
    if (noNewline) i++;
  }
  if (
    !changes ||
    removed.length !== hunk.oldLines ||
    added.length !== hunk.newLines ||
    removed.some((line, i) => source[start + i] !== line) ||
    added.some((line, i) => target[newStart + i] !== line)
  )
    return fail('UNSAFE_HUNK', '变更块无法按原始坐标精确重建。');
  return { start, count: removed.length, added };
}
function render(
  layer: Layer,
  selected: ReadonlySet<string>,
  format: GitCommitPlanSnapshot['objectFormat'],
): GitCommitPlanCompiledState {
  if (!layer.units.some((unit) => selected.has(unit.id))) return layer.from;
  if (layer.lines === null) return layer.to;
  const result: string[] = [];
  let offset = 0;
  for (const unit of layer.units) {
    if (!selected.has(unit.id)) continue;
    const edit = layer.replacements.get(unit.id);
    if (!edit) return fail('INVALID_SNAPSHOT', '变更块缺少已验证的替换内容。');
    result.push(layer.lines.slice(offset, edit.start).join(''), edit.added.join(''));
    offset = edit.start + edit.count;
  }
  result.push(layer.lines.slice(offset).join(''));
  return textState(result.join(''), layer.from, format);
}
function compileLayer(
  file: GitCommitPlanFile,
  units: GitCommitPlanUnit[],
  staged: boolean,
  format: GitCommitPlanSnapshot['objectFormat'],
): Layer | null {
  if (!units.length) return null;
  if (units.some((unit) => unit.kind === 'unsupported'))
    return fail('UNSUPPORTED', '所选文件层包含不能安全重建的单元。');
  const from = copyState(staged ? file.head : file.index);
  const to = copyState(staged ? file.index : file.worktree);
  if (
    [from, to].some(
      (state) => state.kind === 'file' && !['100644', '100755'].includes(state.mode),
    ) ||
    equal(from, to) ||
    units.some((unit) => unit.previousPath !== undefined)
  )
    return fail('UNSUPPORTED', '该文件变更无法安全拆分或重建。');
  if (units.some((unit) => unit.kind === 'atomic')) {
    if (units.length !== 1 || units.some((unit) => unit.hunk !== null))
      return fail('INVALID_SNAPSHOT', '原子变更必须独占该文件层。');
    return { units, from, to, lines: null, replacements: new Map() };
  }
  if (
    from.kind !== 'file' ||
    to.kind !== 'file' ||
    from.mode !== to.mode ||
    from.encoding !== 'utf8' ||
    to.encoding !== 'utf8' ||
    /[\r\0]/u.test(from.content + to.content)
  )
    return fail('UNSAFE_HUNK', '该文件不能安全应用文本块。');
  const sorted = [...units].sort((a, b) => (a.hunk?.oldStart ?? 0) - (b.hunk?.oldStart ?? 0));
  const lines = linesOf(from.content);
  const target = linesOf(to.content);
  const replacements = new Map<string, Replacement>();
  let delta = 0;
  let end = 0;
  let previousStart = -1;
  for (const unit of sorted) {
    if (!unit.hunk || unit.reason !== null)
      return fail('INVALID_SNAPSHOT', '文本单元缺少有效变更块。');
    const edit = replacement(unit.hunk, lines, target, delta);
    if (edit.start < end || edit.start === previousStart)
      return fail('UNSAFE_HUNK', '变更块重叠，无法独立分组。');
    replacements.set(unit.id, edit);
    previousStart = edit.start;
    end = edit.start + edit.count;
    delta += edit.added.length - edit.count;
  }
  const layer: Layer = { units: sorted, from, to, lines, replacements };
  if (!equal(render(layer, new Set(units.map((unit) => unit.id)), format), to))
    return fail('UNSAFE_HUNK', '完整变更块不能精确重建目标文件。');
  return layer;
}

function overlay<B extends 'head' | 'index'>(
  base: B,
  values: ReadonlyMap<string, GitCommitPlanCompiledState>,
) {
  return Object.freeze({
    base,
    files: Object.freeze(
      [...values]
        .sort(([a], [b]) => compare(a, b))
        .map(([path, state]) => Object.freeze({ path, state })),
    ),
  });
}
function update(
  values: Map<string, GitCommitPlanCompiledState>,
  path: string,
  state: GitCommitPlanCompiledState,
  baseline: GitCommitPlanFileState,
) {
  if (equal(state, baseline)) values.delete(path);
  else values.set(path, state);
}
function checkPaths(
  baseline: ReadonlySet<string>,
  values: ReadonlyMap<string, GitCommitPlanCompiledState>,
) {
  const paths = new Set(baseline);
  for (const [path, state] of values) {
    if (state.kind === 'missing') paths.delete(path);
    else paths.add(path);
  }
  for (const path of paths) {
    let slash = path.indexOf('/');
    while (slash !== -1) {
      if (paths.has(path.slice(0, slash)))
        fail('PATH_CONFLICT', '该提交或索引同时包含文件和同名目录。');
      slash = path.indexOf('/', slash + 1);
    }
  }
}

/**
 * Compile a server-owned snapshot and an explicitly complete user selection. No I/O or Git calls.
 * Each tree starts at snapshot.target.tree; each index starts at the original index backup.
 * An executor must revalidate snapshotVersion/target/indexFingerprint before publishing either.
 * Excluded unsupported units remain untouched. Unmerged/invalid indexes, selected renames, filters,
 * and any layer whose bytes cannot be reconstructed exactly fail closed.
 */
export function compileCommitPlan(
  snapshot: GitCommitPlanSnapshot,
  input: unknown,
): GitCommitPlanCompilation {
  const parsedSnapshot = gitCommitPlanSnapshotSchema.safeParse(snapshot);
  if (!parsedSnapshot.success) return fail('INVALID_SNAPSHOT', '提交计划快照无效。');
  const parsedInput = gitCommitPlanCompilationSchema.safeParse(input);
  if (!parsedInput.success) return fail('INVALID', '提交分组、说明或明确排除列表无效。');
  snapshot = parsedSnapshot.data;
  const plan = parsedInput.data;
  if (
    snapshot.index.treeUnavailableReason !== null ||
    snapshot.index.entries.some((entry) => entry.stage !== 0)
  )
    return fail('UNSUPPORTED', '当前索引包含冲突或无法重建的条目。');
  if ((snapshot.target.head === null) !== (snapshot.target.tree === null))
    return fail('INVALID_SNAPSHOT', '快照 HEAD 与树身份不一致。');
  const entries = new Map<string, GitCommitPlanSnapshot['index']['entries'][number]>();
  for (const entry of snapshot.index.entries) {
    if (entries.has(entry.path)) return fail('INVALID_SNAPSHOT', '快照索引条目重复。');
    entries.set(entry.path, entry);
  }
  const files = new Map<string, GitCommitPlanFile>();
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (files.has(file.id) || paths.has(file.path))
      return fail('INVALID_SNAPSHOT', '快照文件重复。');
    files.set(file.id, file);
    paths.add(file.path);
    for (const state of [file.head, file.index, file.worktree])
      exactState(state, snapshot.objectFormat);
    const entry = entries.get(file.path);
    if (
      (snapshot.target.head === null && file.head.kind !== 'missing') ||
      (file.index.kind === 'file' &&
        (!entry || entry.mode !== file.index.mode || entry.oid !== file.index.oid)) ||
      (file.index.kind === 'missing' && entry && !(entry.flags & 0x20000000))
    )
      return fail('INVALID_SNAPSHOT', '快照三态与 HEAD 或索引条目不一致。');
  }
  const units = new Map<string, GitCommitPlanUnit>();
  const byFile = new Map<string, GitCommitPlanUnit[]>();
  for (const unit of snapshot.units) {
    const file = files.get(unit.fileId);
    if (
      units.has(unit.id) ||
      !file ||
      file.path !== unit.path ||
      file.previousPath !== unit.previousPath ||
      (unit.layer === 'conflict' && unit.kind !== 'unsupported') ||
      (unit.layer === 'untracked' && file.index.kind !== 'missing')
    )
      return fail('INVALID_SNAPSHOT', '快照单元身份或文件层无效。');
    units.set(unit.id, unit);
    const rows = byFile.get(unit.fileId) ?? [];
    rows.push(unit);
    byFile.set(unit.fileId, rows);
  }
  const assignments = new Map<string, number | null>();
  const assign = (unitId: string, group: number | null) => {
    const unit = units.get(unitId);
    if (!unit) return fail('UNKNOWN_UNIT', '提交计划包含未知变更单元。');
    if (assignments.has(unitId)) return fail('DUPLICATE_UNIT', '变更单元被重复归组或排除。');
    if (
      group !== null &&
      (unit.kind === 'unsupported' || unit.reason === 'rename' || unit.previousPath !== undefined)
    )
      return fail('UNSUPPORTED', '所选计划包含不支持的变更单元。');
    assignments.set(unitId, group);
  };
  plan.groups.forEach((group, i) => group.unitIds.forEach((unitId) => assign(unitId, i)));
  plan.excludedUnitIds.forEach((unitId) => assign(unitId, null));
  if (assignments.size !== units.size)
    return fail('UNASSIGNED_UNIT', '每个变更单元必须明确归组或排除。');
  for (const unit of units.values()) {
    if (
      new Set(unit.dependsOn).size !== unit.dependsOn.length ||
      unit.dependsOn.some((dependency) => !units.has(dependency) || dependency === unit.id)
    )
      return fail('INVALID_SNAPSHOT', '快照依赖无效。');
    if (unit.layer === 'unstaged' || unit.layer === 'untracked') {
      const staged = (byFile.get(unit.fileId) ?? []).filter((other) => other.layer === 'staged');
      if (staged.some((dependency) => !unit.dependsOn.includes(dependency.id)))
        return fail('INVALID_SNAPSHOT', '工作区单元缺少暂存层依赖。');
    }
    const group = assignments.get(unit.id);
    if (group === null || group === undefined) continue;
    for (const dependency of unit.dependsOn) {
      const before = assignments.get(dependency);
      if (before === null || before === undefined || before > group)
        return fail('DEPENDENCY', '所选变更的依赖必须在本组或此前提交中。');
    }
  }
  const pending = new Map([...units.values()].map((unit) => [unit.id, unit.dependsOn.length]));
  const dependents = new Map<string, GitCommitPlanUnit[]>();
  const ordered = [...units.values()].filter((unit) => unit.dependsOn.length === 0);
  for (const unit of units.values())
    for (const dependency of unit.dependsOn) {
      const rows = dependents.get(dependency) ?? [];
      rows.push(unit);
      dependents.set(dependency, rows);
    }
  for (let i = 0; i < ordered.length; i++) {
    const unit = ordered[i];
    if (!unit) return fail('INVALID_SNAPSHOT', '快照依赖顺序无效。');
    for (const next of dependents.get(unit.id) ?? []) {
      const count = (pending.get(next.id) ?? 0) - 1;
      pending.set(next.id, count);
      if (count === 0) ordered.push(next);
    }
  }
  if (ordered.length !== units.size) return fail('INVALID_SNAPSHOT', '快照变更依赖存在循环。');
  const layers = new Map<string, { staged: Layer | null; workspace: Layer | null }>();
  for (const [fileId, rows] of byFile) {
    if (!rows.some((unit) => assignments.get(unit.id) !== null)) continue;
    const file = files.get(fileId);
    if (!file) return fail('INVALID_SNAPSHOT', '变更单元缺少文件。');
    if (
      file.conflictStages.length ||
      file.attributes.some((attribute) => attribute.value !== 'unspecified') ||
      (entries.get(file.path)?.flags ?? 0) & (0x20000000 | 0x40000000 | 0x8000) ||
      /core\.autocrlf\n(?:true|input)\0/u.test(snapshot.configuration)
    )
      return fail('UNSUPPORTED', '所选文件包含冲突、特殊索引标志或内容转换配置。');
    const staged = rows.filter((unit) => unit.layer === 'staged');
    const workspace = rows.filter(
      (unit) => unit.layer === 'unstaged' || unit.layer === 'untracked',
    );
    if (!staged.length && !equal(file.head, file.index))
      return fail('INVALID_SNAPSHOT', '文件缺少完整的 HEAD 到索引变更单元。');
    if (workspace.some((unit) => unit.layer !== workspace[0]?.layer))
      return fail('INVALID_SNAPSHOT', '同一文件的工作区层类型不一致。');
    layers.set(fileId, {
      staged: staged.some((unit) => assignments.get(unit.id) !== null)
        ? compileLayer(file, staged, true, snapshot.objectFormat)
        : null,
      workspace: workspace.some((unit) => assignments.get(unit.id) !== null)
        ? compileLayer(file, workspace, false, snapshot.objectFormat)
        : null,
    });
  }
  const indexPaths = new Set(snapshot.index.entries.map((entry) => entry.path));
  const headPaths = new Set(indexPaths);
  for (const file of files.values()) {
    headPaths.delete(file.path);
    if (file.previousPath) headPaths.delete(file.previousPath);
  }
  for (const file of files.values())
    if (file.head.kind !== 'missing') headPaths.add(file.previousPath ?? file.path);
  const selected = new Set<string>();
  const tree = new Map<string, GitCommitPlanCompiledState>();
  const index = new Map<string, GitCommitPlanCompiledState>();
  const commits: GitCommitPlanCompiledCommit[] = [];
  plan.groups.forEach((group, i) => {
    const groupUnits = ordered.filter((unit) => assignments.get(unit.id) === i);
    for (const unit of groupUnits) selected.add(unit.id);
    let changed = false;
    for (const fileId of new Set(groupUnits.map((unit) => unit.fileId))) {
      const file = files.get(fileId);
      const layer = layers.get(fileId);
      if (!file || !layer) return fail('INVALID_SNAPSHOT', '所选变更缺少可重建层。');
      const workspaceSelected =
        layer.workspace?.units.some((unit) => selected.has(unit.id)) ?? false;
      const state =
        workspaceSelected && layer.workspace
          ? render(layer.workspace, selected, snapshot.objectFormat)
          : layer.staged
            ? render(layer.staged, selected, snapshot.objectFormat)
            : copyState(file.head);
      if (!equal(tree.get(file.path) ?? file.head, state)) changed = true;
      update(tree, file.path, state, file.head);
      if (workspaceSelected) update(index, file.path, state, file.index);
    }
    if (!changed) return fail('EMPTY_GROUP', '提交分组没有产生实际文件变更。');
    checkPaths(headPaths, tree);
    checkPaths(indexPaths, index);
    commits.push(
      Object.freeze({
        title: group.title,
        body: group.body.trim(),
        unitIds: Object.freeze(groupUnits.map((unit) => unit.id)),
        tree: overlay('head', tree),
        index: overlay('index', index),
      }),
    );
  });
  return Object.freeze({
    snapshotVersion: snapshot.version,
    repositoryId: snapshot.repositoryId,
    target: Object.freeze({ ...snapshot.target }),
    indexFingerprint: snapshot.index.fingerprint,
    commits: Object.freeze(commits),
    finalIndex: overlay('index', index),
    excludedUnitIds: Object.freeze([...plan.excludedUnitIds]),
  });
}

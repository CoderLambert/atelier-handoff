/**
 * @file 校验多提交计划并生成用户确认前的逐组差异。
 * @implementation 从已编译的冻结提交树生成预览和摘要，在单元及实际提交差异上复核新增凭据。
 * @updated 2026-11-24T14:41:22+08:00
 */
import { formatPatch, structuredPatch } from 'diff';
import {
  commitCredentialBlocksLocal,
  multiCommitPreview,
  type MultiCommitCredential,
  type MultiCommitValidate,
} from '../../../shared/git-multi-commit.js';
import { AppError } from '../../../shared/types.js';
import { fingerprint } from '../../files.js';
import { compileCommitPlan, type GitCommitPlanCompiledState } from './commit-plan-compiler.js';
import type { GitCommitPlanFileState, GitCommitPlanSnapshot } from './commit-plan-snapshot.js';
import {
  credentialInHunks,
  credentialInWholeChange,
  credentialLines,
} from './commit-plan-privacy.js';
import { commitPlanText, commitPlanUnits } from './commit-plan-view.js';

const maxPreviewBytes = 2 * 1024 * 1024;
const same = (a: GitCommitPlanFileState, b: GitCommitPlanFileState) =>
  a.kind === 'missing'
    ? b.kind === 'missing'
    : a.kind === 'file' && b.kind === 'file' && a.mode === b.mode && a.digest === b.digest;

function assertCredentialCommitAllowed(finding: MultiCommitCredential | undefined) {
  if (commitCredentialBlocksLocal(finding))
    throw new AppError('GIT_PLAN_CREDENTIAL', '所选变更可能引入凭据。请在本地核对并修正。', 409);
}

export function validateCommitPlan(snapshot: GitCommitPlanSnapshot, input: MultiCommitValidate) {
  if (snapshot.version !== input.version)
    throw new AppError('GIT_PLAN_STALE', '工作树已变化，请重新生成提交计划。', 409);
  if (new Set(input.groups.map((group) => group.id)).size !== input.groups.length)
    throw new AppError('GIT_PLAN_INVALID', '提交分组标识重复。', 409);
  const selected = new Set(input.groups.flatMap((group) => group.unitIds));
  for (const unit of commitPlanUnits(snapshot))
    if (selected.has(unit.id)) assertCredentialCommitAllowed(unit.credential);
  const compiled = compileCommitPlan(snapshot, {
    groups: input.groups.map(({ title, body, unitIds }) => ({ title, body, unitIds })),
    excludedUnitIds: input.excludedUnitIds,
  });
  const base = new Map(snapshot.files.map((file) => [file.path, file.head]));
  let previous = new Map<string, GitCommitPlanCompiledState>();
  let bytes = 0;
  const groups = compiled.commits.map((commit, index) => {
    const next = new Map(commit.tree.files.map((item) => [item.path, item.state]));
    const paths = new Set([...previous.keys(), ...next.keys()]);
    const files = [...paths].sort().flatMap((path) => {
      const before = previous.get(path) ?? base.get(path) ?? { kind: 'missing' as const };
      const after = next.get(path) ?? base.get(path) ?? { kind: 'missing' as const };
      if (same(before, after)) return [];
      if (before.kind === 'unavailable' || after.kind === 'unavailable')
        throw new AppError('GIT_PLAN_UNSUPPORTED', '无法预览所选文件的完整内容。', 409);
      const oldText = commitPlanText(before);
      const newText = commitPlanText(after);
      const patch =
        oldText === undefined || newText === undefined
          ? undefined
          : structuredPatch(
              before.kind === 'missing' ? '/dev/null' : path,
              after.kind === 'missing' ? '/dev/null' : path,
              oldText,
              newText,
              '',
              '',
              { context: 3 },
            );
      const oldLines = credentialLines(oldText ?? '', path);
      const newLines = credentialLines(newText ?? '', path);
      assertCredentialCommitAllowed(
        patch
          ? credentialInHunks(patch.hunks, oldLines, newLines)
          : credentialInWholeChange(oldLines, newLines),
      );
      const modes =
        before.kind === 'file' && after.kind === 'file' && before.mode !== after.mode
          ? `old mode ${before.mode}\nnew mode ${after.mode}\n`
          : '';
      const text = modes + (patch ? formatPatch(patch) : '');
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > maxPreviewBytes)
        throw new AppError('GIT_PLAN_PREVIEW_LIMIT', '提交预览过大，请减少本次选择的改动。', 413);
      return [{ path, text, binary: patch === undefined }];
    });
    previous = next;
    const id = input.groups[index]?.id;
    if (!id) throw new AppError('GIT_PLAN_INVALID', '无法对应提交分组。', 409);
    return { id, files };
  });
  const digest = fingerprint(JSON.stringify(input));
  return { compiled, preview: multiCommitPreview.parse({ digest, groups }) };
}

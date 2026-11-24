/**
 * @file 将服务端 Git 快照投影成用户可核对的变更单元。
 * @implementation 将冻结文本的凭据发现映射到变更块，只输出命中类型和位置，供模型披露和本地预览分别裁决。
 * @updated 2026-11-24T14:41:22+08:00
 */
import { formatPatch, structuredPatch } from 'diff';
import { multiCommitUnit, type MultiCommitUnit } from '../../../shared/git-multi-commit.js';
import type { GitCommitPlanFileState, GitCommitPlanSnapshot } from './commit-plan-snapshot.js';
import {
  credentialInHunks,
  credentialInPath,
  credentialInWholeChange,
  credentialLines,
} from './commit-plan-privacy.js';

const maxDiff = 128 * 1024;
export const commitPlanText = (state: GitCommitPlanFileState): string | undefined =>
  state.kind === 'missing'
    ? ''
    : state.kind === 'file' && state.encoding === 'utf8'
      ? state.content
      : undefined;

export function commitPlanUnits(snapshot: GitCommitPlanSnapshot): MultiCommitUnit[] {
  const files = new Map(
    snapshot.files.map((file) => {
      const scans = new Map<GitCommitPlanFileState, ReturnType<typeof credentialLines>>();
      const scan = (state: GitCommitPlanFileState) => {
        const cached = scans.get(state);
        if (cached) return cached;
        const result = credentialLines(commitPlanText(state) ?? '', file.path);
        scans.set(state, result);
        return result;
      };
      return [file.id, { file, scan }] as const;
    }),
  );
  return snapshot.units.map((unit) => {
    const entry = files.get(unit.fileId);
    let credential = credentialInPath(unit.path);
    let diff: string | undefined;
    if (!credential && entry && unit.kind !== 'unsupported' && unit.reason !== 'rename') {
      const { file, scan } = entry;
      const before = unit.layer === 'staged' ? file.head : file.index;
      const after = unit.layer === 'staged' ? file.index : file.worktree;
      const beforeLines = scan(before);
      const afterLines = scan(after);
      if (unit.hunk) {
        credential = credentialInHunks([unit.hunk], beforeLines, afterLines);
        if (!credential)
          diff = formatPatch(
            {
              oldFileName: undefined,
              newFileName: undefined,
              oldHeader: undefined,
              newHeader: undefined,
              hunks: [unit.hunk],
            },
            { includeIndex: false, includeUnderline: false, includeFileHeaders: false },
          );
      } else {
        const oldText = commitPlanText(before);
        const newText = commitPlanText(after);
        const patch =
          oldText === undefined || newText === undefined
            ? undefined
            : structuredPatch(
                before.kind === 'missing' ? '/dev/null' : unit.path,
                after.kind === 'missing' ? '/dev/null' : unit.path,
                oldText,
                newText,
                undefined,
                undefined,
                { context: 3, maxEditLength: 4000 },
              );
        credential = patch
          ? credentialInHunks(patch.hunks, beforeLines, afterLines)
          : credentialInWholeChange(beforeLines, afterLines);
        if (!credential && patch?.hunks.length) diff = formatPatch(patch);
      }
    }
    const description = unit.hunk
      ? `@@ -${unit.hunk.oldStart},${unit.hunk.oldLines} +${unit.hunk.newStart},${unit.hunk.newLines} @@`
      : (unit.reason ?? unit.kind);
    return multiCommitUnit.parse({
      id: unit.id,
      path: unit.path,
      layer: unit.layer,
      kind: unit.kind,
      description,
      reason: unit.reason,
      dependsOn: unit.dependsOn,
      ...(credential ? { credential } : {}),
      ...(diff && Buffer.byteLength(diff, 'utf8') <= maxDiff ? { diff } : {}),
    });
  });
}

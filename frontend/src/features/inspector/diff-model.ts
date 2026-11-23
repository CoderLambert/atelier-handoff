/**
 * @file 文件差异补丁解析与行对齐数据模型。
 * @implementation 解析 unified diff 补丁文本并生成分块、计算统计数及双栏比对行结构。
 * @updated 2026-11-23T18:25:00+08:00
 */
import type { Permission } from '@shared/types';

export type PermissionDiff = Pick<
  Permission,
  'diff' | 'before' | 'after' | 'path' | 'kind' | 'version'
>;

export type DiffLine = {
  kind: 'added' | 'removed' | 'context';
  oldLine: number | null;
  newLine: number | null;
  text: string;
  noFinalNewline?: boolean;
};

export type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  oldSeen: number;
  newSeen: number;
  lines: DiffLine[];
};

export function parsePermissionPatch(patch: string) {
  const hunks: Hunk[] = [];
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let hunk: Hunk | undefined;
  let added = 0;
  let removed = 0;
  const complete = () =>
    !hunk || (hunk.oldSeen === hunk.oldCount && hunk.newSeen === hunk.newCount);
  for (const text of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(text);
    if (header) {
      if (!complete()) return null;
      hunk = {
        oldStart: Number(header[1]),
        oldCount: Number(header[2] ?? 1),
        newStart: Number(header[3]),
        newCount: Number(header[4] ?? 1),
        oldSeen: 0,
        newSeen: 0,
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (text === '\\ No newline at end of file') {
      const previous = hunk.lines.at(-1);
      if (!previous) return null;
      previous.noFinalNewline = true;
      continue;
    }
    const marker = text[0];
    if (marker !== ' ' && marker !== '+' && marker !== '-') return null;
    const kind = marker === '+' ? 'added' : marker === '-' ? 'removed' : 'context';
    const oldLine = kind === 'added' ? null : hunk.oldStart + hunk.oldSeen++;
    const newLine = kind === 'removed' ? null : hunk.newStart + hunk.newSeen++;
    if (hunk.oldSeen > hunk.oldCount || hunk.newSeen > hunk.newCount) return null;
    hunk.lines.push({ kind, oldLine, newLine, text: text.slice(1) });
    if (kind === 'added') added++;
    if (kind === 'removed') removed++;
  }
  return complete() ? { hunks, added, removed } : null;
}

export function splitRows(lines: DiffLine[]) {
  const rows: [DiffLine | undefined, DiffLine | undefined][] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++)
      rows.push([removed[index], added[index]]);
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === 'context') {
      flush();
      rows.push([line, line]);
    } else (line.kind === 'removed' ? removed : added).push(line);
  }
  flush();
  return rows;
}

export function lineRange(start: number, count: number): string {
  return count === 0 ? '—' : count === 1 ? String(start) : `${start}–${start + count - 1}`;
}

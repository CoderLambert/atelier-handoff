import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Permission } from '@shared/types';
import { preClass } from './shared';

export type PermissionDiff = Pick<
  Permission,
  'diff' | 'before' | 'after' | 'path' | 'kind' | 'version'
>;
type DiffLine = {
  kind: 'added' | 'removed' | 'context';
  oldLine: number | null;
  newLine: number | null;
  text: string;
  noFinalNewline?: boolean;
};
type Hunk = {
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

function splitRows(lines: DiffLine[]) {
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
const tones = {
  added: 'bg-emerald-500/10 text-emerald-900 dark:text-emerald-200',
  removed: 'bg-destructive/10 text-destructive',
  context: '',
};
const numberClass =
  'w-10 select-none border-r border-border/50 px-2 text-right align-top text-muted-foreground';
function LineContent({ line }: { line: DiffLine }) {
  const bom = line.text.startsWith('﻿');
  const crlf = line.text.endsWith('\r');
  const code = line.text.slice(bom ? 1 : 0, crlf ? -1 : undefined);
  return (
    <>
      <td
        className={`w-6 select-none px-1 text-center align-top ${tones[line.kind]}`}
        aria-label={line.kind === 'added' ? '新增' : line.kind === 'removed' ? '删除' : '上下文'}
      >
        {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
      </td>
      <td className={`min-w-56 whitespace-pre px-2 align-top ${tones[line.kind]}`}>
        <code>
          {bom ? (
            <span
              className="mr-1 rounded bg-muted px-1 text-[10px] text-muted-foreground"
              title="UTF-8 字节顺序标记"
            >
              BOM
            </span>
          ) : null}
          {code}
          {crlf ? (
            <span className="ml-1 text-muted-foreground" title="CRLF 换行">
              ␍
            </span>
          ) : null}
          {line.noFinalNewline ? (
            <span className="ml-3 rounded bg-muted px-1 text-[10px] text-muted-foreground">
              文件末尾无换行
            </span>
          ) : null}
        </code>
      </td>
    </>
  );
}
function SplitSide({ line, side }: { line?: DiffLine; side: 'old' | 'new' }) {
  if (!line) return <td colSpan={3} className="bg-muted/40" />;
  return (
    <>
      <td className={`${numberClass} ${tones[line.kind]}`}>
        {side === 'old' ? line.oldLine : line.newLine}
      </td>
      <LineContent line={line} />
    </>
  );
}
function lineRange(start: number, count: number) {
  return count === 0 ? '—' : count === 1 ? String(start) : `${start}–${start + count - 1}`;
}
function Snapshot({ title, text }: { title: string; text: string | null }) {
  if (text === null) return null;
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{title}</summary>
      <pre className={`${preClass} rounded-t-none border-0 border-t`}>{text || '（空文件）'}</pre>
    </details>
  );
}

export function DiffView({ preview }: { preview: PermissionDiff }) {
  const [split, setSplit] = useState(false);
  const patch = useMemo(() => parsePermissionPatch(preview.diff), [preview.diff]);
  if (!patch?.hunks.length && (preview.before ?? '') === (preview.after ?? '')) {
    return (
      <p className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
        {preview.before === null
          ? '将新建一个空文件。'
          : preview.after === null
            ? '将删除一个空文件。'
            : '文件内容没有变化。'}
      </p>
    );
  }
  const lineCount = patch?.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? 0;
  if (!patch?.hunks.length || lineCount > 2400) {
    const limit = preview.diff.split('\n').find((line) => line.startsWith('差异规模超过预览限制'));
    return (
      <section aria-label="完整差异内容" className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {limit || '无法逐行展示这份差异，请核对原始补丁或前后内容。'}
        </p>
        <Snapshot title="查看修改前内容" text={preview.before} />
        <Snapshot title="查看修改后内容" text={preview.after} />
        <Snapshot title="查看原始补丁" text={preview.diff} />
      </section>
    );
  }
  return (
    <section
      aria-label="文件差异"
      className="min-w-0 overflow-hidden rounded-xl border border-border"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
        <p className="flex items-center gap-3 font-mono text-xs">
          <span
            className="text-emerald-700 dark:text-emerald-300"
            aria-label={`新增 ${patch.added} 行`}
          >
            +{patch.added}
          </span>
          <span className="text-destructive" aria-label={`删除 ${patch.removed} 行`}>
            −{patch.removed}
          </span>
          <span className="text-muted-foreground">{patch.hunks.length} 处变更</span>
        </p>
        {preview.before !== null && preview.after !== null ? (
          <div role="group" aria-label="差异布局" className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={split ? 'ghost' : 'secondary'}
              aria-pressed={!split}
              onClick={() => setSplit(false)}
            >
              统一视图
            </Button>
            <Button
              type="button"
              size="sm"
              variant={split ? 'secondary' : 'ghost'}
              aria-pressed={split}
              onClick={() => setSplit(true)}
            >
              并排对照
            </Button>
          </div>
        ) : null}
      </div>
      <div
        role="region"
        aria-label="带行号的文件差异"
        tabIndex={0}
        className="max-h-[52vh] overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <table
          className={`w-full border-collapse font-mono text-xs leading-6 ${split ? 'min-w-[760px]' : ''}`}
        >
          <thead className="sticky top-0 bg-muted text-left text-[10px] text-muted-foreground">
            {split ? (
              <tr>
                <th colSpan={3} className="border-r border-border px-3 py-1">
                  修改前
                </th>
                <th colSpan={3} className="px-3 py-1">
                  修改后
                </th>
              </tr>
            ) : (
              <tr>
                <th className="px-2 py-1">原行</th>
                <th className="px-2 py-1">新行</th>
                <th>
                  <span className="sr-only">变更类型</span>
                </th>
                <th className="px-2 py-1">文件内容</th>
              </tr>
            )}
          </thead>
          {patch.hunks.map((hunk, hunkIndex) => (
            <tbody key={hunkIndex}>
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={split ? 6 : 4}
                  className="bg-primary/5 px-3 py-1 text-left font-normal text-muted-foreground"
                >
                  原 {lineRange(hunk.oldStart, hunk.oldCount)} · 新{' '}
                  {lineRange(hunk.newStart, hunk.newCount)}
                </th>
              </tr>
              {split
                ? splitRows(hunk.lines).map(([oldLine, newLine], index) => (
                    <tr key={index}>
                      <SplitSide line={oldLine} side="old" />
                      <SplitSide line={newLine} side="new" />
                    </tr>
                  ))
                : hunk.lines.map((line, index) => (
                    <tr key={index} className={tones[line.kind]}>
                      <td className={numberClass}>{line.oldLine}</td>
                      <td className={numberClass}>{line.newLine}</td>
                      <LineContent line={line} />
                    </tr>
                  ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

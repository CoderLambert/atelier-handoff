/**
 * @file 展示文件预览补丁、摘要和完整快照。
 * @implementation 在当前界面语言下渲染差异统计、布局选项和无法预览时的替代内容。
 * @updated 2026-11-22T22:58:24+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { preClass } from './shared';
import {
  lineRange,
  parsePermissionPatch,
  splitRows,
  type DiffLine,
  type Hunk,
  type PermissionDiff,
} from './diff-model';

export { parsePermissionPatch, type PermissionDiff } from './diff-model';

const tones = {
  added: 'bg-success-soft text-success',
  removed: 'bg-destructive-soft text-destructive',
  context: '',
};
const numberClass =
  'w-10 select-none border-r border-border/50 px-2 text-right align-top text-muted-foreground';
function LineContent({ line }: { line: DiffLine }) {
  const { t } = useUiTranslation('inspector');
  const bom = line.text.startsWith('﻿');
  const crlf = line.text.endsWith('\r');
  const code = line.text.slice(bom ? 1 : 0, crlf ? -1 : undefined);
  return (
    <>
      <td
        className={cn('w-6 select-none px-1 text-center align-top', tones[line.kind])}
        aria-label={
          line.kind === 'added'
            ? t('diff.added')
            : line.kind === 'removed'
              ? t('diff.removed')
              : t('diff.context')
        }
      >
        {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
      </td>
      <td className={cn('min-w-56 whitespace-pre px-2 align-top', tones[line.kind])}>
        <code>
          {bom ? (
            <span
              className="mr-1 rounded bg-muted px-1 text-[10px] text-muted-foreground"
              title={t('diff.bom')}
            >
              BOM
            </span>
          ) : null}
          {code}
          {crlf ? (
            <span className="ml-1 text-muted-foreground" title={t('diff.crlf')}>
              ␍
            </span>
          ) : null}
          {line.noFinalNewline ? (
            <span className="ml-3 rounded bg-muted px-1 text-[10px] text-muted-foreground">
              {t('diff.noFinalNewline')}
            </span>
          ) : null}
        </code>
      </td>
    </>
  );
}
function SplitSide({ line, side }: { line?: DiffLine; side: 'old' | 'new' }) {
  if (!line) return <td colSpan={3} className="bg-muted" />;
  return (
    <>
      <td className={cn(numberClass, tones[line.kind])}>
        {side === 'old' ? line.oldLine : line.newLine}
      </td>
      <LineContent line={line} />
    </>
  );
}

function Snapshot({ title, text }: { title: string; text: string | null }) {
  const { t } = useUiTranslation('inspector');
  if (text === null) return null;
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{title}</summary>
      <pre className={cn(preClass, 'rounded-t-none border-0 border-t')}>
        {text || t('common.emptyFile')}
      </pre>
    </details>
  );
}

export function DiffView({ preview }: { preview: PermissionDiff }) {
  const { t } = useUiTranslation('inspector');
  const [split, setSplit] = useState(false);
  const patch = useMemo(() => parsePermissionPatch(preview.diff), [preview.diff]);
  if (!patch?.hunks.length && (preview.before ?? '') === (preview.after ?? '')) {
    return (
      <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">
        {preview.before === null
          ? t('diff.createEmpty')
          : preview.after === null
            ? t('diff.deleteEmpty')
            : t('diff.unchanged')}
      </p>
    );
  }
  const lineCount = patch?.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? 0;
  if (!patch?.hunks.length || lineCount > 2400) {
    const limit = preview.diff.split('\n').find((line) => line.startsWith('差异规模超过预览限制'));
    return (
      <section aria-label={t('diff.fullContent')} className="flex min-w-0 flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {limit ? t('diff.limitExceeded') : t('diff.unrenderable')}
        </p>
        <Snapshot title={t('diff.beforeAction')} text={preview.before} />
        <Snapshot title={t('diff.afterAction')} text={preview.after} />
        <Snapshot title={t('diff.rawPatch')} text={preview.diff} />
      </section>
    );
  }
  return (
    <section
      aria-label={t('diff.fileDiff')}
      className="min-w-0 overflow-hidden rounded-xl border border-border"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted text-muted-foreground px-4 py-2.5">
        <p className="flex items-center gap-3 font-mono text-xs">
          <span className="text-success" aria-label={t('diff.addedLines', { count: patch.added })}>
            +{patch.added}
          </span>
          <span
            className="text-destructive"
            aria-label={t('diff.removedLines', { count: patch.removed })}
          >
            −{patch.removed}
          </span>
          <span className="text-muted-foreground">
            {t('diff.changes', { count: patch.hunks.length })}
          </span>
        </p>
        {preview.before !== null && preview.after !== null ? (
          <div role="group" aria-label={t('diff.layout')} className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={split ? 'ghost' : 'secondary'}
              aria-pressed={!split}
              onClick={() => setSplit(false)}
            >
              {t('diff.unified')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={split ? 'secondary' : 'ghost'}
              aria-pressed={split}
              onClick={() => setSplit(true)}
            >
              {t('diff.split')}
            </Button>
          </div>
        ) : null}
      </div>
      <div
        role="region"
        aria-label={t('diff.withLineNumbers')}
        tabIndex={0}
        className="max-h-[52vh] overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <table
          className={cn(
            'w-full border-collapse font-mono text-xs leading-6',
            split && 'min-w-[760px]',
          )}
        >
          <thead className="sticky top-0 bg-muted text-left text-[10px] text-muted-foreground">
            {split ? (
              <tr>
                <th colSpan={3} className="border-r border-border px-3 py-1">
                  {t('diff.before')}
                </th>
                <th colSpan={3} className="px-3 py-1">
                  {t('diff.after')}
                </th>
              </tr>
            ) : (
              <tr>
                <th className="px-2 py-1">{t('diff.oldLine')}</th>
                <th className="px-2 py-1">{t('diff.newLine')}</th>
                <th>
                  <span className="sr-only">{t('diff.changeType')}</span>
                </th>
                <th className="px-2 py-1">{t('diff.fileContent')}</th>
              </tr>
            )}
          </thead>
          {patch.hunks.map((hunk, hunkIndex) => (
            <tbody key={hunkIndex}>
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={split ? 6 : 4}
                  className="bg-muted px-3 py-1 text-left font-normal text-muted-foreground"
                >
                  {t('diff.lineRange', {
                    old: lineRange(hunk.oldStart, hunk.oldCount),
                    new: lineRange(hunk.newStart, hunk.newCount),
                  })}
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

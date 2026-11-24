/**
 * @file 展示 Git 文件、提交和差异，并提供 AI 多提交及未完成操作处理入口。
 * @implementation 按工作树和稳定提交选择数据，组织文件分组、差异和多提交计划；查询未完成操作，并提供恢复或放弃入口。
 * @updated 2026-11-24T15:59:19+08:00
 */
import { useRef, useState } from 'react';
import {
  GitBranch as BranchIcon,
  GitCommitHorizontal,
  GitPullRequest,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { translateError, useUiTranslation } from '@/i18n';
import { useGitFiles } from '@/use-query/git/use-git-files';
import { useGitFileDiff } from '@/use-query/git/use-git-file-diff';
import { useGitHistory } from '@/use-query/git/use-git-history';
import { useGitCommitDiff } from '@/use-query/git/use-git-commit-diff';
import type {
  GitDiff,
  GitDiffLayer,
  GitFile,
  GitOverview,
  GitWorktree,
} from '@shared/git-workbench';

import { GitPatch } from './git-diff';
import { GitFileLabel } from './git-file-label';
import { GitMultiCommitDialog } from './git-multi-commit-dialog';
import { useGitMultiCommitReview } from './hooks/use-git-multi-commit-review';
import { usePendingMultiCommits } from '@/use-query/git/use-pending-multi-commits';
import { useRecoverMultiCommit } from '@/use-query/git/use-recover-multi-commit';
import { useAbandonMultiCommit } from '@/use-query/git/use-abandon-multi-commit';

export function GitQueryFeedback({ error, retry }: { error?: unknown; retry: () => void }) {
  const { t } = useUiTranslation('git');
  return error ? (
    <div role="alert" className="git-feedback">
      <p>{translateError(error, t('board.failed'))}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        {t('board.retry')}
      </Button>
    </div>
  ) : (
    <p className="git-feedback" role="status">
      {t('board.loading')}
    </p>
  );
}

function DiffContent({
  data,
  path,
  error,
  retry,
}: {
  data?: GitDiff;
  path?: string;
  error?: unknown;
  retry: () => void;
}) {
  const { t } = useUiTranslation('git');
  if (!data || error) return <GitQueryFeedback error={error} retry={retry} />;
  if (data.text) return <GitPatch text={data.text} path={path} />;
  return <p className="git-feedback">{t(data.binary ? 'diff.binary' : 'diff.empty')}</p>;
}

const layers = ['staged', 'unstaged', 'untracked', 'conflict'] as const;
function layerFiles(file: GitFile, layer: GitDiffLayer) {
  if (file.kind !== 'tracked') return file.kind === layer;
  return layer === 'staged' ? file.index !== '.' : layer === 'unstaged' && file.worktree !== '.';
}

const fileBadges = {
  M: { message: 'file.modified', variant: 'info' },
  A: { message: 'file.added', variant: 'success' },
  D: { message: 'file.deleted', variant: 'destructive' },
  R: { message: 'file.renamed', variant: 'info' },
  C: { message: 'file.copied', variant: 'info' },
  T: { message: 'file.typeChanged', variant: 'warning' },
  U: { message: 'file.conflict', variant: 'warning' },
  '?': { message: 'file.untracked', variant: 'outline' },
} as const;
function knownStatus(code: string): code is keyof typeof fileBadges {
  return Object.hasOwn(fileBadges, code);
}

function fileChangeCode(file: GitFile, layer: GitDiffLayer) {
  return layer === 'conflict' ? 'U' : layer === 'staged' ? file.index : file.worktree;
}

export function GitFilesView({
  projectId,
  tree,
  busy,
  onBusy,
}: {
  projectId: string;
  tree: GitWorktree;
  busy: boolean;
  onBusy: (value: boolean) => void;
}) {
  const { t, locale } = useUiTranslation('git');
  const [selected, choose] = useState<{ path: string; layer: GitDiffLayer }>();
  const toolbar = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const available = tree.state === 'ready' && tree.scope !== 'external';
  const status = useGitFiles(projectId, available ? tree.id : undefined);
  const pending = usePendingMultiCommits(projectId, tree.id, available);
  const recovery = useRecoverMultiCommit(projectId, tree.id);
  const abandonment = useAbandonMultiCommit(projectId, tree.id);
  const review = useGitMultiCommitReview(projectId, tree.id, onBusy);
  const groups = layers.map((layer) => ({
    layer,
    files: status.data?.files.filter((file) => layerFiles(file, layer)) ?? [],
  }));
  const firstGroup = groups.find(({ files }) => files.length);
  const firstFile = firstGroup?.files[0];
  const current =
    selected &&
    groups.some(
      ({ layer, files }) =>
        layer === selected.layer && files.some(({ path }) => path === selected.path),
    )
      ? selected
      : firstGroup && firstFile
        ? { path: firstFile.path, layer: firstGroup.layer }
        : undefined;
  const patch = useGitFileDiff(projectId, available ? tree.id : undefined, current);
  if (!available) return <p className="git-feedback">{t('worktree.notReady')}</p>;
  if (!status.data || status.error)
    return <GitQueryFeedback error={status.error} retry={() => void status.refetch()} />;
  const fileCount = status.data.files.length;
  const staged = groups[0]?.files.length ?? 0;
  const number = new Intl.NumberFormat(locale);
  return (
    <div className="git-files-view">
      <div className="git-files-toolbar" ref={toolbar} tabIndex={-1}>
        <div className="git-files-counts">
          <span>{t('files.changed', { count: fileCount })}</span>
          {staged > 0 ? (
            <Badge variant="success">{t('commit.stagedCount', { count: staged })}</Badge>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          ref={trigger}
          title={t('commit.aiTooltip')}
          disabled={
            busy || pending.isPending || pending.isError || Boolean(pending.data?.items.length)
          }
          onClick={review.start}
        >
          <Sparkles data-icon="inline-start" aria-hidden="true" />
          {t('commit.ai')}
        </Button>
      </div>
      {pending.isError ? (
        <div className="git-feedback" role="alert">
          <p>{t('multi.pendingUnknown')}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void pending.refetch()}>
            {t('board.retry')}
          </Button>
        </div>
      ) : null}
      {pending.data?.items.map((item) => (
        <div key={item.operationId} className="git-feedback" role="alert">
          <p>{t('multi.pending')}</p>
          {item.state === 'recovery_required' ? <p>{t('multi.manualRecovery')}</p> : null}
          {recovery.error ? (
            <p>{translateError(recovery.error, t('errors.planRecovery'))}</p>
          ) : null}
          {abandonment.error ? (
            <p>{translateError(abandonment.error, t('errors.planRecovery'))}</p>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              busy ||
              recovery.isPending ||
              abandonment.isPending ||
              Boolean(recovery.error) ||
              item.state === 'aborting' ||
              item.state === 'recovery_required'
            }
            onClick={() => {
              onBusy(true);
              void recovery
                .mutateAsync(item.operationId)
                .catch(() => {})
                .finally(() => onBusy(false));
            }}
          >
            {t(recovery.isPending ? 'multi.recovering' : 'multi.recover')}
          </Button>
          {item.state === 'prepared' || item.state === 'aborting' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              title={t('multi.abandonHint')}
              disabled={busy || abandonment.isPending || Boolean(abandonment.error)}
              onClick={() => {
                onBusy(true);
                void abandonment
                  .mutateAsync(item.operationId)
                  .catch(() => {})
                  .finally(() => onBusy(false));
              }}
            >
              {t(abandonment.isPending ? 'multi.abandoning' : 'multi.abandon')}
            </Button>
          ) : null}
        </div>
      ))}
      {review.receipt ? (
        <p className="git-files-receipt" role="status" title={review.receipt.join('\n')}>
          <GitCommitHorizontal aria-hidden="true" />
          {t('multi.created', { count: review.receipt.length })}
        </p>
      ) : null}
      {fileCount ? (
        <div className="git-split git-files-split">
          <div className="git-list git-file-list">
            {groups.map(({ layer, files }) =>
              files.length ? (
                <section className="git-list-group" key={layer}>
                  <h3>
                    {t(`layer.${layer}`)}
                    <Badge variant={layer === 'staged' ? 'success' : 'secondary'}>
                      {number.format(files.length)}
                    </Badge>
                  </h3>
                  <ul>
                    {files.map((file) => {
                      const code = fileChangeCode(file, layer);
                      const badge = knownStatus(code) ? fileBadges[code] : fileBadges.M;
                      return (
                        <li key={file.path}>
                          <Button
                            className="git-list-button git-file-row justify-start"
                            variant="ghost"
                            size="sm"
                            aria-pressed={current?.path === file.path && current.layer === layer}
                            title={
                              file.previousPath ? file.previousPath + ' → ' + file.path : file.path
                            }
                            onClick={() => choose({ path: file.path, layer })}
                          >
                            <GitFileLabel path={file.path} />
                            <Badge variant={badge.variant} title={t(badge.message)}>
                              <span aria-hidden="true">{code}</span>
                              <span className="sr-only">{t(badge.message)}</span>
                            </Badge>
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null,
            )}
          </div>
          <section
            className="git-detail"
            aria-label={current ? t('diff.file', current) : t('diff.choose')}
          >
            {current ? (
              <>
                <div className="git-file-detail-header">
                  <h3>
                    <GitFileLabel path={current.path} />
                  </h3>
                  <Badge variant={current.layer === 'staged' ? 'success' : 'secondary'}>
                    {t(`layer.${current.layer}`)}
                  </Badge>
                </div>
                <DiffContent
                  key={current.layer + ':' + current.path}
                  path={current.path}
                  data={patch.data}
                  error={patch.error}
                  retry={() => void patch.refetch()}
                />
              </>
            ) : null}
          </section>
        </div>
      ) : (
        <div className="git-files-empty">
          <GitPullRequest aria-hidden="true" />
          <p>{t('files.clean')}</p>
        </div>
      )}
      <GitMultiCommitDialog
        review={review}
        restoreFocus={() => (trigger.current ?? toolbar.current)?.focus({ preventScroll: true })}
      />
    </div>
  );
}

export function GitHistoryView({
  projectId,
  overview,
  tree,
}: {
  projectId: string;
  overview: GitOverview;
  tree: GitWorktree;
}) {
  const { t, locale } = useUiTranslation('git');
  const [ref, selectRef] = useState<{ kind: 'local' | 'remote'; name: string }>();
  const [selection, selectCommit] = useState<{ anchor: string; oid: string }>();
  const branch =
    ref && overview.branches.find((item) => item.kind === ref.kind && item.name === ref.name);
  const anchor = branch?.oid ?? tree.head ?? undefined;
  const commit = selection?.anchor === anchor ? selection?.oid : undefined;
  const history = useGitHistory(projectId, anchor);
  const patch = useGitCommitDiff(projectId, commit);
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  return (
    <div className="git-split">
      <div className="git-list">
        <Button
          className="git-list-button justify-start"
          variant="ghost"
          size="sm"
          aria-pressed={!branch}
          onClick={() => {
            selectRef(undefined);
            selectCommit(undefined);
          }}
        >
          <BranchIcon data-icon="inline-start" aria-hidden="true" /> {t('branch.head')}
        </Button>
        {(['local', 'remote'] as const).map((kind) => {
          const list = overview.branches.filter((item) => item.kind === kind);
          if (!list.length) return null;
          return (
            <div className="git-list-group" key={kind}>
              <h3>{t(`branch.${kind}`)}</h3>
              <ul>
                {list.map((item) => {
                  const path = overview.worktrees.find(({ id }) => id === item.worktreeId)?.path;
                  return (
                    <li key={item.name}>
                      <Button
                        className="git-list-button git-branch-button items-stretch justify-start"
                        variant="ghost"
                        aria-pressed={item === branch}
                        title={item.name}
                        onClick={() => {
                          selectRef(item);
                          selectCommit(undefined);
                        }}
                      >
                        <span className="truncate">{item.name}</span>
                        {path && (
                          <small className="truncate" title={path}>
                            {t('branch.occupied', { path })}
                          </small>
                        )}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <div className="git-history">
        {anchor && (!history.data || (history.error && !history.isFetchNextPageError)) ? (
          <GitQueryFeedback error={history.error} retry={() => void history.refetch()} />
        ) : anchor && history.data?.pages.some(({ items }) => items.length) ? (
          <div className="git-history-list">
            <ul>
              {history.data.pages
                .flatMap(({ items }) => items)
                .map((item) => (
                  <li key={item.oid}>
                    <Button
                      className="git-list-button git-commit-button justify-start"
                      variant="ghost"
                      aria-pressed={item.oid === commit}
                      onClick={() => selectCommit({ anchor, oid: item.oid })}
                    >
                      <GitCommitHorizontal data-icon="inline-start" aria-hidden="true" />
                      <span className="git-commit-summary">
                        <span className="truncate" title={item.subject}>
                          {item.subject || t('history.untitled')}
                        </span>
                        <small className="truncate">
                          {item.author} · {dateFormat.format(new Date(item.date))}
                        </small>
                      </span>
                      <code>{item.oid.slice(0, 8)}</code>
                    </Button>
                  </li>
                ))}
            </ul>
            {history.isFetchNextPageError ? (
              <GitQueryFeedback error={history.error} retry={() => void history.fetchNextPage()} />
            ) : history.hasNextPage ? (
              <Button
                size="sm"
                variant="outline"
                disabled={history.isFetching}
                onClick={() => void history.fetchNextPage()}
              >
                {t('history.more')}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="git-feedback">{t('history.empty')}</p>
        )}
        {commit ? (
          <section className="git-detail" aria-label={t('diff.commit', { oid: commit })}>
            <h3 className="git-detail-title" title={commit}>
              <code>{commit.slice(0, 12)}</code>
            </h3>
            <DiffContent
              key={commit}
              data={patch.data}
              error={patch.error}
              retry={() => void patch.refetch()}
            />
          </section>
        ) : (
          <p className="git-history-hint">{t('history.choose')}</p>
        )}
      </div>
    </div>
  );
}

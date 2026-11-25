/**
 * @file 展示 Git 文件、提交、差异及操作入口。
 * @implementation 按工作树展示分组文件与差异，提供逐文件暂存、取消暂存及提交、丢弃和储藏操作。
 * @updated 2026-11-25T13:41:28+08:00
 */
import { useRef, useState } from 'react';
import {
  GitCommitHorizontal,
  GitPullRequest,
  Minus,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { translateError, useUiTranslation } from '@/i18n';
import { useGitFiles } from '@/use-query/git/use-git-files';
import { useUpdateGitFileIndex } from '@/use-query/git/use-update-git-file-index';
import { useGitFileDiff } from '@/use-query/git/use-git-file-diff';
import type {
  GitDiff,
  GitDiffLayer,
  GitFile,
  GitOverview,
  GitWorktree,
} from '@shared/git-workbench';
import type { GitRepoStatus } from '@shared/desktop-git';
import { getDesktopGitBridge } from '@/desktop-git';

import { GitPatch } from './git-diff';
import { GitFileLabel } from './git-file-label';
import { GitMultiCommitDialog } from './git-multi-commit-dialog';
import { useGitMultiCommitReview } from './hooks/use-git-multi-commit-review';
import { usePendingMultiCommits } from '@/use-query/git/use-pending-multi-commits';
import { useRecoverMultiCommit } from '@/use-query/git/use-recover-multi-commit';
import { useAbandonMultiCommit } from '@/use-query/git/use-abandon-multi-commit';
import { GitHistoryView as GitHistoryViewInternal } from './git-history/git-history-view';
import { GitCommitArea } from './git-commit-area';
import { GitStashPanel } from './git-stash-panel';

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
  repoStatus,
  onRefreshAll,
  showToast,
}: {
  projectId: string;
  tree: GitWorktree;
  busy: boolean;
  onBusy: (value: boolean) => void;
  repoStatus?: GitRepoStatus | null;
  onRefreshAll?: () => void;
  showToast?: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}) {
  const { t, locale } = useUiTranslation('git');
  const [selected, choose] = useState<{ path: string; layer: GitDiffLayer }>();
  const [discardTargets, setDiscardTargets] = useState<string[] | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const toolbar = useRef<HTMLDivElement>(null);
  const fileList = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const available = tree.state === 'ready' && tree.scope !== 'external';
  const status = useGitFiles(projectId, available ? tree.id : undefined);
  const fileIndex = useUpdateGitFileIndex(projectId, tree.id);
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
  const selectedGroup = selected && (
    groups.find(({ layer, files }) =>
      layer === selected.layer && files.some(({ path }) => path === selected.path),
    ) ?? groups.find(({ files }) => files.some(({ path }) => path === selected.path))
  );
  const current = selectedGroup && selected
    ? { path: selected.path, layer: selectedGroup.layer }
    : firstGroup && firstFile
      ? { path: firstFile.path, layer: firstGroup.layer }
      : undefined;
  const patch = useGitFileDiff(projectId, available ? tree.id : undefined, current);

  // 丢弃改动执行逻辑
  const handleDiscard = async () => {
    if (!discardTargets || !tree.path) return;
    const bridge = getDesktopGitBridge();
    if (!bridge) return;

    setDiscarding(true);
    try {
      const res = await bridge.discardFiles(tree.path, discardTargets);
      if (!res.success) {
        showToast?.('丢弃改动失败', 'error', res.stderr);
        return;
      }
      showToast?.(`已丢弃 ${discardTargets.length} 个文件的改动`, 'success');
      setDiscardTargets(null);
      void status.refetch();
      onRefreshAll?.();
    } catch (err) {
      showToast?.('丢弃改动异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setDiscarding(false);
    }
  };

  if (!available) return <p className="git-feedback">{t('worktree.notReady')}</p>;
  if (!status.data || status.error)
    return <GitQueryFeedback error={status.error} retry={() => void status.refetch()} />;

  const fileCount = status.data.files.length;
  const staged = groups[0]?.files.length ?? 0;
  const number = new Intl.NumberFormat(locale);
  const commitDisabled =
    busy || pending.isPending || pending.isError || Boolean(pending.data?.items.length);

  const fileActionsDisabled = commitDisabled || discarding || fileIndex.isPending;

  const conflictFiles = repoStatus?.conflictFiles ?? [];

  return (
    <div className="git-files-view">
      <div className="git-files-toolbar" ref={toolbar} tabIndex={-1}>
        <div className="git-files-counts">
          <span>{t('files.changed', { count: fileCount })}</span>
          {staged > 0 ? (
            <Badge variant="success">{t('commit.stagedCount', { count: staged })}</Badge>
          ) : null}
          {fileCount > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => setDiscardTargets(status.data?.files.map((f) => f.path) ?? [])}
            >
              <Trash2 className="w-3 h-3 mr-1" aria-hidden="true" />
              <span>{t('files.discardAll')}</span>
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={commitDisabled}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              review.startManual();
            }}
          >
            <GitCommitHorizontal data-icon="inline-start" aria-hidden="true" />
            {t('multi.manualHeading')}
          </Button>
          <Button
            type="button"
            size="sm"
            title={t('commit.aiTooltip')}
            disabled={commitDisabled}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              review.start();
            }}
          >
            <Sparkles data-icon="inline-start" aria-hidden="true" />
            {t('commit.ai')}
          </Button>
        </div>
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

      <div className="git-split git-files-split flex-1 min-h-0">
        {/* 左侧文件列表、提交区与轻量储藏区 */}
        <div className="git-list git-file-list flex flex-col min-h-0">
          <div
            ref={fileList}
            className="git-file-scroll"
            tabIndex={0}
            role="region"
            aria-label={t('files.list')}
          >
            {fileIndex.error ? (
              <p className="git-feedback" role="alert">
                {translateError(fileIndex.error, t('files.indexFailed'))}
              </p>
            ) : null}
            {/* 1. 冲突文件置顶 */}
            {conflictFiles.length > 0 && (
              <section className="git-list-group border-b border-destructive/20 pb-2 mb-2" key="conflicts-pinned">
                <h3 className="text-destructive font-semibold flex items-center justify-between">
                  <span>{t('files.conflicted')}</span>
                  <Badge variant="destructive">{number.format(conflictFiles.length)}</Badge>
                </h3>
                <ul>
                  {conflictFiles.map((cPath) => (
                    <li key={`conflict-${cPath}`}>
                      <Button
                        className="git-list-button git-file-row justify-start"
                        variant="ghost"
                        size="sm"
                        aria-pressed={current?.path === cPath}
                        onClick={() => choose({ path: cPath, layer: 'conflict' })}
                      >
                        <div className="flex items-center gap-1 justify-between w-full min-w-0">
                          <GitFileLabel path={cPath} />
                          <Badge variant="destructive" title={t('file.conflict')}>
                            <span aria-hidden="true">!</span>
                          </Badge>
                        </div>
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* 2. 各图层变动文件 */}
            {fileCount === 0 && conflictFiles.length === 0 ? (
              <div className="git-files-empty p-6">
                <GitPullRequest aria-hidden="true" />
                <p>{t('files.clean')}</p>
              </div>
            ) : (
              groups.map(({ layer, files }) =>
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
                        const indexLabel = t(
                          layer === 'staged' ? 'files.unstageFile' : 'files.stageFile',
                          { path: file.path },
                        );
                        const IndexIcon = layer === 'staged' ? Minus : Plus;
                        return (
                          <li key={file.path}>
                            <div className="flex items-center w-full group">
                              <Button
                                className="git-list-button git-file-row justify-start flex-1 min-w-0"
                                variant="ghost"
                                size="sm"
                                aria-pressed={current?.path === file.path && current.layer === layer}
                                title={
                                  file.previousPath
                                    ? file.previousPath + ' → ' + file.path
                                    : file.path
                                }
                                onClick={() => choose({ path: file.path, layer })}
                              >
                                <div className="flex items-center gap-1 justify-between w-full min-w-0">
                                  <GitFileLabel path={file.path} />
                                  <Badge variant={badge.variant} title={t(badge.message)}>
                                    <span aria-hidden="true">{code}</span>
                                    <span className="sr-only">{t(badge.message)}</span>
                                  </Badge>
                                </div>
                              </Button>
                              {layer !== 'conflict' && !file.path.endsWith('/') ? (
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  className="size-7 shrink-0"
                                  disabled={fileActionsDisabled}
                                  title={indexLabel}
                                  aria-label={indexLabel}
                                  onClick={() => {
                                    fileList.current?.focus({ preventScroll: true });
                                    choose({ path: file.path, layer });
                                    onBusy(true);
                                    void fileIndex.mutateAsync({ path: file.path, layer })
                                      .catch(() => {})
                                      .finally(() => onBusy(false));
                                  }}
                                >
                                  <IndexIcon aria-hidden="true" />
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost"
                                disabled={busy || discarding}
                                className="git-file-discard size-7 shrink-0 text-muted-foreground hover:text-destructive"
                                title={t('files.discardFile')}
                                aria-label={t('files.discardFile')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDiscardTargets([file.path]);
                                }}
                              >
                                <X className="w-3.5 h-3.5" aria-hidden="true" />
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null,
              )
            )}
          </div>

          {/* 3. 提交操作增强区 (Amend / Undo) */}
          <GitCommitArea
            cwd={tree.path}
            disabled={fileActionsDisabled}
            stagedCount={staged}
            onBusy={onBusy}
            onRefreshAll={async () => {
              await status.refetch();
              onRefreshAll?.();
            }}
            showToast={showToast}
          />

          {/* 4. 轻量储藏区 (Stash) */}
          <GitStashPanel
            cwd={tree.path}
            onRefreshAll={() => {
              void status.refetch();
              onRefreshAll?.();
            }}
            showToast={showToast}
          />
        </div>

        {/* 右侧差异详情 */}
        <section
          className="git-detail flex-1 min-w-0"
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
          ) : (
            <p className="git-feedback">{t('diff.choose')}</p>
          )}
        </section>
      </div>

      <GitMultiCommitDialog
        review={review}
        restoreFocus={() => (trigger.current ?? toolbar.current)?.focus({ preventScroll: true })}
      />

      {/* 丢弃改动二次确认对话框 */}
      {discardTargets && (
        <Dialog open onOpenChange={(o) => !discarding && !o && setDiscardTargets(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-destructive" aria-hidden="true" />
                <span>{t('files.discardConfirmTitle')}</span>
              </DialogTitle>
              <DialogDescription className="text-xs pt-2 leading-relaxed">
                {t('files.discardConfirmDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-32 overflow-y-auto my-2 p-2 rounded bg-muted/40 font-mono text-[11px] space-y-0.5">
              {discardTargets.map((p) => (
                <div key={p} className="truncate">
                  {p}
                </div>
              ))}
            </div>

            <DialogFooter className="mt-4 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={discarding}
                onClick={() => setDiscardTargets(null)}
              >
                {t('actions.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={discarding}
                onClick={() => void handleDiscard()}
              >
                {discarding ? t('files.discarding') : t('files.discard')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export function GitHistoryView({
  projectId,
  overview,
  tree,
  onRefreshAll,
  showToast,
  repoStatus,
}: {
  projectId: string;
  overview: GitOverview;
  tree: GitWorktree;
  onRefreshAll?: () => void;
  showToast?: (message: string, type?: 'success' | 'error', stderr?: string) => void;
  repoStatus?: GitRepoStatus | null;
}) {
  return (
    <GitHistoryViewInternal
      projectId={projectId}
      overview={overview}
      tree={tree}
      onRefreshAll={onRefreshAll}
      showToast={showToast}
      repoStatus={repoStatus}
      feedbackRenderer={(error, retry) => (
        <GitQueryFeedback error={error} retry={retry ?? (() => {})} />
      )}
    />
  );
}

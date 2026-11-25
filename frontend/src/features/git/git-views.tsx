/**
 * @file 展示 Git 文件、提交、差异及操作入口。
 * @implementation 按工作树和变更层展示文件与差异，提供布局切换、完整内容预览、本机定位及文件层级操作。
 * @updated 2026-11-25T16:53:09+08:00
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
import { useDiscardGitFiles } from '@/use-query/git/use-discard-git-files';
import { useGitFileDiff } from '@/use-query/git/use-git-file-diff';
import type {
  GitDiff,
  GitDiffLayer,
  GitFile,
  GitFileDiscardRequest,
  GitOverview,
  GitWorktree,
} from '@shared/git-workbench';
import type { GitRepoStatus } from '@shared/desktop-git';

import { GitDiffLayoutButton, GitPatch } from './git-diff';
import { GitFileActions } from './git-file-actions';
import type { GitOpenFile } from './git-open-file';
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
  split,
}: {
  data?: GitDiff;
  path?: string;
  error?: unknown;
  retry: () => void;
  split?: boolean;
}) {
  const { t } = useUiTranslation('git');
  if (!data || error) return <GitQueryFeedback error={error} retry={retry} />;
  if (data.text) return <GitPatch text={data.text} path={path} split={split} />;
  return <p className="git-feedback">{t(data.binary ? 'diff.binary' : 'diff.empty')}</p>;
}

const layers = ['staged', 'unstaged', 'untracked', 'conflict'] as const;

function FileDiff({
  projectId,
  treeId,
  path,
  layer,
  split,
}: {
  projectId: string;
  treeId: string;
  path: string;
  layer: GitDiffLayer;
  split: boolean;
}) {
  const patch = useGitFileDiff(projectId, treeId, { path, layer });
  return (
    <DiffContent
      path={path}
      data={patch.data}
      error={patch.error}
      split={split}
      retry={() => void patch.refetch()}
    />
  );
}

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
  onOpenFile,
  busy,
  onBusy,
  repoStatus,
  onRefreshAll,
  showToast,
}: {
  projectId: string;
  tree: GitWorktree;
  onOpenFile: (file: GitOpenFile) => void;
  busy: boolean;
  onBusy: (value: boolean) => void;
  repoStatus?: GitRepoStatus | null;
  onRefreshAll?: () => void;
  showToast?: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}) {
  const { t, locale } = useUiTranslation('git');
  const [selected, choose] = useState<{ path: string; layer: GitDiffLayer }>();
  const [comparisonPath, setComparisonPath] = useState<string>();
  const [split, setSplit] = useState(false);
  const [discardTargets, setDiscardTargets] = useState<GitFileDiscardRequest['targets']>();

  const toolbar = useRef<HTMLDivElement>(null);
  const fileList = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const discardTrigger = useRef<HTMLButtonElement>(null);
  const available = tree.state === 'ready' && tree.scope !== 'external';
  const status = useGitFiles(projectId, available ? tree.id : undefined);
  const fileIndex = useUpdateGitFileIndex(projectId, tree.id);
  const discard = useDiscardGitFiles(projectId, tree.id);
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
  const selectedGroup =
    selected &&
    (groups.find(
      ({ layer, files }) =>
        layer === selected.layer && files.some(({ path }) => path === selected.path),
    ) ??
      groups.find(({ files }) => files.some(({ path }) => path === selected.path)));
  const current =
    selectedGroup && selected
      ? { path: selected.path, layer: selectedGroup.layer }
      : firstGroup && firstFile
        ? { path: firstFile.path, layer: firstGroup.layer }
        : undefined;
  const hasBothLayers =
    current &&
    status.data?.files.some(
      (file) =>
        file.path === current.path && layerFiles(file, 'staged') && layerFiles(file, 'unstaged'),
    );
  const comparing = hasBothLayers && current?.path === comparisonPath;
  const activeFile = current && status.data?.files.find((file) =>
    file.path === current.path && layerFiles(file, current.layer),
  );
  const fullSource = current?.layer === 'staged' ? activeFile?.index === 'D' ? 'head' : 'index'
    : activeFile?.worktree === 'D' ? 'index' : 'worktree';
  const discarding = discard.isPending;
  const discardDescription = (layer: GitFileDiscardRequest['targets'][number]['layer']) =>
    t(layer === 'staged' && !tree.head ? 'files.discardFirstStaged' : `files.discardMode.${layer}`);

  const openDiscard = (button: HTMLButtonElement, targets: GitFileDiscardRequest['targets']) => {
    discardTrigger.current = button;
    discard.reset();
    setDiscardTargets(targets);
  };
  const handleDiscard = async () => {
    if (!discardTargets || discarding) return;
    onBusy(true);
    try {
      await discard.mutateAsync({ targets: discardTargets });
      showToast?.(t('files.discardDone'), 'success');
      setDiscardTargets(undefined);
    } catch {
      // The mutation retains the error for the confirmation dialog.
    } finally {
      onRefreshAll?.();
      onBusy(false);
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
  const allDiscardTargets = status.data.files.flatMap<GitFileDiscardRequest['targets'][number]>(
    ({ path, kind, index }) =>
      kind === 'conflict' || path.endsWith('/')
        ? []
        : [
            {
              path,
              layer: kind === 'untracked' ? 'untracked' : index !== '.' ? 'staged' : 'unstaged',
            },
          ],
  );

  const conflictFiles = repoStatus?.conflictFiles ?? [];

  return (
    <div className="git-files-view">
      <div className="git-files-toolbar" ref={toolbar} tabIndex={-1}>
        <div className="git-files-counts">
          <span>{t('files.changed', { count: fileCount })}</span>
          {staged > 0 ? (
            <Badge variant="success">{t('commit.stagedCount', { count: staged })}</Badge>
          ) : null}
          {allDiscardTargets.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
              disabled={fileActionsDisabled}
              onClick={(event) => openDiscard(event.currentTarget, allDiscardTargets)}
            >
              <Trash2 className="w-3 h-3 mr-1" aria-hidden="true" />
              <span>{t('files.discardMany')}</span>
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
                              {layer !== 'conflict' && !file.path.endsWith('/') ? (
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  disabled={fileActionsDisabled}
                                  className="git-file-discard size-7 shrink-0 text-muted-foreground hover:text-destructive"
                                  title={discardDescription(layer)}
                                  aria-label={t('files.discardPath', {
                                    path: file.path,
                                    action: discardDescription(layer),
                                  })}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openDiscard(e.currentTarget, [{ path: file.path, layer }]);
                                  }}
                                >
                                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                                </Button>
                              ) : null}
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
                {hasBothLayers ? (
                  <div className="git-diff-layer-controls">
                    {(['staged', 'unstaged'] as const).map((layer) => (
                      <Button
                        key={layer}
                        type="button"
                        size="xs"
                        variant={!comparing && current.layer === layer ? 'secondary' : 'ghost'}
                        aria-pressed={!comparing && current.layer === layer}
                        onClick={() => {
                          choose({ path: current.path, layer });
                          setComparisonPath(undefined);
                        }}
                      >
                        {t(`layer.${layer}`)}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      size="xs"
                      variant={comparing ? 'secondary' : 'ghost'}
                      aria-pressed={Boolean(comparing)}
                      onClick={() => setComparisonPath(comparing ? undefined : current.path)}
                    >
                      {t('diff.compareLayers')}
                    </Button>
                  </div>
                ) : (
                  <Badge variant={current.layer === 'staged' ? 'success' : 'secondary'}>
                    {t(`layer.${current.layer}`)}
                  </Badge>
                )}
                <div className="git-file-actions ms-auto">
                  <GitDiffLayoutButton split={split} onToggle={() => setSplit(!split)} />
                  {activeFile && !current.path.endsWith('/') && (
                    <GitFileActions key={current.path + ':' + fullSource} projectId={projectId}
                      worktreeId={tree.id}
                      target={{ kind: 'worktree', worktreeId: tree.id, source: fullSource, path: current.path }}
                      revealPath={activeFile.worktree === 'D' || activeFile.index === 'D' ? undefined : current.path}
                      onRevealFailed={showToast} onOpenFile={onOpenFile} />
                  )}
                </div>
              </div>
              {comparing ? (
                <div className="git-diff-comparison">
                  {(['staged', 'unstaged'] as const).map((layer) => (
                    <section
                      key={layer + ':' + current.path}
                      className="git-detail"
                      aria-label={t(`layer.${layer}`)}
                    >
                      <h4 className="git-diff-comparison-heading">{t(`layer.${layer}`)}</h4>
                      <FileDiff
                        projectId={projectId}
                        treeId={tree.id}
                        path={current.path}
                        layer={layer}
                        split={split}
                      />
                    </section>
                  ))}
                </div>
              ) : (
                <FileDiff
                  key={current.layer + ':' + current.path}
                  projectId={projectId}
                  treeId={tree.id}
                  split={split}
                  {...current}
                />
              )}
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
        <Dialog open onOpenChange={(o) => !discarding && !o && setDiscardTargets(undefined)}>
          <DialogContent
            className="max-w-md"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const button = discardTrigger.current;
              (button?.isConnected && !button.disabled ? button : toolbar.current)?.focus({
                preventScroll: true,
              });
            }}
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-destructive" aria-hidden="true" />
                <span>{t('files.discardConfirmTitle')}</span>
              </DialogTitle>
              <DialogDescription className="text-xs pt-2 leading-relaxed">
                {t('files.discardConfirmDesc')}
              </DialogDescription>
            </DialogHeader>

            <ul className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded bg-muted/40 p-2 text-xs">
              {discardTargets.map(({ path, layer }) => {
                const rename = status.data.files.find(
                  (file) => file.path === path && fileChangeCode(file, layer) === 'R',
                )?.previousPath;
                return (
                  <li key={layer + ':' + path}>
                    <div className="font-mono break-all">
                      {rename ? rename + ' → ' + path : path}
                    </div>
                    <div className="text-muted-foreground">{discardDescription(layer)}</div>
                  </li>
                );
              })}
            </ul>
            {discard.error ? (
              <p role="alert" className="text-sm text-destructive">
                {translateError(discard.error, t('files.discardFailed'))}
              </p>
            ) : null}

            <DialogFooter className="mt-4 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={discarding}
                onClick={() => setDiscardTargets(undefined)}
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
  onOpenFile,
  onRefreshAll,
  showToast,
  repoStatus,
}: {
  projectId: string;
  overview: GitOverview;
  tree: GitWorktree;
  onOpenFile: (file: GitOpenFile) => void;
  onRefreshAll?: () => void;
  showToast?: (message: string, type?: 'success' | 'error', stderr?: string) => void;
  repoStatus?: GitRepoStatus | null;
}) {
  return (
    <GitHistoryViewInternal
      projectId={projectId}
      overview={overview}
      tree={tree}
      onOpenFile={onOpenFile}
      onRefreshAll={onRefreshAll}
      showToast={showToast}
      repoStatus={repoStatus}
      feedbackRenderer={(error, retry) => (
        <GitQueryFeedback error={error} retry={retry ?? (() => {})} />
      )}
    />
  );
}

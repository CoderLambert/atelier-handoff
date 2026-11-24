/**
 * @file 展示工作树位置与可回收状态。
 * @implementation 按选中目录显示保留原因，提供逐路径缓存选择和已归档目录的回收重试。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { GitBranch, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { translateError, useUiTranslation } from '@/i18n';
import { useGitFiles } from '@/use-query/git/use-git-files';
import { useMarkRebuildable } from '@/use-query/git/use-mark-rebuildable';
import { useReclaimWorktree } from '@/use-query/git/use-reclaim-worktree';
import type { GitWorktree } from '@shared/git-workbench';
import { GitQueryFeedback } from './git-views';

export function GitWorktreesView({
  projectId,
  trees,
  tree,
  onSelect,
  onFiles,
  onBusy,
}: {
  projectId: string;
  trees: GitWorktree[];
  tree: GitWorktree;
  onSelect: (id: string) => void;
  onFiles: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useUiTranslation('git');
  const managed = tree.scope === 'managed';
  const canRead = tree.scope !== 'external' && tree.state === 'ready';
  const status = useGitFiles(projectId, managed && canRead ? tree.id : undefined);
  const cache = useMarkRebuildable(projectId, tree.id);
  const reclaim = useReclaimWorktree(projectId, tree.id);
  const retained = reclaim.data?.workspace.retained ?? tree.retained;
  const busy = cache.isPending || reclaim.isPending;
  const paths = [
    ...new Set([...(status.data?.ignored ?? []), ...(status.data?.rebuildable ?? [])]),
  ];

  async function retryReclaim() {
    onBusy(true);
    try {
      const requestId =
        reclaim.isError && reclaim.variables ? reclaim.variables : crypto.randomUUID();
      await reclaim.mutateAsync(requestId);
    } catch {
      // Keep the receipt ID for a retry if transport failed.
    } finally {
      onBusy(false);
    }
  }

  return (
    <div className="git-split">
      <ul className="git-list git-tree-list">
        {trees.map((item) => (
          <li key={item.id}>
            <Button
              className="git-list-button git-branch-button items-stretch justify-start"
              variant="ghost"
              aria-pressed={tree.id === item.id}
              disabled={busy}
              title={item.path}
              onClick={() => {
                reclaim.reset();
                cache.reset();
                onSelect(item.id);
              }}
            >
              <span className="truncate">{item.branch ?? t('worktree.detached')}</span>
              <small className="truncate">{t(`scope.${item.scope}`)}</small>
            </Button>
          </li>
        ))}
      </ul>
      <section className="git-tree-details" aria-label={t(`scope.${tree.scope}`)}>
        <div className="git-tree-heading">
          <GitBranch aria-hidden="true" />
          <h3>{tree.branch ?? t('worktree.detached')}</h3>
          <span className="git-tree-state">
            {t(`state.${tree.state}`)}
            {tree.locked && (
              <>
                <LockKeyhole aria-hidden="true" /> {t('worktree.locked')}
              </>
            )}
          </span>
        </div>
        <p className="git-path">{tree.retainedPath ?? tree.path}</p>
        {tree.head ? (
          <p className="git-hint">
            <code>{tree.head}</code>
          </p>
        ) : null}
        {retained ? (
          <p className="git-retained" role="status">
            {t(`retained.${retained}`)}
          </p>
        ) : null}
        {reclaim.data?.workspace.state === 'snapshotted' ? (
          <p role="status">{t('worktree.reclaimed')}</p>
        ) : null}
        {managed && canRead && !status.data ? (
          <GitQueryFeedback error={status.error} retry={() => void status.refetch()} />
        ) : null}
        {managed && canRead && paths.length ? (
          <div className="git-cache-list">
            <h4>{t('worktree.ignored')}</h4>
            <p className="git-hint">{t('worktree.ignoredDescription')}</p>
            {paths.map((path) => (
              <label className="git-cache-item" key={path}>
                <span title={path}>{path}</span>
                <Switch
                  aria-label={t('worktree.rebuildable', { path })}
                  checked={status.data?.rebuildable.includes(path) === true}
                  disabled={busy}
                  onCheckedChange={(rebuildable) => cache.mutate({ path, rebuildable })}
                />
              </label>
            ))}
          </div>
        ) : null}
        {reclaim.error || cache.error ? (
          <p role="alert" className="text-destructive">
            {translateError(reclaim.error ?? cache.error, t('errors.failed'))}
          </p>
        ) : null}
        <div className="git-tree-actions">
          {canRead ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onFiles}>
              {t('worktree.viewFiles')}
            </Button>
          ) : null}
          {tree.canReclaim && reclaim.data?.workspace.state !== 'snapshotted' ? (
            <Button size="sm" disabled={busy} onClick={() => void retryReclaim()}>
              {t(reclaim.isPending ? 'worktree.reclaiming' : 'worktree.reclaim')}
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

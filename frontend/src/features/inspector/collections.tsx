/**
 * @file 展示和筛选运行及交付物列表。
 * @implementation 按项目、会话和状态查询分页数据，展示运行模式并提供打开操作。
 * @updated 2026-11-20T14:44:21+08:00
 */
import { OptionsSelect } from '@/components/options-select';
import { useUiTranslation } from '@/i18n';
import { useMemo, useState, type FormEvent } from 'react';
import { Activity, ChevronRight, FileText, Folder, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import type { Project, Run } from '@shared/types';
import { useRuns } from '@/use-query/runs/use-runs';
import { useArtifacts } from '@/use-query/artifacts/use-artifacts';
import { runModeLabel } from '@/features/chat/run-mode';
import { ArtifactAction } from './artifact-action';
import {
  EmptyState,
  ErrorNotice,
  Loading,
  StatusBadge,
  fieldClass,
  formatDate,
  statusLabel,
  errorMessage,
} from './shared';
import { Input } from '@/components/ui/input';

export type CollectionsProps = {
  view: 'runs' | 'artifacts';
  projects: Project[];
  onOpenRun: (run: Run) => void;
  sessionId?: string;
};
type Filters = {
  projectId: string;
  sessionId: string;
  status: string;
  limit: number;
  offset: number;
};
const runStatuses = [
  'queued',
  'running',
  'awaiting_permission',
  'stopping',
  'completed',
  'stopped',
  'failed',
  'interrupted',
];

export function Collections(props: CollectionsProps) {
  return <CollectionView key={`${props.view}:${props.sessionId ?? 'workspace'}`} {...props} />;
}
function CollectionView({ view, projects, onOpenRun, sessionId }: CollectionsProps) {
  const { t, locale } = useUiTranslation('inspector');
  const [filters, setFilters] = useState<Filters>({
    projectId: '',
    sessionId: sessionId ?? '',
    status: '',
    limit: 20,
    offset: 0,
  });
  const [sessionInput, setSessionInput] = useState(sessionId ?? '');
  const runPage = useRuns(view === 'runs' ? filters : undefined);
  const artifactPage = useArtifacts(view === 'artifacts' ? filters : undefined);
  const page = view === 'runs' ? runPage : artifactPage;
  const resource = {
    data: page.data,
    loading: page.isFetching,
    error: page.error ? errorMessage(page.error) : undefined,
    reload: () => void page.refetch(),
  };
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const total = resource.data?.total ?? 0;
  const count = resource.data?.items.length ?? 0;
  const canPrevious = filters.offset > 0;
  const canNext = filters.offset + filters.limit < total;
  function updateFilter(changes: Partial<Filters>) {
    setFilters((previous) => ({ ...previous, ...changes, offset: 0 }));
  }
  function submitSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateFilter({ sessionId: sessionInput.trim() });
  }
  const filtered = Boolean(
    filters.projectId || (!sessionId && filters.sessionId) || filters.status,
  );
  function clear() {
    setSessionInput(sessionId ?? '');
    setFilters((previous) => ({
      ...previous,
      projectId: '',
      sessionId: sessionId ?? '',
      status: '',
      offset: 0,
    }));
  }
  return (
    <section
      aria-label={view === 'runs' ? t('collections.runs') : t('collections.artifactCollection')}
      className={cn(
        'mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4',
        sessionId ? 'sm:p-6' : 'sm:p-7 lg:p-10',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            {view === 'runs' ? (
              <Activity aria-hidden="true" className="size-4" />
            ) : (
              <Folder aria-hidden="true" className="size-4" />
            )}
            {sessionId ? t('collections.currentSession') : t('collections.workspace')}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {view === 'runs' ? t('collections.runs') : t('common.artifacts')}
          </h1>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            {view === 'runs'
              ? t('collections.runsDescription')
              : t('collections.artifactsDescription')}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={resource.reload}
          disabled={resource.loading}
        >
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          {t('common.refresh')}
        </Button>
      </div>
      <form
        onSubmit={submitSession}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card text-card-foreground p-4"
      >
        <label className="grid min-w-36 flex-1 gap-2 text-[11px] font-medium text-muted-foreground">
          {t('common.project')}
          <OptionsSelect
            aria-label={t('common.project')}
            value={filters.projectId}
            className="w-full"
            options={[
              { value: '', label: t('collections.allProjects') },
              ...projects.map((project) => ({
                value: project.id,
                label: project.name + (project.available ? '' : t('collections.unavailableSuffix')),
              })),
            ]}
            onValueChange={(projectId) => updateFilter({ projectId })}
          />
        </label>
        {view === 'runs' ? (
          <label className="grid min-w-32 flex-1 gap-2 text-[11px] font-medium text-muted-foreground">
            {t('collections.runStatus')}
            <OptionsSelect
              aria-label={t('collections.runStatus')}
              value={filters.status}
              className="w-full"
              options={[
                { value: '', label: t('collections.allStatuses') },
                ...runStatuses.map((status) => ({ value: status, label: statusLabel(status) })),
              ]}
              onValueChange={(status) => updateFilter({ status })}
            />
          </label>
        ) : null}
        {!sessionId ? (
          <label className="grid min-w-40 flex-[1.5] gap-2 text-[11px] font-medium text-muted-foreground">
            {t('collections.sessionId')}
            <Input
              className={fieldClass}
              value={sessionInput}
              onChange={(event) => setSessionInput(event.target.value)}
              placeholder={t('collections.allSessions')}
              spellCheck={false}
            />
          </label>
        ) : null}
        {!sessionId ? (
          <Button type="submit" variant="secondary">
            {t('collections.filter')}
          </Button>
        ) : null}
        {filtered ? (
          <Button type="button" variant="ghost" onClick={clear}>
            {t('collections.reset')}
          </Button>
        ) : null}
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <p role="status">
          {resource.data
            ? t(view === 'runs' ? 'collections.totalRuns' : 'collections.totalArtifacts', {
                count: total,
              })
            : t('collections.fetching')}
        </p>
        <label className="flex items-center gap-2">
          {t('collections.perPage')}
          <OptionsSelect
            aria-label={t('collections.pageSize')}
            value={String(filters.limit)}
            className="w-20"
            size="sm"
            options={[20, 50, 100].map((limit) => ({ value: String(limit), label: String(limit) }))}
            onValueChange={(limit) => updateFilter({ limit: Number(limit) })}
          />
        </label>
      </div>
      {resource.error ? <ErrorNotice message={resource.error} onRetry={resource.reload} /> : null}
      {resource.loading && !resource.data ? (
        <Loading>
          {t(view === 'runs' ? 'collections.loadingRuns' : 'collections.loadingArtifacts')}
        </Loading>
      ) : null}
      {resource.data && count === 0 ? (
        <EmptyState
          title={
            filters.offset > 0
              ? t('collections.emptyPage')
              : view === 'runs'
                ? t('collections.emptyRuns')
                : t('collections.emptyArtifacts')
          }
          icon={view === 'runs' ? Activity : FileText}
        >
          {filtered
            ? t('collections.adjustFilters')
            : view === 'runs'
              ? t('collections.runsHint')
              : t('collections.artifactsHint')}
        </EmptyState>
      ) : null}
      {view === 'runs' && runPage.data?.items.length ? (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
          {runPage.data.items.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onOpenRun(run)}
              className="group flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-4 sm:px-5"
            >
              <span className="hidden size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground sm:flex">
                <Activity aria-hidden="true" className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {run.prompt || t('common.run')}
                </span>
                <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                  <span>
                    {projectNames.get(run.projectId) ?? t('collections.projectUnavailable')}
                  </span>
                  <time dateTime={run.createdAt}>{formatDate(run.createdAt)}</time>
                  <span>{runModeLabel(run)}</span>
                </span>
              </span>
              <StatusBadge status={run.status} />
              <ChevronRight
                aria-hidden="true"
                className="hidden size-4 shrink-0 text-muted-foreground sm:block"
              />
            </button>
          ))}
        </div>
      ) : null}
      {view === 'artifacts' && artifactPage.data?.items.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {artifactPage.data.items.map((artifact) => (
            <article key={artifact.id} className="flex min-w-0 flex-col gap-2">
              <ArtifactAction artifact={artifact} />
              <p className="flex min-w-0 justify-between gap-3 px-1 text-[10px] text-muted-foreground">
                <span className="truncate">
                  {projectNames.get(artifact.projectId) ?? t('collections.projectUnavailable')}
                </span>
                <time dateTime={artifact.createdAt} className="shrink-0">
                  {formatDate(artifact.createdAt)}
                </time>
              </p>
            </article>
          ))}
        </div>
      ) : null}
      {resource.data && (canPrevious || canNext) ? (
        <nav
          aria-label={t('collections.pagination')}
          className="flex items-center justify-between gap-3 border-t border-border pt-5"
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canPrevious || resource.loading}
            onClick={() =>
              setFilters((previous) => ({
                ...previous,
                offset: Math.max(0, previous.offset - previous.limit),
              }))
            }
          >
            {t('common.previous')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {count ? `${filters.offset + 1}–${filters.offset + count}` : '0'} /{' '}
            {total.toLocaleString(locale)}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canNext || resource.loading}
            onClick={() =>
              setFilters((previous) => ({ ...previous, offset: previous.offset + previous.limit }))
            }
          >
            {t('common.next')}
          </Button>
        </nav>
      ) : null}
    </section>
  );
}

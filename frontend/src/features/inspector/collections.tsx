import { useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import type { Page } from '@/api/types';
import type { Artifact, Project, Run } from '@shared/types';
import { ArtifactAction } from './artifact-action';
import {
  EmptyState,
  ErrorNotice,
  Icon,
  Loading,
  StatusBadge,
  fieldClass,
  formatDate,
  statusLabel,
  useResource,
} from './shared';

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
  const [filters, setFilters] = useState<Filters>({
    projectId: '',
    sessionId: sessionId ?? '',
    status: '',
    limit: 20,
    offset: 0,
  });
  const [sessionInput, setSessionInput] = useState(sessionId ?? '');
  const query = new URLSearchParams({
    limit: String(filters.limit),
    offset: String(filters.offset),
  });
  if (filters.projectId) query.set('projectId', filters.projectId);
  if (filters.sessionId) query.set('sessionId', filters.sessionId);
  if (view === 'runs' && filters.status) query.set('status', filters.status);
  const path = `/api/${view}?${query}`;
  const runPage = useResource<Page<Run>>(view === 'runs' ? path : null, ['runs', filters]);
  const artifactPage = useResource<Page<Artifact>>(view === 'artifacts' ? path : null, [
    'artifacts',
    filters,
  ]);
  const resource = view === 'runs' ? runPage : artifactPage;
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
      aria-label={view === 'runs' ? '执行记录' : '交付物集合'}
      className={`mx-auto w-full max-w-6xl space-y-6 ${sessionId ? 'p-4 sm:p-6' : 'p-4 sm:p-7 lg:p-10'}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <Icon name={view === 'runs' ? 'activity' : 'folder'} className="size-3.5" />
            {sessionId ? '当前会话' : '工作空间'}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {view === 'runs' ? '执行记录' : '交付物'}
          </h1>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            {view === 'runs' ? '每一轮任务，都有迹可循。' : '在这里，找到每一次工作的成果。'}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={resource.reload}
          disabled={resource.loading}
        >
          <Icon name="refresh" />
          刷新
        </Button>
      </div>
      <form
        onSubmit={submitSession}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card/50 p-4"
      >
        <label className="grid min-w-36 flex-1 gap-2 text-[11px] font-medium text-muted-foreground">
          项目
          <select
            value={filters.projectId}
            className={fieldClass}
            onChange={(event) => updateFilter({ projectId: event.target.value })}
          >
            <option value="">全部项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {!project.available ? '（不可用）' : ''}
              </option>
            ))}
          </select>
        </label>
        {view === 'runs' ? (
          <label className="grid min-w-32 flex-1 gap-2 text-[11px] font-medium text-muted-foreground">
            运行状态
            <select
              value={filters.status}
              className={fieldClass}
              onChange={(event) => updateFilter({ status: event.target.value })}
            >
              <option value="">全部状态</option>
              {runStatuses.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {!sessionId ? (
          <label className="grid min-w-40 flex-[1.5] gap-2 text-[11px] font-medium text-muted-foreground">
            会话 ID
            <input
              className={fieldClass}
              value={sessionInput}
              onChange={(event) => setSessionInput(event.target.value)}
              placeholder="全部会话"
              spellCheck={false}
            />
          </label>
        ) : null}
        {!sessionId ? (
          <Button type="submit" variant="secondary">
            筛选
          </Button>
        ) : null}
        {filtered ? (
          <Button type="button" variant="ghost" onClick={clear}>
            重置
          </Button>
        ) : null}
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <p role="status">
          {resource.data
            ? `共 ${total.toLocaleString()} ${view === 'runs' ? '次运行' : '份交付物'}`
            : '正在获取记录'}
        </p>
        <label className="flex items-center gap-2">
          每页
          <select
            aria-label="每页记录数"
            value={filters.limit}
            className={`${fieldClass} h-8 w-20`}
            onChange={(event) => updateFilter({ limit: Number(event.target.value) })}
          >
            {[20, 50, 100].map((limit) => (
              <option key={limit} value={limit}>
                {limit}
              </option>
            ))}
          </select>
        </label>
      </div>
      {resource.error ? <ErrorNotice message={resource.error} onRetry={resource.reload} /> : null}
      {resource.loading && !resource.data ? (
        <Loading>正在加载{view === 'runs' ? '执行记录' : '交付物'}…</Loading>
      ) : null}
      {resource.data && count === 0 ? (
        <EmptyState
          title={
            filters.offset > 0
              ? '这一页已没有记录'
              : view === 'runs'
                ? '暂无运行记录'
                : '暂无交付物'
          }
          icon={view === 'runs' ? 'activity' : 'file'}
        >
          {filtered
            ? '试试调整筛选条件，或清除筛选查看全部记录。'
            : view === 'runs'
              ? '发送任务后，每轮运行会记录在这里。'
              : '运行生成的文件会收集在这里，方便预览与下载。'}
        </EmptyState>
      ) : null}
      {view === 'runs' && runPage.data?.items.length ? (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/40">
          {runPage.data.items.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onOpenRun(run)}
              className="group flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-4 sm:px-5"
            >
              <span className="hidden size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground sm:flex">
                <Icon name="activity" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{run.prompt || '运行'}</span>
                <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                  <span>{projectNames.get(run.projectId) ?? '项目不可用'}</span>
                  <time dateTime={run.createdAt}>{formatDate(run.createdAt)}</time>
                  <span>{run.mode === 'edit' ? '受控修改' : '只读'}</span>
                </span>
              </span>
              <StatusBadge status={run.status} />
              <Icon
                name="arrow"
                className="hidden size-3.5 shrink-0 text-muted-foreground sm:block"
              />
            </button>
          ))}
        </div>
      ) : null}
      {view === 'artifacts' && artifactPage.data?.items.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {artifactPage.data.items.map((artifact) => (
            <article key={artifact.id} className="min-w-0 space-y-2">
              <ArtifactAction artifact={artifact} />
              <p className="flex min-w-0 justify-between gap-3 px-1 text-[10px] text-muted-foreground">
                <span className="truncate">
                  {projectNames.get(artifact.projectId) ?? '项目不可用'}
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
          aria-label="集合分页"
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
            上一页
          </Button>
          <span className="text-xs text-muted-foreground">
            {count ? `${filters.offset + 1}–${filters.offset + count}` : '0'} /{' '}
            {total.toLocaleString()}
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
            下一页
          </Button>
        </nav>
      ) : null}
    </section>
  );
}

import { lazy, Suspense, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Snapshot } from '@/api/types';
import type { Run, RunEvent, ToolCall } from '@shared/types';
import {
  EmptyState,
  ErrorNotice,
  Icon,
  Loading,
  StatusBadge,
  actionLinkClass,
  eventNames,
  fieldClass,
  formatDate,
  formatDuration,
  preClass,
  useResource,
} from './shared';

const ToolOutputDialog = lazy(() => import('./tool-output-dialog'));
const EVENT_PAGE_SIZE = 50;
type TraceResponse = { events: RunEvent[]; eventCount: number };
export type RunTraceProps = { snapshot: Snapshot; runId?: string; onSelect: (id: string) => void };

export function RunTrace({ snapshot, runId, onSelect }: RunTraceProps) {
  const run =
    (runId ? snapshot.runs.find((item) => item.id === runId) : undefined) ?? snapshot.runs.at(-1);
  if (!run)
    return (
      <EmptyState title="还没有执行轨迹" icon="activity">
        发送任务后，这里会记录每轮运行的工具调用与事件。
      </EmptyState>
    );
  return <TraceDetail key={run.id} snapshot={snapshot} run={run} onSelect={onSelect} />;
}

function TraceDetail({
  snapshot,
  run,
  onSelect,
}: {
  snapshot: Snapshot;
  run: Run;
  onSelect: (id: string) => void;
}) {
  const [eventFilter, setEventFilter] = useState('');
  const [eventOffset, setEventOffset] = useState(0);
  const [outputTool, setOutputTool] = useState<ToolCall>();
  const trace = useResource<TraceResponse>(`/api/runs/${encodeURIComponent(run.id)}/trace`, [
    'trace',
    run.id,
  ]);
  const tools = useMemo(
    () => snapshot.tools.filter((tool) => tool.runId === run.id),
    [snapshot.tools, run.id],
  );
  const events = useMemo(() => {
    const records = new Map<number, RunEvent>();
    for (const event of trace.data?.events ?? []) records.set(event.id, event);
    for (const event of snapshot.events)
      if (event.runId === run.id && event.type !== 'message.delta') records.set(event.id, event);
    return [...records.values()].sort((a, b) => a.seq - b.seq).slice(-600);
  }, [trace.data, snapshot.events, run.id]);
  const filtered = eventFilter
    ? events.filter((event) => event.type.startsWith(`${eventFilter}.`))
    : events;
  const offset = Math.min(
    eventOffset,
    Math.max(0, Math.ceil(filtered.length / EVENT_PAGE_SIZE) - 1) * EVENT_PAGE_SIZE,
  );
  const visibleEvents = filtered.slice(offset, offset + EVENT_PAGE_SIZE);
  const result = events.findLast((event) => event.type === 'sdk.result')?.payload;
  const init = events.findLast((event) => event.type === 'sdk.initialized')?.payload;
  const firstText = events.find((event) => event.type === 'sdk.first_text')?.payload;
  const exit = events.findLast((event) => event.type === 'process.exited')?.payload;
  let gateway = '—';
  try {
    gateway = new URL(run.config.gateway).origin;
  } catch {
    /* Historic configuration may be invalid. */
  }
  const facts: [string, unknown][] = [
    ['模型', init?.model ?? run.config.model],
    ['网关', gateway],
    ['权限模式', run.mode === 'edit' ? '受控修改 · 逐次审批' : '只读'],
    ['SDK CLI', init?.version],
    ['开始时间', formatDate(run.startedAt)],
    ['结束时间', formatDate(run.endedAt)],
    [
      '总耗时',
      formatDuration(
        run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null,
      ),
    ],
    [
      '首段文本',
      formatDuration(typeof firstText?.elapsedMs === 'number' ? firstText.elapsedMs : null),
    ],
    [
      'API 耗时',
      formatDuration(typeof result?.apiDurationMs === 'number' ? result.apiDurationMs : null),
    ],
    ['SDK 轮次', result?.turns],
    ['HTTP 状态', result?.httpStatus],
    ['停止原因', result?.terminalReason || result?.stopReason || run.reason],
    ['进程退出', exit ? exit.signal || exit.code : null],
    ['已记录重试', events.filter((event) => event.type === 'sdk.api_retry').length],
    [
      '输入 / 输出 tokens',
      run.usage ? `${run.usage.inputTokens ?? '—'} / ${run.usage.outputTokens ?? '—'}` : null,
    ],
    ['运行 ID', run.id],
  ];
  const invoked = [
    ...new Set(
      events
        .filter((event) => event.type === 'skill.invoked')
        .map(
          ({ payload }) =>
            `${String(payload.name ?? 'Skill')} · v${String(payload.version ?? '—')}`,
        ),
    ),
  ];
  const discovered = events.findLast((event) => event.type === 'skills.discovered')?.payload;
  if (discovered)
    facts.push([
      '自动调用候选',
      `${String(discovered.count ?? 0)} 个可用 · ${String(discovered.missingCount ?? 0)} 个未加载`,
    ]);
  if (invoked.length) facts.push(['已自动调用 Skill', invoked.join(' / ')]);
  if (run.extensions?.length)
    facts.push([
      '本轮扩展',
      run.extensions
        .map(
          (item) =>
            `${item.name} · v${item.version}${item.tools?.length ? ` (${item.tools.join('、')})` : ''}`,
        )
        .join(' / '),
    ]);

  return (
    <section
      aria-label="运行执行轨迹"
      className="mx-auto w-full max-w-5xl space-y-7 p-4 sm:p-6 lg:p-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">执行轨迹</h2>
          <p className="mt-1 text-xs text-muted-foreground">本轮运行的调用、用量与诊断记录</p>
        </div>
        <a
          className={actionLinkClass}
          href={`/api/runs/${encodeURIComponent(run.id)}/diagnostics.json`}
          download
        >
          <Icon name="download" />
          下载诊断 JSON
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="inspector-trace-run" className="text-xs font-medium text-muted-foreground">
          运行
        </label>
        <select
          id="inspector-trace-run"
          value={run.id}
          onChange={(event) => onSelect(event.target.value)}
          className={`${fieldClass} min-w-0 flex-1 sm:max-w-xl`}
        >
          {snapshot.runs
            .slice()
            .reverse()
            .map((item) => (
              <option key={item.id} value={item.id}>
                {formatDate(item.createdAt)} · {item.prompt.slice(0, 60) || '运行'}
              </option>
            ))}
        </select>
        <StatusBadge status={run.status} />
      </div>
      {run.error ? <ErrorNotice message={run.error} /> : null}
      <dl className="grid grid-cols-1 gap-x-7 gap-y-4 rounded-xl border border-border bg-card/50 p-5 sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words text-xs leading-5 [overflow-wrap:anywhere]">
              {value === null || value === undefined || value === '' ? '—' : String(value)}
            </dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="inspector-tools-heading">
        <div className="mb-3 flex items-center gap-2">
          <h3 id="inspector-tools-heading" className="text-sm font-semibold">
            工具调用
          </h3>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {tools.length}
          </span>
        </div>
        {tools.length ? (
          <div className="space-y-2">
            {tools.map((tool) => (
              <ToolDetail key={tool.id} tool={tool} onOutput={() => setOutputTool(tool)} />
            ))}
          </div>
        ) : (
          <EmptyState title="本轮还没有调用工具" icon="activity" />
        )}
      </section>
      <section aria-labelledby="inspector-events-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 id="inspector-events-heading" className="text-sm font-semibold">
              运行事件
            </h3>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {events.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="inspector-event-type" className="sr-only">
              筛选事件类型
            </label>
            <select
              id="inspector-event-type"
              value={eventFilter}
              onChange={(event) => {
                setEventFilter(event.target.value);
                setEventOffset(0);
              }}
              className={`${fieldClass} w-36`}
            >
              <option value="">全部事件</option>
              {[
                ['run', '运行'],
                ['sdk', 'SDK'],
                ['tool', '工具'],
                ['permission', '审批'],
                ['mcp', 'MCP'],
                ['skill', 'Skill'],
                ['artifact', '交付物'],
                ['process', '进程'],
                ['usage', '用量'],
                ['plan', '计划'],
                ['extensions', '扩展'],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={trace.loading}
              onClick={trace.reload}
              aria-label="刷新执行轨迹"
            >
              <Icon name="refresh" />
            </Button>
          </div>
        </div>
        {trace.error ? <ErrorNotice message={trace.error} onRetry={trace.reload} /> : null}
        {trace.loading && !trace.data ? <Loading>正在获取完整执行轨迹…</Loading> : null}
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          {trace.data ? `共 ${trace.data.eventCount} 条原始事件。` : ''}已折叠文本增量，最多展示最近
          600 条诊断事件。
        </p>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {visibleEvents.length ? (
            visibleEvents.map((event) => (
              <details key={event.id} className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-xs hover:bg-muted/40">
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-primary/50"
                    />
                    <span className="truncate">{eventNames[event.type] ?? event.type}</span>
                  </span>
                  <time dateTime={event.at} className="shrink-0 text-[10px] text-muted-foreground">
                    {formatDate(event.at)}
                  </time>
                </summary>
                <div className="px-4 pb-4">
                  <pre className={preClass}>
                    {JSON.stringify(
                      {
                        type: event.type,
                        sequence: event.seq,
                        timestamp: event.at,
                        payload: event.payload,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </div>
              </details>
            ))
          ) : (
            <p className="p-5 text-sm text-muted-foreground">暂无符合条件的事件</p>
          )}
        </div>
        {filtered.length > EVENT_PAGE_SIZE ? (
          <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setEventOffset(Math.max(0, offset - EVENT_PAGE_SIZE))}
            >
              上一页
            </Button>
            <span>
              {offset + 1}–{Math.min(offset + EVENT_PAGE_SIZE, filtered.length)} / {filtered.length}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + EVENT_PAGE_SIZE >= filtered.length}
              onClick={() => setEventOffset(offset + EVENT_PAGE_SIZE)}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </section>
      {outputTool ? (
        <Suspense fallback={<Loading>正在打开完整输出…</Loading>}>
          <ToolOutputDialog
            tool={outputTool}
            onOpenChange={(open) => {
              if (!open) setOutputTool(undefined);
            }}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
function ToolDetail({ tool, onOutput }: { tool: ToolCall; onOutput: () => void }) {
  return (
    <details className="rounded-xl border border-border bg-card/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 hover:bg-muted/30">
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <Icon name="activity" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{tool.name.replace(/^mcp__atelier__/, '')}</span>
        </span>
        <StatusBadge status={tool.status} />
      </summary>
      <div className="space-y-3 border-t border-border p-4">
        <p className="break-all font-mono text-[10px] text-muted-foreground">
          {tool.id} · {formatDate(tool.startedAt)} ·{' '}
          {formatDuration(
            tool.endedAt ? Date.parse(tool.endedAt) - Date.parse(tool.startedAt) : null,
          )}
        </p>
        <div>
          <p className="mb-2 text-[11px] font-medium text-muted-foreground">参数</p>
          <pre className={preClass}>{tool.inputSummary || '（无参数）'}</pre>
        </div>
        {tool.output ? (
          <div>
            <p className="mb-2 text-[11px] font-medium text-muted-foreground">输出</p>
            <pre className={`${preClass} max-h-72`}>{tool.output}</pre>
          </div>
        ) : null}
        {tool.outputTruncated ? (
          <Button type="button" variant="outline" size="sm" onClick={onOutput}>
            查看完整输出
            {tool.outputLength != null ? ` · ${tool.outputLength.toLocaleString()} 字符` : ''}
          </Button>
        ) : null}
      </div>
    </details>
  );
}

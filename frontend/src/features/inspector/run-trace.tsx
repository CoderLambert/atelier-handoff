/**
 * @file 展示单次运行的执行轨迹。
 * @implementation 复用 run-trace-facts 单趟聚合事件摘要与自动审批集合，关联工具、输出、子任务与审批弹窗。
 * @updated 2026-11-27T22:25:00+08:00
 */
import { OptionsSelect } from '@/components/options-select';
import { useUiTranslation } from '@/i18n';
import { skillInheritanceSourceSchema } from '@shared/skill-inheritance';
import { useMemo, useState } from 'react';
import { Activity, Download, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useRunTrace } from '@/use-query/runs/use-run-trace';
import { runModeLabel } from '@/features/chat/run-mode';
import { SubagentProgress, groupRunWork } from './subagent-progress';
import { ToolDetail, ToolDetailBody, toolCallSummary } from './tool-detail';
import { RunInspectorDialogs } from './run-inspector-dialogs';
import { RequestTimings } from './request-timings';
import {
  mergeRunTraceEvents,
  scanRunTraceEvents,
  summarizeAutomaticApprovals,
} from './run-trace-facts';
import type { Snapshot } from '@/api/types';
import type { Run, RunEvent, ToolCall } from '@shared/types';
import {
  EmptyState,
  ErrorNotice,
  DetailField,
  Loading,
  StatusBadge,
  eventName,
  formatDate,
  formatDuration,
  errorMessage,
  preClass,
} from './shared';

const EVENT_PAGE_SIZE = 50;
export type RunTraceProps = { snapshot: Snapshot; runId?: string; onSelect: (id: string) => void };

const sourceLabels = {
  atelier: 'inheritance.sourceAtelier',
  workspace: 'inheritance.sourceWorkspace',
  host: 'inheritance.sourceHost',
} as const;

export function RunTrace({ snapshot, runId, onSelect }: RunTraceProps) {
  const { t } = useUiTranslation('inspector');
  const run =
    (runId ? snapshot.runs.find((item) => item.id === runId) : undefined) ?? snapshot.runs.at(-1);
  if (!run) {
    return (
      <EmptyState title={t('trace.empty')} icon={Activity}>
        {t('trace.emptyHint')}
      </EmptyState>
    );
  }
  return (
    <TraceDetail
      key={`${snapshot.session.id}:${run.id}`}
      snapshot={snapshot}
      run={run}
      onSelect={onSelect}
    />
  );
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
  const { t, locale } = useUiTranslation('inspector');
  const { t: skillT } = useUiTranslation('extensions');

  function skillSource(value: unknown) {
    const source = skillInheritanceSourceSchema.safeParse(value);
    return source.success ? ` · ${skillT(sourceLabels[source.data])}` : '';
  }

  const [eventFilter, setEventFilter] = useState('');
  const [eventOffset, setEventOffset] = useState(0);
  const [outputTool, setOutputTool] = useState<ToolCall>();
  const [permissionId, setPermissionId] = useState<string>();
  const trace = useRunTrace(run.id);

  const work = useMemo(
    () => groupRunWork(snapshot, run),
    [snapshot.session.id, snapshot.subagents, snapshot.tools, snapshot.permissions, run],
  );
  const permissions = useMemo(
    () =>
      snapshot.permissions.filter(
        (permission) => permission.runId === run.id && permission.sessionId === run.sessionId,
      ),
    [snapshot.permissions, run.id, run.sessionId],
  );
  const permission = permissions.find((item) => item.id === permissionId);
  const tools = work.tools;
  const toolById = useMemo(
    () =>
      new Map(
        [...work.tools, ...work.subagents.flatMap((item) => item.tools)].map((tool) => [
          tool.id,
          tool,
        ]),
      ),
    [work],
  );
  const automaticApprovals = useMemo(() => summarizeAutomaticApprovals(permissions), [permissions]);
  const events = useMemo(
    () => mergeRunTraceEvents(trace.data?.events, snapshot.events, run.id),
    [trace.data?.events, snapshot.events, run.id],
  );
  const eventSummary = useMemo(() => scanRunTraceEvents(events), [events]);

  const filtered = useMemo(
    () =>
      eventFilter ? events.filter((event) => event.type.startsWith(`${eventFilter}.`)) : events,
    [events, eventFilter],
  );
  const offset = Math.min(
    eventOffset,
    Math.max(0, Math.ceil(filtered.length / EVENT_PAGE_SIZE) - 1) * EVENT_PAGE_SIZE,
  );
  const visibleEvents = filtered.slice(offset, offset + EVENT_PAGE_SIZE);

  let gateway = '—';
  try {
    gateway = new URL(run.config.gateway).origin;
  } catch {
    /* Historic configuration may be invalid. */
  }

  const { stopSequence, result, init, firstText, exit, retryCount, invokedPayloads, discovered } =
    eventSummary;
  const facts: [string, unknown][] = [
    [t('trace.model'), init?.model ?? run.config.model],
    [t('trace.requestedEffort'), run.config.effort],
    [t('trace.gateway'), gateway],
    [t('trace.agent'), run.agent ? `${run.agent.name} · v${run.agent.version}` : null],
    [t('trace.capabilities'), run.agent?.capabilities.join('、')],
    [t('trace.permissionMode'), runModeLabel(run)],
    [t('trace.executor'), run.executor ?? 'project-v1'],
    [
      t('trace.searchLimit'),
      run.approvalMode === 'automatic'
        ? t('trace.searchLimitValue', {
            amount: (run.maxSearchChargeFen ?? 0).toLocaleString(locale),
          })
        : null,
    ],
    [t('trace.automaticApprovals'), automaticApprovals.count],
    ['SDK CLI', init?.version],
    [t('trace.started'), formatDate(run.startedAt)],
    [t('trace.ended'), formatDate(run.endedAt)],
    [
      t('trace.duration'),
      formatDuration(
        run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null,
      ),
    ],
    [
      t('trace.firstText'),
      formatDuration(typeof firstText?.elapsedMs === 'number' ? firstText.elapsedMs : null),
    ],
    [
      t('trace.apiDuration'),
      formatDuration(typeof result?.apiDurationMs === 'number' ? result.apiDurationMs : null),
    ],
    [t('trace.turns'), result?.turns],
    [t('trace.httpStatus'), result?.httpStatus],
    [t('trace.stopReason'), result?.terminalReason || result?.stopReason || run.reason],
    [t('trace.processExit'), exit ? exit.signal || exit.code : null],
    [t('trace.retries'), retryCount],
    [
      t('trace.tokens'),
      run.usage ? `${run.usage.inputTokens ?? '—'} / ${run.usage.outputTokens ?? '—'}` : null,
    ],
    ...(run.usage
      ? ([
          [
            t('trace.cacheTokens'),
            `${run.usage.cacheReadTokens ?? '—'} / ${run.usage.cacheCreationTokens ?? '—'}`,
          ],
          [
            t('trace.estimate'),
            run.usage.sdkEstimateUsd == null
              ? t('trace.unknown')
              : t('trace.estimateValue', {
                  amount: run.usage.sdkEstimateUsd.toLocaleString(locale, {
                    minimumFractionDigits: 6,
                    maximumFractionDigits: 6,
                  }),
                }),
          ],
        ] satisfies [string, unknown][])
      : []),
    [t('trace.runId'), run.id],
  ];

  const invoked = [
    ...new Set(
      invokedPayloads.map(
        (payload) =>
          `${String(payload.name ?? 'Skill')} · v${String(payload.version ?? '—')}${skillSource(payload.source ?? 'atelier')}`,
      ),
    ),
  ];
  if (discovered) {
    facts.push([
      t('trace.skillCandidates'),
      `${t('trace.skillAvailable', { count: typeof discovered.count === 'number' ? discovered.count : 0 })} · ${t('trace.skillMissing', { count: typeof discovered.missingCount === 'number' ? discovered.missingCount : 0 })}`,
    ]);
  }
  if (invoked.length) facts.push([t('trace.invokedSkills'), invoked.join(' / ')]);
  if (run.extensions?.length) {
    facts.push([
      t('trace.extensions'),
      run.extensions
        .map(
          (item) =>
            `${item.name} · v${item.version}${skillSource(item.source ?? (item.kind === 'skill' ? 'atelier' : undefined))}${item.tools?.length ? ` (${item.tools.join('、')})` : ''}`,
        )
        .join(' / '),
    ]);
  }

  return (
    <section
      aria-label={t('trace.ariaLabel')}
      className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-7 p-4 sm:p-6 lg:p-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">{t('trace.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('trace.description')}</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={`/api/runs/${encodeURIComponent(run.id)}/diagnostics.json`} download>
            <Download data-icon="inline-start" aria-hidden="true" />
            {t('trace.downloadDiagnostics')}
          </a>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="inspector-trace-run" className="text-xs font-medium text-muted-foreground">
          {t('common.run')}
        </label>
        <OptionsSelect
          id="inspector-trace-run"
          value={run.id}
          onValueChange={onSelect}
          className="flex-1 sm:max-w-xl"
          options={snapshot.runs
            .slice()
            .reverse()
            .map((item) => ({
              value: item.id,
              label: `${formatDate(item.createdAt)} · ${item.prompt.slice(0, 60) || t('common.run')}`,
            }))}
        />
        <StatusBadge status={run.status} />
      </div>
      {run.error ? <ErrorNotice message={errorMessage(new Error(run.error))} /> : null}
      <dl className="grid grid-cols-1 gap-x-7 gap-y-4 rounded-xl border border-border bg-card p-5 text-card-foreground sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([label, value]) => (
          <DetailField key={label} label={label}>
            {value == null ? null : String(value)}
          </DetailField>
        ))}
      </dl>
      {run.requestTiming && <RequestTimings timing={run.requestTiming} />}
      <section aria-labelledby="inspector-tools-heading">
        <div className="mb-3 flex items-center gap-2">
          <h3 id="inspector-tools-heading" className="text-sm font-semibold">
            {t('trace.tools')}
          </h3>
          <Badge variant="secondary">
            {tools.length + work.subagents.reduce((count, item) => count + item.tools.length, 0)}
          </Badge>
        </div>
        {work.subagents.length && tools.length ? (
          <h4 className="mb-2 text-xs font-medium text-muted-foreground">{t('trace.mainTools')}</h4>
        ) : null}
        {tools.length ? (
          <div className="flex min-w-0 flex-col gap-2">
            {tools.map((tool) => (
              <ToolDetail
                key={tool.id}
                tool={tool}
                automaticallyApproved={automaticApprovals.toolIds.has(tool.id)}
                onOutput={() => setOutputTool(tool)}
              />
            ))}
          </div>
        ) : work.subagents.length ? null : (
          <EmptyState title={t('trace.emptyTools')} icon={Activity} />
        )}
        <div className="mt-3">
          <SubagentProgress
            groups={work.subagents}
            run={run}
            onPermission={(item) => setPermissionId(item.id)}
            onToolOutput={setOutputTool}
          />
        </div>
      </section>
      {work.permissions.length ? (
        <section aria-label={t('trace.approvals')}>
          <h3 className="mb-2 text-sm font-semibold">{t('trace.approvals')}</h3>
          {work.permissions.map((item) => (
            <div
              className="flex items-center gap-3 border-b border-border py-2 text-xs"
              key={item.id}
            >
              <span
                className="min-w-0 flex-1 truncate"
                title={item.path ?? item.command ?? item.reason}
              >
                {item.path ?? item.command ?? item.reason}
              </span>
              {item.decisionSource === 'automatic' ? (
                <span>{t('common.approvalAutomatic')}</span>
              ) : null}
              <StatusBadge status={item.status} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPermissionId(item.id)}
              >
                {item.status === 'pending'
                  ? t('common.reviewAndApprove')
                  : t('common.reviewApproval')}
              </Button>
            </div>
          ))}
        </section>
      ) : null}
      <section aria-labelledby="inspector-events-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 id="inspector-events-heading" className="text-sm font-semibold">
              {t('trace.events')}
            </h3>
            <Badge variant="secondary">{events.length}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="inspector-event-type" className="sr-only">
              {t('trace.filterEventType')}
            </label>
            <OptionsSelect
              id="inspector-event-type"
              value={eventFilter}
              onValueChange={(value) => {
                setEventFilter(value);
                setEventOffset(0);
              }}
              className="w-36"
              options={[
                { value: '', label: t('trace.allEvents') },
                { value: 'run', label: t('common.run') },
                { value: 'sdk', label: t('trace.sdkCategory') },
                { value: 'harness', label: t('trace.progress') },
                { value: 'tool', label: t('trace.tool') },
                { value: 'subagent', label: t('trace.subtask') },
                { value: 'permission', label: t('trace.approval') },
                { value: 'mcp', label: t('trace.mcpCategory') },
                { value: 'skill', label: t('trace.skillCategory') },
                { value: 'artifact', label: t('common.artifacts') },
                { value: 'process', label: t('trace.process') },
                { value: 'usage', label: t('trace.usage') },
                { value: 'plan', label: t('trace.plan') },
                { value: 'extensions', label: t('trace.extension') },
              ]}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={trace.isFetching}
              onClick={() => void trace.refetch()}
              aria-label={t('trace.refresh')}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
            </Button>
          </div>
        </div>
        {trace.error ? (
          <ErrorNotice message={errorMessage(trace.error)} onRetry={() => void trace.refetch()} />
        ) : null}
        {trace.isFetching && !trace.data ? <Loading>{t('trace.loading')}</Loading> : null}
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          {trace.data ? t('trace.rawEvents', { count: trace.data.eventCount }) : ''}
          {t('trace.eventsHint')}
        </p>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {visibleEvents.length ? (
            visibleEvents.map((event) => {
              const tool =
                event.type.startsWith('tool.') && typeof event.payload.toolCallId === 'string'
                  ? toolById.get(event.payload.toolCallId)
                  : undefined;
              return (
                <TraceEvent
                  key={event.id}
                  event={event}
                  stopSequence={stopSequence}
                  tool={tool}
                  automaticallyApproved={tool ? automaticApprovals.toolIds.has(tool.id) : false}
                  onOutput={setOutputTool}
                />
              );
            })
          ) : (
            <p className="p-5 text-sm text-muted-foreground">{t('trace.noMatchingEvents')}</p>
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
              {t('common.previous')}
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
              {t('common.next')}
            </Button>
          </div>
        ) : null}
      </section>
      <RunInspectorDialogs
        source={snapshot}
        permission={permission}
        outputTool={outputTool}
        approvalFallback={<Loading>{t('common.openingApproval')}</Loading>}
        outputFallback={<Loading>{t('trace.openingOutput')}</Loading>}
        onCloseApproval={() => setPermissionId(undefined)}
        onCloseOutput={() => setOutputTool(undefined)}
      />
    </section>
  );
}

function TraceEvent({
  event,
  stopSequence,
  tool,
  automaticallyApproved,
  onOutput,
}: {
  event: RunEvent;
  stopSequence?: number;
  tool?: ToolCall;
  automaticallyApproved: boolean;
  onOutput: (tool: ToolCall) => void;
}) {
  const { t } = useUiTranslation('inspector');
  const [open, setOpen] = useState(false);
  const name = eventName(event.type);
  let label = name;
  if (event.type === 'sdk.api_retry') {
    if (
      event.payload.afterStopRequested === true ||
      (stopSequence !== undefined && event.seq > stopSequence)
    )
      label = `${name} · ${t('trace.retryAfterStop')}`;
    else if (stopSequence !== undefined) label = `${name} · ${t('trace.retryBeforeStop')}`;
  } else if (tool) label = `${name} · ${toolCallSummary(tool)}`;
  else if (event.type === 'permission.resolved' && event.payload.decisionSource === 'automatic')
    label = t('trace.approvedOperation');
  else if (event.type.startsWith('harness.') && typeof event.payload.summary === 'string')
    label = `${event.payload.kind === 'stalled' || event.type === 'harness.stalled' ? t('trace.stalled') : t('trace.progress')} · ${event.payload.summary}`;
  else if (event.type === 'sdk.initialized' && typeof event.payload.model === 'string')
    label = `${name} · ${event.payload.model}`;
  else if (event.type === 'skills.discovered' && typeof event.payload.count === 'number')
    label = `${name} · ${t('trace.skillAvailable', { count: event.payload.count })}`;
  else if (event.type === 'tool.blocked' && typeof event.payload.tool === 'string')
    label = `${name} · ${event.payload.tool}`;
  else if (event.type === 'run.finished' && typeof event.payload.reason === 'string')
    label = `${name} · ${event.payload.reason}`;
  return (
    <details
      className="group"
      data-event-type={event.type}
      onToggle={(e) => {
        if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
        <time dateTime={event.at} className="shrink-0 text-[10px] text-muted-foreground">
          {formatDate(event.at)}
        </time>
      </summary>
      {open ? (
        <div className="min-w-0 px-4 pb-4">
          {tool ? (
            <ToolDetailBody
              tool={tool}
              automaticallyApproved={automaticallyApproved}
              onOutput={() => onOutput(tool)}
            />
          ) : (
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
          )}
        </div>
      ) : null}
    </details>
  );
}

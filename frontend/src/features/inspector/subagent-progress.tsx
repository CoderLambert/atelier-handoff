/**
 * @file 按会话和轮次展示子代理任务、工具结果与审批入口。
 * @implementation 按分组展示状态、耗时及各分支最近的工具活动，提供单独停止、审批和工具详情入口。
 * @updated 2026-11-27T19:30:00+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useEffect, useState } from 'react';
import type { Subagent } from '@shared/subagents';
import { activeStatuses, type Permission, type Run, type ToolCall } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Activity, ChevronRight, LoaderCircle, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { StatusBadge, formatDate, formatDuration, permissionOperation } from './shared';
import { ToolDetail } from './tool-detail';
import { useStopSubagent } from '@/use-query/runs/use-stop-subagent';
import { errorMessage, ErrorNotice } from './shared';
import {
  groupRunWork,
  permissionSubagentSource,
  type SubagentSource,
  type SubagentWork,
} from './subagent-progress-model';

export {
  groupRunWork,
  permissionSubagentSource,
  type SubagentSource,
  type SubagentWork,
} from './subagent-progress-model';

function StopSubagentAction({ run, subagent }: { run: Run; subagent: Subagent }) {
  const { t } = useUiTranslation('inspector');
  const stop = useStopSubagent(run);
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={stop.isPending}
        onClick={() => stop.mutate(subagent.id)}
        aria-label={t('subagents.stopName', { name: subagent.title })}
      >
        {stop.isPending ? (
          <LoaderCircle
            data-icon="inline-start"
            aria-hidden="true"
            className="animate-spin motion-reduce:animate-none"
          />
        ) : (
          <Square data-icon="inline-start" aria-hidden="true" />
        )}
        {stop.isPending ? t('subagents.stopping') : t('subagents.stop')}
      </Button>
      {stop.error ? <ErrorNotice message={errorMessage(stop.error)} /> : null}
    </div>
  );
}

export function SubagentProgress({
  groups,
  run,
  onPermission,
  onToolOutput,
  onTrace,
}: {
  groups: SubagentWork[];
  run: Run;
  onPermission: (permission: Permission) => void;
  onToolOutput?: (tool: ToolCall) => void;
  onTrace?: () => void;
}) {
  const { t, locale } = useUiTranslation('inspector');
  const active = activeStatuses.includes(run.status);
  const ticking =
    active &&
    !run.endedAt &&
    groups.some(({ subagent }) => subagent?.status === 'running' && !subagent.endedAt);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  if (!groups.length) return null;
  return (
    <section aria-label={t('subagents.currentRun')} className="flex min-w-0 flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {t('subagents.total', { count: groups.length })}
      </p>
      {groups.map(({ id, subagent, tools, permissions }) => {
        const pending = permissions.filter((permission) => permission.status === 'pending');
        const end = subagent?.endedAt || run.endedAt;
        const elapsed =
          subagent && (end || (active && subagent.status === 'running'))
            ? (end ? Date.parse(end) : now) - Date.parse(subagent.startedAt)
            : null;
        const running = active && subagent?.status === 'running';
        const latestTool = running
          ? tools.reduce<ToolCall | undefined>((latest, tool) => {
              const at = tool.endedAt ?? tool.startedAt;
              return !latest || at > (latest.endedAt ?? latest.startedAt) ? tool : latest;
            }, undefined)
          : undefined;
        const lastActivity = latestTool?.endedAt ?? latestTool?.startedAt;
        return (
          <details
            key={id}
            className="group/subagent rounded-xl border border-border bg-card text-card-foreground"
            data-subagent-id={id}
          >
            <summary data-preserve-scroll className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground group-open/subagent:rotate-90"
              />
              <strong className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                {subagent?.title || t('subagents.name', { id })}
              </strong>
              {subagent ? (
                <StatusBadge status={subagent.status} />
              ) : (
                <span className="text-muted-foreground">{t('subagents.syncing')}</span>
              )}
              <span className="text-muted-foreground">
                {t('subagents.elapsed', { duration: formatDuration(elapsed) })}
              </span>
              {pending.length ? (
                <Badge variant="warning">{t('subagents.pending', { count: pending.length })}</Badge>
              ) : null}
              {running && latestTool && lastActivity ? (
                <time
                  className="basis-full pl-6 text-muted-foreground"
                  dateTime={lastActivity}
                  title={formatDate(lastActivity, locale)}
                  data-subagent-last-tool
                >
                  {t('subagents.lastToolActivity', {
                    name: latestTool.name.replace(/^mcp__atelier__/, ''),
                    elapsed: formatDuration(Math.max(0, now - Date.parse(lastActivity)), locale),
                  })}
                </time>
              ) : null}
            </summary>
            <div className="flex min-w-0 flex-col gap-3 border-t border-border p-4">
              <p className="text-xs text-muted-foreground">
                {subagent
                  ? subagent.kind === 'explore'
                    ? t('subagents.explore')
                    : t('subagents.execute')
                  : t('subagents.task')}{' '}
                {t('subagents.toolProgress', {
                  finished: tools.filter((tool) => tool.endedAt).length.toLocaleString(locale),
                  total: tools.length.toLocaleString(locale),
                })}
              </p>
              {active && run.status !== 'stopping' && subagent?.status === 'running' ? (
                <StopSubagentAction key={id} run={run} subagent={subagent} />
              ) : null}
              {subagent?.summary ? (
                <div>
                  <p className="mb-1 text-xs font-medium">{t('subagents.summary')}</p>
                  <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 [overflow-wrap:anywhere]">
                    {subagent.summary}
                  </p>
                </div>
              ) : null}
              {permissions.length ? (
                <section aria-label={t('subagents.approvals')} className="flex flex-col gap-2">
                  {pending.length ? (
                    <p className="text-xs font-medium">
                      {t('subagents.pendingOperations', { count: pending.length })}
                    </p>
                  ) : null}
                  {permissions.map((permission) => (
                    <div
                      key={permission.id}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3"
                      data-permission-id={permission.id}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                        <strong>
                          {permissionOperation(permission)}
                          {permission.decisionSource === 'automatic'
                            ? t('common.approvalAutomaticSuffix')
                            : ''}
                        </strong>
                        <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                          {permission.path || permission.command || permission.reason}
                        </p>
                        <StatusBadge status={permission.status} />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={permission.status === 'pending' ? 'default' : 'outline'}
                        onClick={() => onPermission(permission)}
                      >
                        {permission.status === 'pending'
                          ? t('common.reviewAndApprove')
                          : t('common.reviewApproval')}
                      </Button>
                    </div>
                  ))}
                </section>
              ) : null}
              {tools.length ? (
                tools.map((tool) => (
                  <ToolDetail
                    key={tool.id}
                    tool={tool}
                    automaticallyApproved={permissions.some(
                      (permission) =>
                        permission.toolCallId === tool.id &&
                        permission.decisionSource === 'automatic',
                    )}
                    onOutput={onToolOutput ? () => onToolOutput(tool) : undefined}
                  />
                ))
              ) : (
                <p className="text-xs text-muted-foreground">{t('subagents.noTools')}</p>
              )}
            </div>
          </details>
        );
      })}
      {onTrace ? (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onTrace}>
          <Activity data-icon="inline-start" aria-hidden="true" />
          {t('subagents.trace')}
        </Button>
      ) : null}
    </section>
  );
}

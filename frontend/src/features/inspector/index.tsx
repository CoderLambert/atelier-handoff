/**
 * @file 展示会话工作详情并提供审批入口。
 * @implementation 按概览、变更和事件组织会话快照，展示运行与审批状态，并按需加载审批和设置对话框。
 * @updated 2026-11-20T12:10:16+08:00
 */
import { lazy, Suspense, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import { activeStatuses, type Permission, type Run } from '@shared/types';
import { ArtifactAction } from './artifact-action';
import {
  EmptyState,
  ErrorNotice,
  Icon,
  Loading,
  SectionLabel,
  StatusBadge,
  errorMessage,
  eventNames,
  formatDate,
  isOperationPermission,
  permissionOperation,
  preClass,
} from './shared';

export { ArtifactAction } from './artifact-action';
export { Collections } from './collections';
export { RunTrace } from './run-trace';
export type { ArtifactActionProps } from './artifact-action';
export type { CollectionsProps } from './collections';
export type { RunTraceProps } from './run-trace';

const PermissionDialog = lazy(() => import('./permission-dialog'));
const SettingsDialog = lazy(() => import('./settings-dialog'));
export type SettingsProps = { open: boolean; onOpenChange: (open: boolean) => void };
export function Settings({ open, onOpenChange }: SettingsProps) {
  return open ? (
    <Suspense fallback={<Loading>正在打开设置…</Loading>}>
      <SettingsDialog onOpenChange={onOpenChange} />
    </Suspense>
  ) : null;
}
export type InspectorProps = {
  snapshot?: Snapshot;
  run?: Run;
  onTrace: (runId: string) => void;
  onSessionAction: (action: 'rename' | 'archive' | 'delete') => void;
};
export function Inspector(props: InspectorProps) {
  return <InspectorSession key={props.snapshot?.session.id ?? 'empty'} {...props} />;
}
type InspectorTab = 'overview' | 'changes' | 'events';
const inspectorTabs: { id: InspectorTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'changes', label: '变更' },
  { id: 'events', label: '事件' },
];
function InspectorSession({
  snapshot,
  run: selectedRun,
  onTrace,
  onSessionAction,
}: InspectorProps) {
  const id = useId();
  const [tab, setTab] = useState<InspectorTab>('overview');
  const [permissionId, setPermissionId] = useState<string>();
  const run = selectedRun ?? snapshot?.runs.at(-1);
  const pending =
    snapshot?.permissions.filter((permission) => permission.status === 'pending') ?? [];
  const permission = snapshot?.permissions.find((item) => item.id === permissionId);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-card/30">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
        <h2 className="text-xs font-semibold">工作详情</h2>
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" />
          本地工作空间
        </span>
      </div>
      <div
        role="tablist"
        aria-label="工作详情"
        className="grid shrink-0 grid-cols-3 border-b border-border px-3"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = inspectorTabs.findIndex((item) => item.id === tab);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? inspectorTabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + inspectorTabs.length) %
                  inspectorTabs.length;
          const option = inspectorTabs[next]!;
          setTab(option.id);
          event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-inspector-tab="${option.id}"]`)
            ?.focus();
        }}
      >
        {inspectorTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-inspector-tab={item.id}
            id={`${id}-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`${id}-panel`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            className={`relative flex h-11 items-center justify-center gap-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${tab === item.id ? 'font-semibold text-foreground after:absolute after:inset-x-5 after:bottom-0 after:h-0.5 after:rounded-t after:bg-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {item.label}
            {item.id === 'changes' && pending.length ? (
              <span className="flex size-4 items-center justify-center rounded-full bg-primary/10 text-[9px] text-primary">
                {pending.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${tab}`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {!snapshot ? (
          <EmptyState title="选择会话查看详情" icon="activity">
            项目、审批和运行记录都会显示在这里。
          </EmptyState>
        ) : tab === 'changes' ? (
          <div className="space-y-3 p-4">
            {snapshot.permissions.length ? (
              snapshot.permissions
                .slice()
                .reverse()
                .map((item) => (
                  <PermissionCard
                    key={item.id}
                    permission={item}
                    onOpen={() => setPermissionId(item.id)}
                  />
                ))
            ) : (
              <EmptyState title="暂无操作记录" icon="shield">
                文件修改与命令操作会在这里逐次确认。
              </EmptyState>
            )}
          </div>
        ) : tab === 'events' ? (
          <div className="p-4">
            {snapshot.events.filter((event) => event.type !== 'message.delta').length ? (
              <div className="space-y-1">
                {snapshot.events
                  .filter((event) => event.type !== 'message.delta')
                  .slice()
                  .reverse()
                  .map((event) => (
                    <details key={event.id} className="border-b border-border/60 py-2">
                      <summary className="flex cursor-pointer list-none items-start gap-3 py-1">
                        <span
                          className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/40"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px]">
                            {eventNames[event.type] ?? event.type}
                          </span>
                          <time
                            dateTime={event.at}
                            className="mt-1 block text-[10px] text-muted-foreground"
                          >
                            {formatDate(event.at)}
                          </time>
                        </span>
                      </summary>
                      <pre className={`${preClass} mt-2 max-h-64 p-3 text-[10px]`}>
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    </details>
                  ))}
              </div>
            ) : (
              <EmptyState title="暂无运行事件" icon="activity" />
            )}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {pending.length ? (
              <section className="space-y-3 p-4">
                <SectionLabel>待审批 · {pending.length}</SectionLabel>
                {pending.map((item) => (
                  <PermissionCard
                    key={item.id}
                    permission={item}
                    onOpen={() => setPermissionId(item.id)}
                  />
                ))}
              </section>
            ) : null}
            <section className="p-5">
              <SectionLabel>项目</SectionLabel>
              <p className="flex items-center gap-2 text-xs font-medium">
                <Icon name="folder" className="size-3.5 text-muted-foreground" />
                {snapshot.project.name}
              </p>
              <p className="mt-2 break-all font-mono text-[10px] leading-5 text-muted-foreground">
                {snapshot.project.path}
              </p>
              {snapshot.project.branch ? (
                <p className="mt-2 text-[10px] text-muted-foreground">
                  分支 · {snapshot.project.branch}
                </p>
              ) : null}
              {!snapshot.project.available ? (
                <p className="mt-2 text-xs text-destructive">项目目录当前不可用</p>
              ) : null}
            </section>
            <section className="p-5">
              <SectionLabel>当前运行</SectionLabel>
              {run ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge status={run.status} />
                    <span className="text-[10px] text-muted-foreground">
                      {run.mode === 'edit' ? '受控修改' : '只读'}
                    </span>
                  </div>
                  <p className="mt-3 line-clamp-3 text-xs leading-6 text-muted-foreground">
                    {run.prompt}
                  </p>
                  {run.error || run.reason ? (
                    <p className="mt-2 break-words text-xs leading-6 text-muted-foreground">
                      {run.error || run.reason}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onTrace(run.id)}
                    >
                      <Icon name="activity" className="size-3.5" />
                      查看执行轨迹
                    </Button>
                  </div>
                  <RunActions key={run.id} run={run} snapshot={snapshot} />
                </>
              ) : (
                <p className="text-xs text-muted-foreground">还没有运行，发送任务后开始记录。</p>
              )}
            </section>
            {run?.plan.length ? (
              <section className="p-5">
                <SectionLabel>
                  任务计划 · {run.plan.filter((step) => step.status === 'completed').length} /{' '}
                  {run.plan.length}
                </SectionLabel>
                <ol className="space-y-3">
                  {run.plan.map((step, index) => (
                    <li key={index} className="flex items-start gap-2.5 text-xs leading-6">
                      <span
                        aria-hidden="true"
                        className={`mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border ${step.status === 'completed' ? 'border-primary/20 bg-primary/10 text-primary' : step.status === 'in_progress' ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}
                      >
                        {step.status === 'completed' ? (
                          <Icon name="check" className="size-2.5" />
                        ) : (
                          <span className="text-[9px]">{index + 1}</span>
                        )}
                      </span>
                      <span className={step.status === 'completed' ? 'text-muted-foreground' : ''}>
                        <span className="sr-only">
                          {step.status === 'completed'
                            ? '已完成'
                            : step.status === 'in_progress'
                              ? '进行中'
                              : '待执行'}
                          ：
                        </span>
                        {step.content}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
            <section className="p-5">
              <SectionLabel>本轮用量</SectionLabel>
              {run?.usage ? (
                <>
                  <dl className="space-y-2.5 text-[11px]">
                    {[
                      ['模型', run.usage.model],
                      ['输入 tokens', run.usage.inputTokens],
                      ['输出 tokens', run.usage.outputTokens],
                      ['缓存读取', run.usage.cacheReadTokens],
                      ['缓存写入', run.usage.cacheCreationTokens],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="flex justify-between gap-4">
                        <dt className="shrink-0 text-muted-foreground">{label}</dt>
                        <dd className="min-w-0 break-all text-right font-mono">
                          {value == null
                            ? '暂无'
                            : typeof value === 'number'
                              ? value.toLocaleString()
                              : value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-4 text-[10px] leading-6 text-muted-foreground">
                    {run.usage.complete ? '本轮用量报告' : '本轮用量报告不完整'}
                    <br />
                    SDK 估算{' '}
                    {run.usage.sdkEstimateUsd != null && Number.isFinite(run.usage.sdkEstimateUsd)
                      ? `$${run.usage.sdkEstimateUsd.toFixed(6)} USD`
                      : '暂无'}{' '}
                    · 网关实际费用未知
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">用量暂无。</p>
              )}
            </section>
            {snapshot.artifacts.length ? (
              <section className="space-y-2 p-4">
                <SectionLabel>会话交付物 · {snapshot.artifacts.length}</SectionLabel>
                {snapshot.artifacts
                  .slice(-5)
                  .reverse()
                  .map((artifact) => (
                    <ArtifactAction key={artifact.id} artifact={artifact} />
                  ))}
                {snapshot.artifacts.length > 5 ? (
                  <p className="pt-1 text-[10px] text-muted-foreground">
                    最近 5 份 · 在交付物标签页查看全部
                  </p>
                ) : null}
              </section>
            ) : null}
            <section className="p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <SectionLabel>会话管理</SectionLabel>
                <StatusBadge status={snapshot.session.status} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onSessionAction('rename')}
                >
                  重命名
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onSessionAction('archive')}
                >
                  {snapshot.session.status === 'archived' ? '恢复' : '归档'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => onSessionAction('delete')}
                >
                  删除
                </Button>
              </div>
            </section>
          </div>
        )}
      </div>
      {permission ? (
        <Suspense fallback={<Loading>正在打开审批…</Loading>}>
          <PermissionDialog
            key={permission.id}
            permission={permission}
            onOpenChange={(open) => {
              if (!open) setPermissionId(undefined);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
function PermissionCard({ permission, onOpen }: { permission: Permission; onOpen: () => void }) {
  const pending = permission.status === 'pending';
  return (
    <article
      className={`rounded-xl border p-3.5 ${pending ? 'border-amber-500/25 bg-amber-500/5' : 'border-border bg-card/50'}`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-medium text-muted-foreground">
          {permissionOperation(permission)}
        </span>
        <StatusBadge status={permission.status} />
      </div>
      <p className="line-clamp-2 break-all font-mono text-[11px] leading-5">
        {permission.path || permission.command || permission.reason}
      </p>
      <button
        type="button"
        onClick={onOpen}
        className="mt-3 flex items-center gap-1 rounded text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {pending
          ? '查看详情与审批'
          : isOperationPermission(permission)
            ? '查看操作记录'
            : '查看文件差异'}
        <Icon name="arrow" className="size-3" />
      </button>
    </article>
  );
}
function RunActions({ run, snapshot }: { run: Run; snapshot: Snapshot }) {
  const retryKey = useRef<string | null>(null);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (action: 'stop' | 'retry') => {
      if (action === 'retry' && !retryKey.current) retryKey.current = crypto.randomUUID();
      return api<{ run: Run }>(`/api/runs/${encodeURIComponent(run.id)}/${action}`, {
        method: 'POST',
        body: action === 'retry' ? { idempotencyKey: retryKey.current } : {},
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['snapshot', run.sessionId] });
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
      void client.invalidateQueries({ queryKey: ['runs'] });
      void client.invalidateQueries({ queryKey: ['trace', run.id] });
    },
  });
  const active = activeStatuses.includes(run.status);
  const canRetry = ['failed', 'stopped', 'interrupted'].includes(run.status);
  if (!active && !canRetry) return null;
  return (
    <div className="mt-3 space-y-3">
      {active ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={run.status === 'stopping' || mutation.isPending || mutation.isSuccess}
          onClick={() => mutation.mutate('stop')}
        >
          {run.status === 'stopping' || mutation.isSuccess
            ? '正在停止…'
            : mutation.isPending
              ? '正在请求…'
              : '停止运行'}
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            mutation.isPending ||
            mutation.isSuccess ||
            snapshot.session.status === 'archived' ||
            snapshot.runs.some((item) => activeStatuses.includes(item.status))
          }
          onClick={() => mutation.mutate('retry')}
        >
          {mutation.isPending ? '正在续接…' : mutation.isSuccess ? '已发起只读续接' : '只读续接'}
        </Button>
      )}
      {mutation.error ? <ErrorNotice message={errorMessage(mutation.error)} /> : null}
    </div>
  );
}

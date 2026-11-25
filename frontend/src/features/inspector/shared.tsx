/**
 * @file 提供工作详情的通用展示与格式化。
 * @implementation 翻译运行和审批状态，组合语义徽章、字段及反馈组件，并格式化操作和时间。
 * @updated 2026-11-23T18:25:00+08:00
 */
import { useUiTranslation, getTranslator, getUiLocale, translateError } from '@/i18n';
import type { ReactNode } from 'react';
import { CircleAlert, FileText, LoaderCircle, type LucideIcon } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import type { Permission } from '@shared/types';
import { formatBytes, formatDate, formatDuration } from '@/utils/format';

export { formatBytes, formatDate, formatDuration } from '@/utils/format';

export const fieldClass =
  'h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';
export const preClass =
  'max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted p-4 font-mono text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere] [tab-size:2]';

export function isOperationPermission(permission: Permission) {
  return ['command', 'mcp', 'browser'].includes(permission.kind);
}

export function permissionOperation(permission: Permission) {
  const t = getTranslator('inspector');
  if (permission.kind === 'browser') return t('permission.browser');
  if (permission.kind === 'command') return t('permission.command');
  if (permission.kind === 'mcp') return t('permission.mcp');
  if (permission.kind === 'delete') return t('permission.delete');
  if (permission.kind === 'write')
    return permission.before === null ? t('permission.create') : t('permission.overwrite');
  return t('permission.modify');
}

export function errorMessage(error: unknown): string {
  const t = getTranslator('inspector');
  return translateError(error, t('common.requestFailed'));
}

function translatedStatuses() {
  const t = getTranslator('inspector');
  return {
    queued: t('status.queued'),
    running: t('status.running'),
    background: t('status.background'),
    unknown: t('status.resultUnknown'),
    awaiting_permission: t('status.awaitingPermission'),
    stopping: t('status.stopping'),
    completed: t('status.completed'),
    stopped: t('status.stopped'),
    failed: t('status.failed'),
    interrupted: t('status.interrupted'),
    pending: t('status.pending'),
    allowed: t('status.allowed'),
    denied: t('status.denied'),
    expired: t('status.expired'),
    canceled: t('status.canceled'),
    succeeded: t('status.succeeded'),
    active: t('status.active'),
    archived: t('status.archived'),
    available: t('status.available'),
    unavailable: t('common.unavailable'),
  } satisfies Record<string, string>;
}
export function statusLabel(status: string) {
  const statuses: Record<string, string> = translatedStatuses();
  return statuses[status] ?? status;
}
export function statusVariant(status: string): NonNullable<BadgeProps['variant']> {
  switch (status) {
    case 'failed':
    case 'denied':
    case 'interrupted':
    case 'unavailable':
      return 'destructive';
    case 'pending':
    case 'awaiting_permission':
    case 'stopping':
    case 'unknown':
    case 'expired':
      return 'warning';
    case 'completed':
    case 'succeeded':
    case 'allowed':
    case 'available':
    case 'active':
      return 'success';
    case 'running':
    case 'background':
    case 'queued':
      return 'info';
    default:
      return 'secondary';
  }
}

export function StatusBadge({ status }: { status: string }) {
  useUiTranslation('inspector');
  return (
    <Badge variant={statusVariant(status)} data-status={status}>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      {statusLabel(status)}
    </Badge>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useUiTranslation('inspector');
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive bg-destructive-soft p-3 text-sm text-destructive"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p className="min-w-0 break-words [overflow-wrap:anywhere]">{message}</p>
      </div>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      ) : null}
    </div>
  );
}
export function Loading({ children }: { children?: ReactNode }) {
  const { t } = useUiTranslation('inspector');
  return (
    <p role="status" className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
      <LoaderCircle
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
      />
      <span className="min-w-0 break-words">{children ?? t('common.loading')}</span>
    </p>
  );
}
export function EmptyState({
  title,
  children,
  icon: Icon = FileText,
}: {
  title: string;
  children?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center px-4 py-12 text-center">
      <span className="mb-4 flex size-11 items-center justify-center rounded-xl border border-border bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? (
        <p className="mt-2 max-w-sm text-xs leading-6 text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}
export function DetailField({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid min-w-0 gap-1', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-xs leading-5 [overflow-wrap:anywhere]">
        {children === null || children === undefined || children === '' ? '—' : children}
      </dd>
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-3 text-[11px] font-semibold tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

export function eventName(type: string) {
  const t = getTranslator('inspector');
  const names: Record<string, string> = {
    'run.created': t('event.createRun'),
    'run.status_changed': t('event.runStatus'),
    'run.finished': t('event.runFinished'),
    'process.spawned': t('event.processSpawned'),
    'process.exited': t('event.processExited'),
    'sdk.initialized': t('event.sdkInitialized'),
    'sdk.first_text': t('event.firstText'),
    'sdk.api_retry': t('event.apiRetry'),
    'sdk.error': t('event.sdkError'),
    'sdk.result': t('event.sdkResult'),
    'sdk.notice': t('event.sdkNotice'),
    'sdk.context_restarted': t('event.contextRestarted'),
    'tool.announced': t('event.toolAnnounced'),
    'tool.started': t('event.toolStarted'),
    'tool.finished': t('event.toolFinished'),
    'tool.blocked': t('event.toolBlocked'),
    'harness.progress': t('trace.progress'),
    'harness.stalled': t('trace.stalled'),
    'subagent.started': t('event.subagentStarted'),
    'subagent.finished': t('event.subagentFinished'),
    'permission.requested': t('status.awaitingPermission'),
    'permission.resolved': t('event.approvalResolved'),
    'extensions.selected': t('event.extensionsSelected'),
    'skills.discovered': t('event.skillsDiscovered'),
    'skill.invoked': t('event.skillInvoked'),
    'mcp.call_started': t('event.mcpStarted'),
    'mcp.call_finished': t('event.mcpFinished'),
    'usage.updated': t('event.usageUpdated'),
    'plan.updated': t('event.planUpdated'),
    'artifact.created': t('event.artifactCreated'),
  };
  return names[type] ?? type;
}

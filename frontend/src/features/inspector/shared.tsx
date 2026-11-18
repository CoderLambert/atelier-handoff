import { useCallback, type ReactNode } from 'react';
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import type { Permission } from '@shared/types';

export const fieldClass =
  'h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50';
export const actionLinkClass =
  'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
export const preClass =
  'max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-6 [tab-size:2]';

export function permissionOperation(permission: Permission) {
  if (permission.kind === 'command') return '运行命令';
  if (permission.kind === 'mcp') return '调用 MCP 工具';
  if (permission.kind === 'delete') return '删除文件';
  if (permission.kind === 'write') return permission.before === null ? '新建文件' : '覆盖文件';
  return '修改文件';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求未完成，请稍后重试。';
}

// The shell invalidates shared query prefixes when server events arrive.
export function useResource<T>(path: string | null, queryKey: QueryKey = ['inspector', path]) {
  const query = useQuery<T>({
    queryKey,
    queryFn: ({ signal }) => api<T>(path!, { signal }),
    enabled: Boolean(path),
    retry: false,
  });
  const refetch = query.refetch;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  return {
    data: path ? query.data : undefined,
    loading: Boolean(path) && query.isFetching,
    error: path && query.error ? errorMessage(query.error) : undefined,
    reload,
  };
}

const statuses: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  awaiting_permission: '等待审批',
  stopping: '停止中',
  completed: '已完成',
  stopped: '已停止',
  failed: '失败',
  interrupted: '已中断',
  pending: '待审批',
  allowed: '已允许',
  denied: '已拒绝',
  expired: '已过期',
  canceled: '已取消',
  succeeded: '成功',
  active: '活跃',
  archived: '已归档',
  available: '可用',
  unavailable: '不可用',
};
export function statusLabel(status: string) {
  return statuses[status] ?? status;
}
export function StatusBadge({ status }: { status: string }) {
  const tone = ['failed', 'denied', 'interrupted', 'unavailable'].includes(status)
    ? 'bg-destructive/10 text-destructive'
    : ['pending', 'awaiting_permission'].includes(status)
      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : ['completed', 'succeeded', 'allowed'].includes(status)
        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : ['running', 'queued'].includes(status)
          ? 'bg-primary/10 text-primary'
          : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium leading-none ${tone}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {statusLabel(status)}
    </span>
  );
}

export function Icon({
  name,
  className = 'size-4',
}: {
  name:
    | 'file'
    | 'arrow'
    | 'download'
    | 'activity'
    | 'clock'
    | 'refresh'
    | 'check'
    | 'settings'
    | 'shield'
    | 'folder';
  className?: string;
}) {
  const paths: Record<typeof name, ReactNode> = {
    file: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6M8 13h8M8 17h5" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    download: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M12 3v12m-5-5 5 5 5-5" />
      </>
    ),
    activity: (
      <>
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="2" />
        <circle cx="15" cy="17" r="2" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    folder: (
      <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    ),
  };
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
    >
      <p className="min-w-0 break-words">{message}</p>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}
export function Loading({ children = '正在加载…' }: { children?: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
      <span
        aria-hidden="true"
        className="size-3 animate-pulse rounded-full bg-primary/40 motion-reduce:animate-none"
      />
      {children}
    </p>
  );
}
export function EmptyState({
  title,
  children,
  icon = 'file',
}: {
  title: string;
  children?: ReactNode;
  icon?: 'file' | 'activity' | 'shield';
}) {
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center">
      <span className="mb-4 flex size-11 items-center justify-center rounded-xl border border-border bg-muted/50 text-muted-foreground">
        <Icon name={icon} className="size-5" />
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? (
        <p className="mt-2 max-w-sm text-xs leading-6 text-muted-foreground">{children}</p>
      ) : null}
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
export function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}
export function formatDuration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60000)} 分 ${Math.floor((ms % 60000) / 1000)} 秒`;
}
export function formatBytes(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export const eventNames: Record<string, string> = {
  'run.created': '创建运行',
  'run.status_changed': '运行状态更新',
  'run.finished': '运行结束',
  'process.spawned': '启动执行进程',
  'process.exited': '执行进程退出',
  'sdk.initialized': 'SDK 初始化',
  'sdk.first_text': '收到首段文本',
  'sdk.api_retry': '模型请求重试',
  'sdk.error': 'SDK 错误',
  'sdk.result': 'SDK 返回结果',
  'sdk.notice': 'SDK 通知',
  'sdk.context_restarted': '重新建立上下文',
  'tool.started': '工具开始',
  'tool.finished': '工具结束',
  'tool.blocked': '工具被拦截',
  'permission.requested': '等待审批',
  'permission.resolved': '审批结束',
  'extensions.selected': '加载扩展',
  'skills.discovered': '发现自动调用 Skill',
  'skill.invoked': 'Skill 调用成功',
  'mcp.call_started': '开始调用 MCP',
  'mcp.call_finished': 'MCP 调用结束',
  'usage.updated': '用量已更新',
  'plan.updated': '计划已更新',
  'artifact.created': '交付物已生成',
};

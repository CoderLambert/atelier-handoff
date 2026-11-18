import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Permission } from '@shared/types';
import { DiffView, type PermissionDiff } from './diff-view';
import {
  ErrorNotice,
  Icon,
  Loading,
  StatusBadge,
  errorMessage,
  formatDate,
  permissionOperation,
  preClass,
} from './shared';

type Review = { permission: Permission; preview: PermissionDiff };
export default function PermissionDialog({
  permission: live,
  onOpenChange,
}: {
  permission: Permission;
  onOpenChange: (open: boolean) => void;
}) {
  const [review, setReview] = useState<Review>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [decisionError, setDecisionError] = useState<string>();
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const mutationLock = useRef(false);
  const client = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(undefined);
    Promise.all([
      api<{ permission: Permission }>(`/api/permissions/${encodeURIComponent(live.id)}`, {
        signal: controller.signal,
      }),
      api<PermissionDiff>(`/api/permissions/${encodeURIComponent(live.id)}/diff`, {
        signal: controller.signal,
      }),
    ])
      .then(([detail, preview]) => {
        if (controller.signal.aborted) return;
        if (detail.permission.version !== preview.version)
          throw new Error('审批内容已变化，请重新加载后核对差异。');
        setReview({ permission: detail.permission, preview });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setReview(undefined);
          setLoadError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [live.id, live.version, live.status, attempt]);

  const permission = live.status !== 'pending' ? live : (review?.permission ?? live);
  const expiresAt = permission.expiresAt;
  useEffect(() => {
    setNow(Date.now());
    const delay = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay + 50, 2147483647));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  const expired = Number.isFinite(Date.parse(expiresAt)) && now >= Date.parse(expiresAt);
  const versionMatches = review?.preview.version === live.version;
  const canDecide = Boolean(
    review &&
    versionMatches &&
    !loading &&
    !loadError &&
    permission.status === 'pending' &&
    !expired &&
    !busy,
  );
  async function decide(decision: 'allow' | 'deny') {
    if (!canDecide || !review || mutationLock.current) return;
    mutationLock.current = true;
    setBusy(decision);
    setDecisionError(undefined);
    try {
      const result = await api<{ permission: Permission }>(
        `/api/permissions/${encodeURIComponent(permission.id)}/decision`,
        {
          method: 'POST',
          body: { decision, version: review.preview.version },
        },
      );
      if (mounted.current)
        setReview((current) => (current ? { ...current, permission: result.permission } : current));
    } catch (error) {
      if (mounted.current) {
        setDecisionError(errorMessage(error));
        setAttempt((value) => value + 1);
      }
    } finally {
      mutationLock.current = false;
      if (mounted.current) setBusy(null);
      void client.invalidateQueries({ queryKey: ['snapshot', permission.sessionId] });
      void client.invalidateQueries({ queryKey: ['runs'] });
      void client.invalidateQueries({ queryKey: ['trace', permission.runId] });
    }
  }
  const command = permission.kind === 'command' || permission.kind === 'mcp';
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-5 sm:px-6">
          <DialogTitle className="flex items-center gap-2">
            <Icon name="shield" />
            {command ? '操作审批' : '文件差异与审批'}
          </DialogTitle>
          <DialogDescription>核对操作内容后，决定是否允许本次操作。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-5 overflow-y-auto p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium">
              {permissionOperation(permission)}
            </span>
            <StatusBadge
              status={permission.status === 'pending' && expired ? 'expired' : permission.status}
            />
          </div>
          {permission.path ? (
            <p className="break-all font-mono text-sm font-medium">{permission.path}</p>
          ) : null}
          <dl className="grid gap-3 text-sm sm:grid-cols-[5rem_1fr]">
            <dt className="text-muted-foreground">操作原因</dt>
            <dd className="whitespace-pre-wrap break-words">{permission.reason || '未提供'}</dd>
            {permission.status === 'pending' ? (
              <>
                <dt className="text-muted-foreground">审批截止</dt>
                <dd>{formatDate(permission.expiresAt)}</dd>
              </>
            ) : null}
            {permission.resolutionReason ? (
              <>
                <dt className="text-muted-foreground">处理说明</dt>
                <dd className="break-words">{permission.resolutionReason}</dd>
              </>
            ) : null}
          </dl>
          {loading ? <Loading>正在获取最新审批内容…</Loading> : null}
          {loadError ? (
            <ErrorNotice message={loadError} onRetry={() => setAttempt((value) => value + 1)} />
          ) : null}
          {decisionError ? <ErrorNotice message={decisionError} /> : null}
          {!loading && review ? (
            command ? (
              <pre className={preClass} aria-label="待审批操作">
                {permission.command || review.preview.diff || '未提供操作内容'}
              </pre>
            ) : (
              <DiffView preview={review.preview} />
            )
          ) : null}
          {permission.status === 'pending' && expired ? (
            <p role="status" className="text-sm text-muted-foreground">
              审批已过期，请让运行重新生成操作。
            </p>
          ) : null}
          {review && !versionMatches ? (
            <ErrorNotice
              message="审批版本已变化，请重新加载后再决定。"
              onRetry={() => setAttempt((value) => value + 1)}
            />
          ) : null}
        </div>
        <DialogFooter className="shrink-0 border-t border-border bg-muted/20 px-5 py-4 sm:px-6">
          {permission.status === 'pending' && !expired ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={!canDecide}
                onClick={() => void decide('deny')}
              >
                {busy === 'deny' ? '正在拒绝…' : '拒绝'}
              </Button>
              <Button type="button" disabled={!canDecide} onClick={() => void decide('allow')}>
                {busy === 'allow' ? '正在允许…' : '允许本次操作'}
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

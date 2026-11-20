/**
 * @file 编排单次审批内容复核和决定提交。
 * @implementation 合并详情与预览查询，核对版本与截止时间，阻止重复或过期决定并隔离迟到响应。
 * @updated 2026-11-20T11:51:19+08:00
 */
import { useEffect, useRef, useState } from 'react';
import type { Permission } from '@shared/types';
import { usePermission } from '@/use-query/permissions/use-permission';
import { usePermissionDiff } from '@/use-query/permissions/use-permission-diff';
import { useDecidePermission } from '@/use-query/permissions/use-decide-permission';

export function usePermissionReview(live: Permission) {
  const detail = usePermission(live);
  const preview = usePermissionDiff(live);
  const decision = useDecidePermission();
  const mutationLock = useRef(false);
  const [now, setNow] = useState(Date.now);
  const review =
    detail.data && preview.data ? { permission: detail.data, preview: preview.data } : undefined;
  const currentDecision =
    decision.variables?.id === live.id && decision.variables.version === live.version;
  const permission =
    live.status !== 'pending'
      ? live
      : currentDecision && decision.data
        ? decision.data
        : (review?.permission ?? live);
  const expiresAt = permission.expiresAt;
  useEffect(() => {
    setNow(Date.now());
    const delay = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay + 50, 2147483647));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  const expired = Number.isFinite(Date.parse(expiresAt)) && now >= Date.parse(expiresAt);
  const loading = detail.isFetching || preview.isFetching || detail.isPending || preview.isPending;
  const loadError = detail.error || preview.error;
  const versionMatches = Boolean(
    review &&
    review.permission.version === live.version &&
    review.preview.version === live.version &&
    review.permission.kind === review.preview.kind,
  );
  const busy = currentDecision && decision.isPending ? decision.variables.decision : null;
  const canDecide = Boolean(
    review &&
    versionMatches &&
    !loading &&
    !loadError &&
    permission.status === 'pending' &&
    !expired &&
    !busy &&
    (permission.kind !== 'browser' || Boolean(permission.command || review.preview.diff)),
  );
  function reload() {
    void Promise.all([detail.refetch(), preview.refetch()]);
  }
  async function decide(value: 'allow' | 'deny') {
    if (!canDecide || !review || mutationLock.current) return;
    // Check the clock again: the expiry timer may not have rendered yet.
    if (Date.now() >= Date.parse(permission.expiresAt)) {
      setNow(Date.now());
      return;
    }
    mutationLock.current = true;
    try {
      await decision.mutateAsync({
        id: permission.id,
        version: review.preview.version,
        sessionId: permission.sessionId,
        runId: permission.runId,
        decision: value,
      });
    } catch {
      // The mutation owns the error and refreshes the reviewed content on failure.
    } finally {
      mutationLock.current = false;
    }
  }
  return {
    review,
    permission,
    loading,
    loadError: loadError?.message,
    decisionError: currentDecision ? decision.error?.message : undefined,
    busy,
    expired,
    versionMatches,
    canDecide,
    reload,
    decide,
  };
}

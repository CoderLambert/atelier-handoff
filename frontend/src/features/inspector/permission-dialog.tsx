/**
 * @file 展示工具操作内容与审批记录。
 * @implementation 消费审批复核状态，呈现操作或文件差异、子代理发起方及手动审批与自动批准来源。
 * @updated 2026-11-21T02:17:11+08:00
 */
import { useUiTranslation, translateError } from '@/i18n';
import { Check, LoaderCircle, Shield, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import { DiffView } from './diff-view';
import type { SubagentSource } from './subagent-progress';
import { usePermissionReview } from './hooks/use-permission-review';
import {
  ErrorNotice,
  DetailField,
  Loading,
  StatusBadge,
  formatDate,
  isOperationPermission,
  permissionOperation,
  preClass,
} from './shared';

export default function PermissionDialog({
  permission: live,
  subagent,
  onOpenChange,
}: {
  permission: Permission;
  subagent?: SubagentSource;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useUiTranslation('chat');
  const {
    review,
    permission,
    loading,
    loadError,
    decisionError,
    busy,
    expired,
    versionMatches,
    canDecide,
    reload,
    decide,
  } = usePermissionReview(live);
  const operation = isOperationPermission(permission);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-5 sm:px-6">
          <DialogTitle className="flex items-center gap-2">
            <Shield aria-hidden="true" className="size-4 shrink-0" />
            {operation ? t('permission.operationTitle') : t('permission.fileTitle')}
          </DialogTitle>
          <DialogDescription>
            {permission.decisionSource === 'automatic'
              ? t('permission.automaticHelp')
              : permission.kind === 'browser'
                ? t('permission.browserHelp')
                : t('permission.reviewHelp')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{permissionOperation(permission)}</Badge>
            <StatusBadge
              status={permission.status === 'pending' && expired ? 'expired' : permission.status}
            />
          </div>
          {permission.path ? (
            <p className="break-all font-mono text-sm font-medium">{permission.path}</p>
          ) : null}
          <dl className="grid gap-3">
            <DetailField
              label={t('permission.requestedBy')}
              className="sm:grid-cols-[5rem_1fr] sm:gap-x-3"
            >
              {permission.subagentId || subagent
                ? t('permission.subagent', {
                    title:
                      subagent?.title || permission.subagentId || t('permission.unknownSubagent'),
                  })
                : t('permission.mainAssistant')}
            </DetailField>
            <DetailField
              label={t('permission.source')}
              className="sm:grid-cols-[5rem_1fr] sm:gap-x-3"
            >
              {permission.decisionSource === 'automatic'
                ? t('permission.automatic')
                : t('permission.manual')}
            </DetailField>
            <DetailField
              label={t('permission.reason')}
              className="sm:grid-cols-[5rem_1fr] sm:gap-x-3"
            >
              {permission.reason || t('permission.notProvided')}
            </DetailField>
            {permission.status === 'pending' ? (
              <DetailField
                label={t('permission.deadline')}
                className="sm:grid-cols-[5rem_1fr] sm:gap-x-3"
              >
                {formatDate(permission.expiresAt)}
              </DetailField>
            ) : null}
            {permission.resolutionReason ? (
              <DetailField
                label={t('permission.resolution')}
                className="sm:grid-cols-[5rem_1fr] sm:gap-x-3"
              >
                {permission.resolutionReason}
              </DetailField>
            ) : null}
          </dl>
          {loading ? <Loading>{t('permission.loading')}</Loading> : null}
          {loadError ? (
            <ErrorNotice
              message={translateError(loadError, t('permission.loadFailed'))}
              onRetry={reload}
            />
          ) : null}
          {decisionError ? (
            <ErrorNotice message={translateError(decisionError, t('permission.decisionFailed'))} />
          ) : null}
          {!loading && review ? (
            operation ? (
              <pre
                className={preClass}
                aria-label={
                  permission.kind === 'browser'
                    ? t('permission.browserAction')
                    : t('permission.action')
                }
              >
                {permission.command || review.preview.diff || t('permission.noContent')}
              </pre>
            ) : (
              <DiffView preview={review.preview} />
            )
          ) : null}
          {permission.status === 'pending' && expired ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('permission.expired')}
            </p>
          ) : null}
          {review && !versionMatches ? (
            <ErrorNotice message={t('permission.versionChanged')} onRetry={reload} />
          ) : null}
        </div>
        <DialogFooter className="shrink-0 border-t border-border bg-muted text-muted-foreground px-5 py-4 sm:px-6">
          {permission.status === 'pending' && !expired ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={!canDecide}
                onClick={() => void decide('deny')}
              >
                {busy === 'deny' ? (
                  <LoaderCircle
                    data-icon="inline-start"
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <X data-icon="inline-start" aria-hidden="true" />
                )}
                {busy === 'deny' ? t('permission.denying') : t('permission.deny')}
              </Button>
              <Button type="button" disabled={!canDecide} onClick={() => void decide('allow')}>
                {busy === 'allow' ? (
                  <LoaderCircle
                    data-icon="inline-start"
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <Check data-icon="inline-start" aria-hidden="true" />
                )}
                {busy === 'allow' ? t('permission.allowing') : t('permission.allow')}
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('permission.close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

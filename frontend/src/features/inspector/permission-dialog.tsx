/**
 * @file 展示文件差异或精确工具操作并提供单次审批入口。
 * @implementation 从审批复核 hook 消费已核对的内容和提交状态，浏览器操作以完整文本呈现。
 * @updated 2026-11-20T11:51:19+08:00
 */
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
import { usePermissionReview } from './hooks/use-permission-review';
import {
  ErrorNotice,
  Icon,
  Loading,
  StatusBadge,
  formatDate,
  isOperationPermission,
  permissionOperation,
  preClass,
} from './shared';

export default function PermissionDialog({
  permission: live,
  onOpenChange,
}: {
  permission: Permission;
  onOpenChange: (open: boolean) => void;
}) {
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
            <Icon name="shield" />
            {operation ? '操作审批' : '文件差异与审批'}
          </DialogTitle>
          <DialogDescription>
            {permission.decisionSource === 'automatic'
              ? '本次操作由本轮全工具自动化模式自动批准。可在此查看操作内容与处理记录。'
              : permission.kind === 'browser'
                ? '核对本次浏览器操作的完整内容。允许仅对本次操作生效，读取的网页内容可能发送给模型。'
                : '核对操作内容后，决定是否允许本次操作。'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-5 sm:p-6">
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
            <dt className="text-muted-foreground">审批来源</dt>
            <dd>{permission.decisionSource === 'automatic' ? '自动批准' : '手动审批'}</dd>
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
          {loadError ? <ErrorNotice message={loadError} onRetry={reload} /> : null}
          {decisionError ? <ErrorNotice message={decisionError} /> : null}
          {!loading && review ? (
            operation ? (
              <pre
                className={preClass}
                aria-label={permission.kind === 'browser' ? '待审批浏览器操作' : '待审批操作'}
              >
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
            <ErrorNotice message="审批版本已变化，请重新加载后再决定。" onRetry={reload} />
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

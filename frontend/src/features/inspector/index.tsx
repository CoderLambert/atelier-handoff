/**
 * @file 提供会话变更记录与执行轨迹的公开入口。
 * @implementation 按需展示会话全部审批和文件差异，复用审批对话框并保留子代理来源。
 * @updated 2026-11-22T00:00:00+08:00
 */
import { useUiTranslation } from '@/i18n';
import { lazy, Suspense, useState } from 'react';
import type { Snapshot } from '@/api/types';
import type { Permission } from '@shared/types';
import { permissionSubagentSource } from './subagent-progress';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Loading, StatusBadge, isOperationPermission, permissionOperation } from './shared';

export { ArtifactAction } from './artifact-action';
export { Collections } from './collections';
export { RunTrace } from './run-trace';
export { SubagentProgress, groupRunWork, permissionSubagentSource } from './subagent-progress';
export type { ArtifactActionProps } from './artifact-action';
export type { CollectionsProps } from './collections';
export type { RunTraceProps } from './run-trace';

const PermissionDialog = lazy(() => import('./permission-dialog'));
export function SessionChanges({ snapshot }: { snapshot?: Snapshot }) {
  return <SessionChangeRecords key={snapshot?.session.id ?? 'empty'} snapshot={snapshot} />;
}
function SessionChangeRecords({ snapshot }: { snapshot?: Snapshot }) {
  const { t } = useUiTranslation('inspector');
  const [permissionId, setPermissionId] = useState<string>();
  const permission = snapshot?.permissions.find((item) => item.id === permissionId);
  const records = snapshot
    ? [
        ...snapshot.permissions.filter((item) => item.status === 'pending').reverse(),
        ...snapshot.permissions.filter((item) => item.status !== 'pending').reverse(),
      ]
    : [];
  return (
    <section aria-label={t('changes.records')} className="min-h-0 flex-1 overflow-y-auto">
      {!snapshot ? (
        <div className="px-4">
          <Loading>{t('changes.loading')}</Loading>
        </div>
      ) : records.length ? (
        <div className="flex flex-col gap-3 p-1">
          {records.map((item) => (
            <PermissionCard
              key={item.id}
              permission={item}
              onOpen={() => setPermissionId(item.id)}
            />
          ))}
        </div>
      ) : (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {t('changes.empty')}
        </p>
      )}
      {permission ? (
        <Suspense fallback={<Loading>{t('common.openingApproval')}</Loading>}>
          <PermissionDialog
            key={permission.id}
            permission={permission}
            subagent={snapshot ? permissionSubagentSource(snapshot, permission) : undefined}
            onOpenChange={(open) => {
              if (!open) setPermissionId(undefined);
            }}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
function PermissionCard({ permission, onOpen }: { permission: Permission; onOpen: () => void }) {
  const { t } = useUiTranslation('inspector');
  const pending = permission.status === 'pending';
  return (
    <article className="rounded-xl border border-border bg-card text-card-foreground p-3.5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-medium text-muted-foreground">
          {permissionOperation(permission)}
          {permission.decisionSource === 'automatic' ? t('common.approvalAutomaticSuffix') : ''}
        </span>
        <StatusBadge status={permission.status} />
      </div>
      <p className="break-all font-mono text-[11px] leading-5">
        {permission.path || permission.command || permission.reason}
      </p>
      <Button type="button" variant="link" size="xs" onClick={onOpen} className="mt-3">
        {pending
          ? t('changes.reviewDetails')
          : isOperationPermission(permission)
            ? t('changes.viewOperation')
            : t('changes.viewDiff')}
        <ChevronRight data-icon="inline-end" aria-hidden="true" />
      </Button>
    </article>
  );
}

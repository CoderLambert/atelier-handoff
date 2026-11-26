/**
 * @file 展示交付物卡片及其预览和文件操作入口。
 * @implementation 根据交付物可用状态显示信息，按需加载预览弹窗，并在卡片和弹窗之间共享保存与定位状态。
 * @updated 2026-11-20T03:34:05+08:00
 */
import { useUiTranslation } from '@/i18n';
import { lazy, Suspense, useState } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/components/ui/utils';
import type { Artifact } from '@shared/types';
import { useArtifactFileActions } from '@/use-query/artifacts/use-artifact-file-actions';
import { ArtifactFileActions } from './artifact-file-actions';
import { Loading, formatBytes } from './shared';

const ArtifactDialog = lazy(() => import('./artifact-dialog'));
export type ArtifactActionProps = {
  artifact: Artifact;
  showDownload?: boolean;
  variant?: 'card' | 'compact';
};
export function ArtifactAction({
  artifact,
  showDownload = false,
  variant = 'card',
}: ArtifactActionProps) {
  const { t } = useUiTranslation('inspector');
  const [open, setOpen] = useState(false);
  const fileActions = useArtifactFileActions(artifact);
  const available = artifact.availability === 'available';
  const html = /\.html?$/i.test(artifact.name);
  const compact = variant === 'compact';
  return (
    <>
      <div
        className={cn(
          showDownload ? 'flex min-w-0 items-center border border-border bg-card' : 'contents',
          showDownload && (compact ? 'rounded-md' : 'rounded-xl'),
        )}
      >
        <button
          type="button"
          disabled={!available}
          onClick={() => setOpen(true)}
          className={cn(
            'group flex w-full min-w-0 items-center text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55',
            compact ? 'gap-2 px-2.5 py-2' : 'gap-3 p-3.5',
            showDownload
              ? compact
                ? 'rounded-l-md'
                : 'rounded-l-xl'
              : compact
                ? 'rounded-md border border-border bg-card text-card-foreground'
                : 'rounded-xl border border-border bg-card text-card-foreground',
          )}
          aria-label={t(available ? 'artifact.previewName' : 'artifact.unavailableName', {
            name: artifact.name,
          })}
        >
          <span
            className={cn(
              'flex shrink-0 items-center justify-center',
              compact ? 'size-7 rounded-md' : 'size-10 rounded-lg',
              html ? 'bg-info-soft text-info' : 'bg-muted text-muted-foreground',
            )}
          >
            <FileText aria-hidden="true" className={compact ? 'size-4' : 'size-5'} />
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn('block truncate font-medium', compact ? 'text-sm' : 'text-xs')}
              title={artifact.name}
            >
              {artifact.name}
            </span>
            <span
              className={cn(
                'block truncate text-muted-foreground',
                compact ? 'text-xs' : 'mt-1 text-[10px]',
              )}
            >
              {available
                ? `${html ? t('artifact.htmlPrototype') : artifact.mime} · ${formatBytes(artifact.size)}`
                : t('artifact.missing')}
            </span>
          </span>
          {available && !compact ? (
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none"
            />
          ) : !available ? (
            <Badge variant="destructive">{t('common.unavailable')}</Badge>
          ) : null}
        </button>
        {showDownload && available ? (
          <div className={cn('shrink-0', compact ? 'mr-1' : 'mx-2')}>
            <ArtifactFileActions artifact={artifact} actions={fileActions} />
          </div>
        ) : null}
      </div>
      {fileActions.error && !open ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {fileActions.error}
        </p>
      ) : null}
      {open && available ? (
        <Suspense fallback={<Loading>{t('artifact.opening')}</Loading>}>
          <ArtifactDialog
            key={artifact.id}
            artifact={artifact}
            fileActions={fileActions}
            onOpenChange={setOpen}
          />
        </Suspense>
      ) : null}
    </>
  );
}

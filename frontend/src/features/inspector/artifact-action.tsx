/**
 * @file 展示交付物卡片及其预览和文件操作入口。
 * @implementation 根据交付物可用状态显示信息，按需加载预览弹窗，并在卡片和弹窗之间共享保存与定位状态。
 * @updated 2026-11-20T03:34:05+08:00
 */
import { lazy, Suspense, useState } from 'react';
import type { Artifact } from '@shared/types';
import { useArtifactFileActions } from '@/use-query/artifacts/use-artifact-file-actions';
import { ArtifactFileActions } from './artifact-file-actions';
import { Icon, Loading, formatBytes } from './shared';

const ArtifactDialog = lazy(() => import('./artifact-dialog'));
export type ArtifactActionProps = { artifact: Artifact; showDownload?: boolean };
export function ArtifactAction({ artifact, showDownload = false }: ArtifactActionProps) {
  const [open, setOpen] = useState(false);
  const fileActions = useArtifactFileActions(artifact);
  const available = artifact.availability === 'available';
  const html = /\.html?$/i.test(artifact.name);
  return (
    <>
      <div
        className={
          showDownload
            ? 'flex min-w-0 items-center rounded-xl border border-border bg-card'
            : 'contents'
        }
      >
        <button
          type="button"
          disabled={!available}
          onClick={() => setOpen(true)}
          className={`group flex w-full min-w-0 items-center gap-3 p-3.5 text-left transition-colors hover:border-primary/30 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 ${showDownload ? 'rounded-l-xl' : 'rounded-xl border border-border bg-card'}`}
          aria-label={`${available ? '预览' : '不可用'}：${artifact.name}`}
        >
          <span
            className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${html ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}
          >
            <Icon name="file" className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium" title={artifact.name}>
              {artifact.name}
            </span>
            <span className="mt-1 block truncate text-[10px] text-muted-foreground">
              {available
                ? `${html ? 'HTML 原型' : artifact.mime} · ${formatBytes(artifact.size)}`
                : '文件丢失或版本不匹配'}
            </span>
          </span>
          {available ? (
            <Icon
              name="arrow"
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none"
            />
          ) : (
            <span className="shrink-0 text-[10px] text-muted-foreground">不可用</span>
          )}
        </button>
        {showDownload && available ? (
          <div className="mx-2 shrink-0">
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
        <Suspense fallback={<Loading>正在打开交付物…</Loading>}>
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

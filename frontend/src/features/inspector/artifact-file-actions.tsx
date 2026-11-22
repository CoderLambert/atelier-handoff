/**
 * @file 展示交付物的保存副本与定位操作。
 * @implementation 消息卡片和预览工具栏复用同一组按钮，Web 保留同源下载链接。
 * @updated 2026-11-20T11:00:00+08:00
 */
import { useUiTranslation } from '@/i18n';
import { Download, FolderOpen } from 'lucide-react';
import type { Artifact } from '@shared/types';
import { Button } from '@/components/ui/button';
import type { ArtifactFileActionsState } from '@/use-query/artifacts/use-artifact-file-actions';

export function ArtifactFileActions({
  artifact,
  actions,
}: {
  artifact: Artifact;
  actions: ArtifactFileActionsState;
}) {
  const { t } = useUiTranslation('inspector');
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1"
      aria-label={t('artifact.fileActions')}
    >
      {actions.desktop ? (
        <>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={actions.pending}
            aria-label={t('artifact.saveName', { name: artifact.name })}
            title={actions.pending ? t('artifact.processing') : t('artifact.saveCopy')}
            onClick={() => void actions.save()}
          >
            <Download data-icon="inline-start" aria-hidden="true" />
          </Button>
          {actions.saved ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={actions.pending}
              aria-label={t('artifact.revealName', { name: artifact.name })}
              title={t('artifact.revealSaved')}
              onClick={() => void actions.reveal()}
            >
              <FolderOpen data-icon="inline-start" aria-hidden="true" />
            </Button>
          ) : null}
        </>
      ) : (
        <Button
          asChild
          size="icon-sm"
          variant="ghost"
          aria-label={t('artifact.downloadName', { name: artifact.name })}
          title={t('artifact.downloadFile')}
        >
          <a
            href={`/api/artifacts/${encodeURIComponent(artifact.id)}/download`}
            download={artifact.name}
          >
            <Download data-icon="inline-start" aria-hidden="true" />
          </a>
        </Button>
      )}
    </div>
  );
}

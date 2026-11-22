/**
 * @file 为聊天任务选择项目上下文文件。
 * @implementation 浏览目录、预览文件并限制重复选择和文件数量。
 * @updated 2026-11-20T02:00+08:00
 */
import { useUiTranslation, translateError } from '@/i18n';
import { lazy, Suspense, useState } from 'react';
import { ArrowLeft, ArrowUp, File, Folder } from 'lucide-react';
import { useProjectFiles } from '@/use-query/projects/use-project-files';
import { useProjectFile } from '@/use-query/projects/use-project-file';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const FilePreview = lazy(() => import('@/components/file-preview'));

export function ContextPicker({
  projectId,
  selectedPaths,
  onSelect,
  onClose,
}: {
  projectId: string;
  selectedPaths: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useUiTranslation('chat');
  const [directory, setDirectory] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const files = useProjectFiles(projectId, directory);
  const document = useProjectFile(projectId, preview);
  const limitReached = selectedPaths.length >= 30;

  function select(path: string) {
    onSelect(path);
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="chat-context-dialog">
        <DialogHeader>
          <DialogTitle>{t('context.title')}</DialogTitle>
          <DialogDescription>{t('context.description')}</DialogDescription>
        </DialogHeader>
        {preview !== null ? (
          <>
            <div className="dialog-actions chat-context-path">
              <Button type="button" variant="outline" size="sm" onClick={() => setPreview(null)}>
                <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                {t('context.backToDirectory')}
              </Button>
              <span>{preview}</span>
            </div>
            {document.isPending ? (
              <p role="status">{t('context.readingFile')}</p>
            ) : document.isError ? (
              <p className="text-sm text-destructive" role="alert">
                {translateError(document.error, t('context.readFailed'))}
              </p>
            ) : (
              <div className="chat-file-preview" aria-label={t('context.preview')}>
                <Suspense fallback={<p role="status">{t('context.loadingPreview')}</p>}>
                  <FilePreview
                    name={preview.split('/').at(-1) ?? preview}
                    text={document.data.text}
                  />
                </Suspense>
              </div>
            )}
            <div className="dialog-actions">
              <Button
                type="button"
                size="sm"
                disabled={!document.isSuccess || selectedPaths.includes(preview) || limitReached}
                onClick={() => select(preview)}
              >
                {selectedPaths.includes(preview) ? t('context.selected') : t('context.selectFile')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog-actions chat-context-path">
              <Button
                type="button"
                variant="outline"
                disabled={!directory}
                onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}
              >
                <ArrowUp data-icon="inline-start" aria-hidden="true" />
                {t('context.parent')}
              </Button>
              <span>{directory || '/'}</span>
            </div>
            {files.isPending ? (
              <p role="status">{t('context.readingDirectory')}</p>
            ) : files.isError ? (
              <div>
                <p className="text-sm text-destructive" role="alert">
                  {translateError(files.error, t('context.readFailed'))}
                </p>
                <Button type="button" variant="outline" onClick={() => void files.refetch()}>
                  {t('context.reload')}
                </Button>
              </div>
            ) : (
              <div className="chat-context-options">
                {files.data.items.length ? (
                  files.data.items.map((file) => (
                    <div key={file.path} className="chat-file-choice">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="chat-context-option"
                        title={file.path}
                        onClick={() =>
                          file.isDirectory ? setDirectory(file.path) : setPreview(file.path)
                        }
                      >
                        {file.isDirectory ? (
                          <Folder data-icon="inline-start" aria-hidden="true" />
                        ) : (
                          <File data-icon="inline-start" aria-hidden="true" />
                        )}
                        <span className="chat-file-kind">
                          {file.isDirectory ? t('context.directory') : t('context.file')}
                        </span>{' '}
                        {file.name}
                      </Button>
                      {!file.isDirectory ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={selectedPaths.includes(file.path) || limitReached}
                          onClick={() => select(file.path)}
                        >
                          {selectedPaths.includes(file.path)
                            ? t('context.selected')
                            : t('context.select')}
                        </Button>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p className="py-6 text-sm text-muted-foreground">{t('context.empty')}</p>
                )}
              </div>
            )}
          </>
        )}
        {limitReached ? (
          <p className="text-sm text-warning" role="status">
            {t('context.limit')}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

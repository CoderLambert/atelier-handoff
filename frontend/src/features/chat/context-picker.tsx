/**
 * @file 为聊天任务选择上下文文件。
 * @implementation 按项目与会话浏览和预览实际工作目录，并限制重复选择和文件数量。
 * @updated 2026-11-24T03:39:03+08:00
 */
import { useUiTranslation, translateError } from '@/i18n';
import { lazy, Suspense, useState } from 'react';
import { ArrowLeft, ArrowUp, Check, ChevronRight, File, Folder } from 'lucide-react';
import { useProjectFiles } from '@/use-query/projects/use-project-files';
import { useProjectFile } from '@/use-query/projects/use-project-file';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const FilePreview = lazy(() => import('@/components/file-preview'));

export function ContextPicker({
  projectId,
  sessionId,
  selectedPaths,
  onSelect,
  onClose,
}: {
  projectId: string;
  sessionId?: string;
  selectedPaths: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useUiTranslation('chat');
  const [directory, setDirectory] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const files = useProjectFiles(projectId, directory, sessionId);
  const document = useProjectFile(projectId, preview, sessionId);
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
      <DialogContent
        className="chat-context-dialog"
        data-preview={preview !== null ? 'true' : undefined}
      >
        <DialogHeader>
          <DialogTitle>{t('context.title')}</DialogTitle>
          <DialogDescription>{t('context.description')}</DialogDescription>
        </DialogHeader>
        {preview !== null ? (
          <>
            <div className="chat-context-toolbar">
              <div className="chat-context-toolbar-left">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="chat-context-parent-btn"
                  onClick={() => setPreview(null)}
                >
                  <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                  {t('context.backToDirectory')}
                </Button>
                <span className="chat-context-preview-path" title={preview}>
                  {preview}
                </span>
              </div>
              <span
                className={cn(
                  'chat-context-counter',
                  limitReached
                    ? 'chat-context-counter-limit'
                    : selectedPaths.length >= 25
                      ? 'chat-context-counter-warning'
                      : undefined,
                )}
                role="status"
              >
                {t('context.selectedCount', { count: selectedPaths.length, max: 30 })}
              </span>
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
            <DialogFooter className="chat-context-footer">
              <div className="chat-context-footer-left">
                <span className="text-xs text-muted-foreground truncate">{preview}</span>
              </div>
              <div className="chat-context-footer-right">
                <Button
                  type="button"
                  size="sm"
                  disabled={!document.isSuccess || selectedPaths.includes(preview) || limitReached}
                  onClick={() => select(preview)}
                >
                  {selectedPaths.includes(preview)
                    ? t('context.selected')
                    : t('context.selectFile')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onClose}>
                  {t('context.close')}
                </Button>
              </div>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="chat-context-toolbar">
              <div className="chat-context-toolbar-left">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="chat-context-parent-btn"
                  disabled={!directory}
                  onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}
                >
                  <ArrowUp data-icon="inline-start" aria-hidden="true" />
                  {t('context.parent')}
                </Button>
                <div className="chat-context-breadcrumbs" aria-label={t('context.currentPath')}>
                  <button
                    type="button"
                    className="chat-context-crumb"
                    onClick={() => setDirectory('')}
                    title="/"
                  >
                    /
                  </button>
                  {directory
                    ? directory.split('/').map((segment, index, array) => {
                        const path = array.slice(0, index + 1).join('/');
                        const isLast = index === array.length - 1;
                        return (
                          <span key={path} className="chat-context-crumb-item">
                            <span className="chat-context-crumb-separator" aria-hidden="true">
                              /
                            </span>
                            {isLast ? (
                              <span className="chat-context-crumb-current" title={segment}>
                                {segment}
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="chat-context-crumb"
                                onClick={() => setDirectory(path)}
                                title={segment}
                              >
                                {segment}
                              </button>
                            )}
                          </span>
                        );
                      })
                    : null}
                </div>
              </div>
              <span
                className={cn(
                  'chat-context-counter',
                  limitReached
                    ? 'chat-context-counter-limit'
                    : selectedPaths.length >= 25
                      ? 'chat-context-counter-warning'
                      : undefined,
                )}
                role="status"
              >
                {t('context.selectedCount', { count: selectedPaths.length, max: 30 })}
              </span>
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
                  files.data.items.map((file) => {
                    const isSelected = selectedPaths.includes(file.path);
                    return (
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
                            <Folder
                              className="chat-file-icon"
                              data-icon="inline-start"
                              aria-hidden="true"
                            />
                          ) : (
                            <File
                              className="chat-file-icon"
                              data-icon="inline-start"
                              aria-hidden="true"
                            />
                          )}
                          <span className="chat-file-kind sr-only">
                            {file.isDirectory ? t('context.directory') : t('context.file')}
                          </span>
                          <span className="chat-file-name">{file.name}</span>
                          {file.isDirectory ? (
                            <ChevronRight
                              className="chat-file-chevron ml-auto"
                              data-icon="inline-end"
                              aria-hidden="true"
                            />
                          ) : null}
                        </Button>
                        {!file.isDirectory ? (
                          isSelected ? (
                            <span className="chat-context-selected-badge" role="status">
                              <Check
                                className="h-3.5 w-3.5"
                                data-icon="inline-start"
                                aria-hidden="true"
                              />
                              {t('context.selected')}
                            </span>
                          ) : file.size > 128 * 1024 ? (
                            <span
                              className="chat-context-selected-badge text-muted-foreground"
                              title={t('context.fileTooLarge')}
                            >
                              {t('context.fileTooLarge')}
                            </span>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="chat-context-select-btn"
                              disabled={limitReached}
                              onClick={(event) => {
                                event.stopPropagation();
                                select(file.path);
                              }}
                            >
                              {t('context.select')}
                            </Button>
                          )
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    {t('context.empty')}
                  </p>
                )}
              </div>
            )}
            <DialogFooter className="chat-context-footer">
              <div className="chat-context-footer-left">
                {files.isSuccess ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {t('context.itemsCount', { count: files.data.items.length })}
                  </span>
                ) : null}
              </div>
              <div className="chat-context-footer-right">
                <Button type="button" variant="outline" size="sm" onClick={onClose}>
                  {t('context.close')}
                </Button>
              </div>
            </DialogFooter>
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

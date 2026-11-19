import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const FilePreview = lazy(() => import('@/components/file-preview'));

interface ProjectFile {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}
interface FileList {
  path: string;
  items: ProjectFile[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : '读取项目文件失败');

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
  const [directory, setDirectory] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const files = useQuery({
    queryKey: ['project-files', projectId, directory],
    queryFn: ({ signal }) =>
      api<FileList>(
        `/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(directory)}`,
        { signal },
      ),
  });
  const document = useQuery({
    queryKey: ['project-file', projectId, preview],
    queryFn: ({ signal }) =>
      api<{ path: string; text: string }>(
        `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(preview!)}`,
        { signal },
      ),
    enabled: preview !== null,
  });
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
          <DialogTitle>选择项目上下文</DialogTitle>
          <DialogDescription>
            选择的 UTF-8 文本文件会随下次任务一起读取，最多 30 个。
          </DialogDescription>
        </DialogHeader>
        {preview !== null ? (
          <>
            <div className="dialog-actions chat-context-path">
              <Button type="button" variant="outline" onClick={() => setPreview(null)}>
                返回目录
              </Button>
              <span>{preview}</span>
            </div>
            {document.isPending ? (
              <p role="status">正在读取文件…</p>
            ) : document.isError ? (
              <p className="trace-error" role="alert">
                {errorText(document.error)}
              </p>
            ) : (
              <div className="chat-file-preview" aria-label="项目文件预览">
                <Suspense fallback={<p role="status">正在加载预览…</p>}>
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
                className="btn btn-primary"
                disabled={!document.isSuccess || selectedPaths.includes(preview) || limitReached}
                onClick={() => select(preview)}
              >
                {selectedPaths.includes(preview) ? '已选择' : '选择文件'}
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
                上一级
              </Button>
              <span>{directory || '/'}</span>
            </div>
            {files.isPending ? (
              <p role="status">正在读取目录…</p>
            ) : files.isError ? (
              <div>
                <p className="trace-error" role="alert">
                  {errorText(files.error)}
                </p>
                <Button type="button" variant="outline" onClick={() => void files.refetch()}>
                  重新加载
                </Button>
              </div>
            ) : (
              <div className="context-options chat-context-options">
                {files.data.items.length ? (
                  files.data.items.map((file) => (
                    <div key={file.path} className="file-choice">
                      <button
                        type="button"
                        className="context-option"
                        onClick={() =>
                          file.isDirectory ? setDirectory(file.path) : setPreview(file.path)
                        }
                      >
                        <span className="chat-file-kind">{file.isDirectory ? '目录' : '文件'}</span>{' '}
                        {file.name}
                      </button>
                      {!file.isDirectory ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="btn btn-secondary"
                          disabled={selectedPaths.includes(file.path) || limitReached}
                          onClick={() => select(file.path)}
                        >
                          {selectedPaths.includes(file.path) ? '已选择' : '选择'}
                        </Button>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p className="empty-text">目录为空</p>
                )}
              </div>
            )}
          </>
        )}
        {limitReached ? (
          <p className="muted" role="status">
            已达到 30 个上下文文件的上限，请先移除部分文件。
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

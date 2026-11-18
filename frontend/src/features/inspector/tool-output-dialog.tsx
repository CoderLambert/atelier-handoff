import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ToolCall } from '@shared/types';
import { ErrorNotice, Icon, Loading, actionLinkClass, preClass, useResource } from './shared';

type OutputPage = { text: string; offset: number; total: number; nextOffset: number | null };
const PAGE_SIZE = 16000;
export default function ToolOutputDialog({
  tool,
  onOpenChange,
}: {
  tool: ToolCall;
  onOpenChange: (open: boolean) => void;
}) {
  const [offset, setOffset] = useState(0);
  const path = `/api/tools/${encodeURIComponent(tool.id)}/output`;
  const output = useResource<OutputPage>(`${path}?offset=${offset}&limit=${PAGE_SIZE}`);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-4xl flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>完整工具输出</DialogTitle>
          <DialogDescription>
            {tool.name} · 每页 {PAGE_SIZE.toLocaleString()} 字符
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {output.loading ? <Loading /> : null}
          {output.error ? <ErrorNotice message={output.error} onRetry={output.reload} /> : null}
          {output.data ? (
            <pre tabIndex={0} aria-label="工具输出内容" className={preClass}>
              {output.data.text || '（空输出）'}
            </pre>
          ) : null}
        </div>
        <DialogFooter className="flex-wrap sm:justify-between">
          <a className={actionLinkClass} href={`${path}?download=1`} download>
            <Icon name="download" />
            下载完整输出
          </a>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={offset === 0 || output.loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              上一页
            </Button>
            <span className="text-xs text-muted-foreground">
              {output.data
                ? `${output.data.total ? output.data.offset + 1 : 0}–${Math.min(output.data.offset + PAGE_SIZE, output.data.total)} / ${output.data.total}`
                : '—'}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={output.loading || output.data?.nextOffset == null}
              onClick={() => {
                if (output.data?.nextOffset != null) setOffset(output.data.nextOffset);
              }}
            >
              下一页
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

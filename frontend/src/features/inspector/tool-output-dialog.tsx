/**
 * @file 按页展示工具回执或已保存的 Bash 日志。
 * @implementation 通过具名查询按需加载输出页，支持错误重试、键盘阅读和下载。
 * @updated 2026-11-22T21:17:02+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useId, useMemo, useRef, useState } from 'react';
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
import { Download } from 'lucide-react';
import { ErrorNotice, Loading, errorMessage } from './shared';
import {
  useToolOutput,
  toolOutputDownloadUrl,
  outputPageSize,
} from '@/use-query/tools/use-tool-output';
import { toolOutputPresentation } from './tool-detail-format';
import { formatToolOutputJson } from './tool-output-format';

export default function ToolOutputDialog({
  tool,
  onOpenChange,
}: {
  tool: ToolCall;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useUiTranslation('inspector');
  const [offset, setOffset] = useState(0);
  const [showRaw, setShowRaw] = useState(false);
  const outputId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);
  const output = useToolOutput(tool.id, offset);
  const presentation = toolOutputPresentation(tool);
  const savedLog = tool.bashLog?.status === 'complete' || tool.bashLog?.status === 'partial';
  const page = output.data;
  const formatted = useMemo(
    () =>
      !savedLog && page?.offset === 0 && page.nextOffset === null && page.text.length === page.total
        ? formatToolOutputJson(page.text, tool.name)
        : undefined,
    [page, savedLog, tool.name],
  );
  const preview = showRaw ? undefined : formatted;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="tool-output-dialog"
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{presentation.title}</DialogTitle>
          <DialogDescription>
            {t('tool.pageCharacters', { name: tool.name, count: outputPageSize })}
            {presentation.scope ? (
              <>
                <br />
                {presentation.scope}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div
          key={offset}
          id={outputId}
          className="tool-output-dialog__reader"
          aria-busy={output.isFetching}
        >
          {output.isFetching ? <Loading /> : null}
          {output.error ? (
            <ErrorNotice
              message={errorMessage(output.error)}
              onRetry={() => void output.refetch()}
            />
          ) : null}
          {page ? (
            <pre tabIndex={0} aria-label={t('tool.outputContents')}>
              {preview?.text ?? (page.text || t('tool.emptyOutput'))}
            </pre>
          ) : null}
          {preview?.excerpt ? (
            <section className="tool-output-dialog__excerpt">
              <h3>{t('tool.outputExcerpt')}</h3>
              <pre tabIndex={0} aria-label={t('tool.outputExcerpt')}>
                {preview.excerpt}
              </pre>
            </section>
          ) : null}
        </div>
        <DialogFooter>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={toolOutputDownloadUrl(tool.id)} download={presentation.downloadName}>
                <Download data-icon="inline-start" aria-hidden="true" />
                {presentation.downloadLabel}
              </a>
            </Button>
            {formatted ? (
              <Button
                type="button"
                variant={showRaw ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={showRaw}
                aria-controls={outputId}
                onClick={() => setShowRaw((value) => !value)}
              >
                {t('tool.rawOutput')}
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={offset === 0 || output.isFetching}
              onClick={() => setOffset(Math.max(0, offset - outputPageSize))}
            >
              {t('common.previous')}
            </Button>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {output.data
                ? t('tool.outputRange', {
                    range: presentation.rangeLabel ? `${presentation.rangeLabel} ` : '',
                    start: (output.data.text.length ? output.data.offset + 1 : 0).toLocaleString(
                      locale,
                    ),
                    end: Math.min(
                      output.data.offset + output.data.text.length,
                      output.data.total,
                    ).toLocaleString(locale),
                    total: output.data.total.toLocaleString(locale),
                  })
                : '—'}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={output.isFetching || output.data?.nextOffset == null}
              onClick={() => {
                if (output.data?.nextOffset != null) setOffset(output.data.nextOffset);
              }}
            >
              {t('common.next')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

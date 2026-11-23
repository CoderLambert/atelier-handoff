/**
 * @file 提供 FileVista 的 XLS/XLSX 纯文本预览适配器。
 * @implementation 通过统一字节源读取文件，以 Vite 独立 worker 解析有界表格；管理切表、重试、超时、析构及可选失败回调。
 * @updated 2026-11-21T00:00:00+08:00
 */
import { useUiTranslation, getTranslator } from '@/i18n';
import { useEffect, useId, useState } from 'react';
import {
  getSourceSize,
  readSourceAsArrayBuffer,
  PreviewError,
  type FileInfo,
} from '@lamberl-lee/file-preview';
import { documentPreviewBytes } from '@shared/document-attachments';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import type {
  SpreadsheetErrorCode,
  SpreadsheetSheet,
  SpreadsheetWorkerResponse,
} from './spreadsheet-preview.worker';
import {
  columnLabel,
  isRecord,
  isSheet,
  isWorkerResponse,
  workerErrorKeys,
  type PreviewState,
  type SpreadsheetMessageKey,
} from './spreadsheet-preview-utils';

const MAX_FILE_BYTES = documentPreviewBytes;
const LOAD_TIMEOUT_MS = 15_000;

export default function SpreadsheetPreview({
  file,
  reportError,
}: {
  file: FileInfo;
  reportError?: (error: PreviewError) => void;
}) {
  const { t, locale } = useUiTranslation('inspector');
  const { source, size, name } = file;
  const [attempt, setAttempt] = useState(0);
  const [activeSheet, setActiveSheet] = useState('0');
  const [state, setState] = useState<PreviewState>({ source, attempt, status: 'loading' });
  const selectId = useId();

  useEffect(() => {
    const controller = new AbortController();
    let worker: Worker | undefined;
    let settled = false;
    setState({ source, attempt, status: 'loading' });

    function stop() {
      window.clearTimeout(timeout);
      controller.abort();
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        worker = undefined;
      }
    }

    function fail(messageKey: SpreadsheetMessageKey) {
      if (settled) return;
      settled = true;
      stop();
      setState({ source, attempt, status: 'error', messageKey });
      const message = getTranslator('inspector')(messageKey);
      reportError?.(new PreviewError('PARSE_FAILED', message, { fileName: name }));
    }

    const timeout = window.setTimeout(() => {
      fail('spreadsheet.timeout');
    }, LOAD_TIMEOUT_MS);

    void (async () => {
      if (size > MAX_FILE_BYTES || (getSourceSize(source) ?? 0) > MAX_FILE_BYTES) {
        fail('spreadsheet.tooLarge');
        return;
      }
      // FileVista copies arrayBuffer sources, so transferring this buffer preserves the original.
      const buffer = await readSourceAsArrayBuffer(source, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (buffer.byteLength > MAX_FILE_BYTES) {
        fail('spreadsheet.tooLarge');
        return;
      }
      worker = new Worker(new URL('./spreadsheet-preview.worker.ts', import.meta.url), {
        type: 'module',
        name: 'spreadsheet-preview',
      });
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (settled) return;
        if (!isWorkerResponse(event.data)) {
          fail('spreadsheet.invalidResponse');
          return;
        }
        if (event.data.status === 'error') {
          fail(workerErrorKeys[event.data.code]);
          return;
        }
        settled = true;
        stop();
        setActiveSheet('0');
        setState({ source, attempt, status: 'success', sheets: event.data.sheets });
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fail('spreadsheet.workerFailed');
      };
      worker.onmessageerror = () => {
        fail('spreadsheet.messageFailed');
      };
      worker.postMessage(buffer, [buffer]);
    })().catch(() => fail('spreadsheet.loadFailed'));

    return () => {
      settled = true;
      stop();
    };
  }, [source, size, name, attempt, reportError]);

  if (state.source !== source || state.attempt !== attempt || state.status === 'loading') {
    return (
      <div className="p-6 text-sm text-muted-foreground" role="status" aria-live="polite">
        {t('spreadsheet.reading')}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-3 p-6 text-sm">
        <p role="alert">{t(state.messageKey)}</p>
        <p className="text-muted-foreground">{t('spreadsheet.openOriginal')}</p>
        <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  const sheet = state.sheets[Number(activeSheet)] ?? state.sheets[0];
  if (!sheet)
    return <p className="p-6 text-sm text-muted-foreground">{t('spreadsheet.noSheets')}</p>;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <label htmlFor={selectId} className="text-sm text-muted-foreground">
          {t('spreadsheet.sheet')}
        </label>
        <Select value={activeSheet} onValueChange={setActiveSheet}>
          <SelectTrigger id={selectId} size="sm" className="max-w-80 min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>
              {state.sheets.map((item, index) => (
                <SelectItem key={index} value={String(index)} title={item.name}>
                  {item.name ||
                    t('spreadsheet.unnamedSheet', { number: (index + 1).toLocaleString(locale) })}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('spreadsheet.dimensions', {
            rows: sheet.rows.length.toLocaleString(locale),
            columns: sheet.columnCount.toLocaleString(locale),
          })}{' '}
          · {t('spreadsheet.sheetCount', { count: state.sheets.length })}
        </p>
      </div>
      {sheet.rangeTruncated || sheet.textTruncated ? (
        <p
          role="status"
          className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground"
        >
          {sheet.rangeTruncated ? t('spreadsheet.rangeTruncated') : ''}
          {sheet.textTruncated ? t('spreadsheet.textTruncated') : ''}
          {t('spreadsheet.fullContentsHint')}
        </p>
      ) : null}
      {sheet.rows.length && sheet.columnCount ? (
        <div
          key={activeSheet}
          role="region"
          aria-label={t('spreadsheet.sheetContents', { name: sheet.name })}
          tabIndex={0}
          className="min-h-0 min-w-0 flex-1 overflow-auto"
        >
          <table className="w-max min-w-full border-collapse text-sm">
            <caption className="sr-only">
              {file.name} · {sheet.name}
            </caption>
            <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
              <tr>
                <th scope="col" className="sticky left-0 bg-muted px-3 py-2 font-normal">
                  <span className="sr-only">{t('spreadsheet.rowNumber')}</span>
                </th>
                {Array.from({ length: sheet.columnCount }, (_, column) => (
                  <th
                    key={column}
                    scope="col"
                    className="border border-border px-3 py-2 text-left font-normal"
                  >
                    {columnLabel(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th
                    scope="row"
                    className="sticky left-0 border border-border bg-muted px-3 py-2 text-right font-normal text-muted-foreground"
                  >
                    {(rowIndex + 1).toLocaleString(locale)}
                  </th>
                  {row.map((cell, columnIndex) => (
                    <td key={columnIndex} className="border border-border px-3 py-2 align-top">
                      <div className="min-w-20 max-w-80 truncate" title={cell}>
                        {cell}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="p-6 text-sm text-muted-foreground">{t('spreadsheet.emptySheet')}</p>
      )}
      <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        {t('spreadsheet.formulasHint')}
      </p>
    </div>
  );
}

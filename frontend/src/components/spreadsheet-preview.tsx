/**
 * @file 提供 FileVista 的 XLS/XLSX 纯文本预览适配器。
 * @implementation 通过统一字节源读取文件，以 Vite 独立 worker 解析有界表格；管理切表、重试、超时和析构。
 * @updated 2026-11-20T20:05:12+08:00
 */
import { useEffect, useId, useState } from 'react';
import { getSourceSize, readSourceAsArrayBuffer, type FileInfo } from '@lamberl-lee/file-preview';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import type { SpreadsheetSheet, SpreadsheetWorkerResponse } from './spreadsheet-preview.worker';

type PreviewState = {
  source: FileInfo['source'];
  attempt: number;
} & (
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; sheets: SpreadsheetSheet[] }
);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const LOAD_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSheet(value: unknown): value is SpreadsheetSheet {
  if (!isRecord(value)) return false;
  const { name, rows, columnCount, rangeTruncated, textTruncated } = value;
  if (
    typeof name !== 'string' ||
    name.length > 128 ||
    !Array.isArray(rows) ||
    rows.length > 200 ||
    typeof columnCount !== 'number' ||
    !Number.isInteger(columnCount) ||
    columnCount < 0 ||
    columnCount > 50 ||
    typeof rangeTruncated !== 'boolean' ||
    typeof textTruncated !== 'boolean'
  ) {
    return false;
  }
  let characters = 0;
  return rows.every(
    (row: unknown) =>
      Array.isArray(row) &&
      row.length === columnCount &&
      row.every((cell: unknown) => {
        if (typeof cell !== 'string' || cell.length > 2_000) return false;
        characters += cell.length;
        return characters <= 100_000;
      }),
  );
}

function isWorkerResponse(value: unknown): value is SpreadsheetWorkerResponse {
  if (!isRecord(value)) return false;
  if (value.status === 'error') {
    return typeof value.message === 'string' && value.message.length <= 500;
  }
  return (
    value.status === 'success' &&
    Array.isArray(value.sheets) &&
    value.sheets.length > 0 &&
    value.sheets.length <= 20 &&
    value.sheets.every(isSheet)
  );
}

function columnLabel(index: number): string {
  let label = '';
  for (let column = index + 1; column > 0; column = Math.floor((column - 1) / 26)) {
    label = String.fromCharCode(65 + ((column - 1) % 26)) + label;
  }
  return label;
}

export default function SpreadsheetPreview({ file }: { file: FileInfo }) {
  const { source, size } = file;
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

    function fail(message: string) {
      if (settled) return;
      settled = true;
      stop();
      setState({ source, attempt, status: 'error', message });
    }

    const timeout = window.setTimeout(() => {
      fail('读取或解析工作簿超时，请重试或使用系统应用打开原文件。');
    }, LOAD_TIMEOUT_MS);

    void (async () => {
      if (size > MAX_FILE_BYTES || (getSourceSize(source) ?? 0) > MAX_FILE_BYTES) {
        fail('文件超过 20 MB，暂不支持应用内表格预览。');
        return;
      }
      // FileVista copies arrayBuffer sources, so transferring this buffer preserves the original.
      const buffer = await readSourceAsArrayBuffer(source, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (buffer.byteLength > MAX_FILE_BYTES) {
        fail('文件超过 20 MB，暂不支持应用内表格预览。');
        return;
      }
      worker = new Worker(new URL('./spreadsheet-preview.worker.ts', import.meta.url), {
        type: 'module',
        name: 'spreadsheet-preview',
      });
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (settled) return;
        if (!isWorkerResponse(event.data)) {
          fail('工作簿预览返回了无效数据，请重试或使用系统应用打开原文件。');
          return;
        }
        if (event.data.status === 'error') {
          fail(event.data.message);
          return;
        }
        settled = true;
        stop();
        setActiveSheet('0');
        setState({ source, attempt, status: 'success', sheets: event.data.sheets });
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fail('无法启动或运行表格预览，请重试或使用系统应用打开原文件。');
      };
      worker.onmessageerror = () => {
        fail('无法接收工作簿预览，请重试或使用系统应用打开原文件。');
      };
      worker.postMessage(buffer, [buffer]);
    })().catch(() => fail('无法加载工作簿，请重试或使用系统应用打开原文件。'));

    return () => {
      settled = true;
      stop();
    };
  }, [source, size, attempt]);

  if (state.source !== source || state.attempt !== attempt || state.status === 'loading') {
    return (
      <div className="p-6 text-sm text-muted-foreground" role="status" aria-live="polite">
        正在读取工作簿…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-3 p-6 text-sm">
        <p role="alert">{state.message}</p>
        <p className="text-muted-foreground">可关闭预览，使用系统应用查看原文件。</p>
        <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
          重试
        </Button>
      </div>
    );
  }

  const sheet = state.sheets[Number(activeSheet)] ?? state.sheets[0];
  if (!sheet)
    return <p className="p-6 text-sm text-muted-foreground">工作簿中没有可预览的工作表。</p>;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <label htmlFor={selectId} className="text-sm text-muted-foreground">
          工作表
        </label>
        <Select value={activeSheet} onValueChange={setActiveSheet}>
          <SelectTrigger id={selectId} size="sm" className="max-w-80 min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>
              {state.sheets.map((item, index) => (
                <SelectItem key={index} value={String(index)} title={item.name}>
                  {item.name || `工作表 ${index + 1}`}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {sheet.rows.length} 行 × {sheet.columnCount} 列 · 共 {state.sheets.length} 个工作表
        </p>
      </div>
      {sheet.rangeTruncated || sheet.textTruncated ? (
        <p
          role="status"
          className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground"
        >
          {sheet.rangeTruncated ? '仅预览前 200 行、50 列。' : ''}
          {sheet.textTruncated ? '部分单元格文本已截短。' : ''}
          完整内容请使用系统应用打开原文件。
        </p>
      ) : null}
      {sheet.rows.length && sheet.columnCount ? (
        <div
          key={activeSheet}
          role="region"
          aria-label={`${sheet.name} 工作表内容`}
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
                  <span className="sr-only">行号</span>
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
                    {rowIndex + 1}
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
        <p className="p-6 text-sm text-muted-foreground">（空工作表）</p>
      )}
      <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        公式显示文件中已保存的结果，不重新计算；图表、图片和原始排版请使用系统应用查看。
      </p>
    </div>
  );
}

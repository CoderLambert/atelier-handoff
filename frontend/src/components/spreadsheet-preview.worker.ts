/**
 * @file 在独立 worker 中读取 XLS/XLSX，生成有界的纯文本预览。
 * @implementation 使用 SheetJS CE 读取已保存的单元格值；限制输入、工作表、行列和文本，不计算公式或输出 HTML。
 * @updated 2026-11-20T20:05:12+08:00
 */
import { read, utils, type CellObject, type WorkSheet } from 'xlsx';
import { documentPreviewBytes } from '@shared/document-attachments';

export type SpreadsheetSheet = {
  name: string;
  rows: string[][];
  columnCount: number;
  rangeTruncated: boolean;
  textTruncated: boolean;
};

export type SpreadsheetErrorCode = 'tooLarge' | 'noSheets' | 'tooManySheets' | 'parseFailed';

export type SpreadsheetWorkerResponse =
  | { status: 'success'; sheets: SpreadsheetSheet[] }
  | { status: 'error'; code: SpreadsheetErrorCode };

const MAX_FILE_BYTES = documentPreviewBytes;
const MAX_SHEETS = 20;
const MAX_ROWS = 200;
const MAX_COLUMNS = 50;
const MAX_CELL_CHARACTERS = 2_000;
const MAX_SHEET_CHARACTERS = 100_000;

function previewSheet(name: string, sheet: WorkSheet): SpreadsheetSheet {
  // !fullref preserves the original dimensions when sheetRows clips a worksheet.
  const fullReference: unknown = sheet['!fullref'];
  const reference = typeof fullReference === 'string' ? fullReference : sheet['!ref'];
  // Blank BIFF sheets may declare A1 without containing a cell.
  const hasRange = sheet['!data']?.length || typeof fullReference === 'string';
  const range = reference && hasRange ? utils.decode_range(reference) : undefined;
  if (
    range &&
    (!Number.isSafeInteger(range.e.r) ||
      !Number.isSafeInteger(range.e.c) ||
      range.e.r < 0 ||
      range.e.c < 0)
  ) {
    throw new Error('Invalid worksheet dimensions');
  }
  const rowCount = range ? Math.min(range.e.r + 1, MAX_ROWS) : 0;
  const columnCount = range ? Math.min(range.e.c + 1, MAX_COLUMNS) : 0;
  let charactersLeft = MAX_SHEET_CHARACTERS;
  let textTruncated = false;

  function cellText(cell: CellObject | undefined): string {
    if (!cell) return '';
    const value: unknown = cell.v;
    const text =
      typeof cell.w === 'string'
        ? cell.w
        : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : '';
    const limit = Math.min(MAX_CELL_CHARACTERS, charactersLeft);
    const clipped = text.length > limit;
    textTruncated ||= clipped;
    const result = clipped ? (limit > 0 ? `${text.slice(0, limit - 1)}…` : '') : text;
    charactersLeft -= result.length;
    return result;
  }

  return {
    name: name.slice(0, 128),
    rows: Array.from({ length: rowCount }, (_, row) =>
      Array.from({ length: columnCount }, (_, column) => cellText(sheet['!data']?.[row]?.[column])),
    ),
    columnCount,
    rangeTruncated: !!range && (range.e.r >= MAX_ROWS || range.e.c >= MAX_COLUMNS),
    textTruncated,
  };
}

self.onmessage = (event: MessageEvent<unknown>) => {
  let response: SpreadsheetWorkerResponse;
  try {
    if (!(event.data instanceof ArrayBuffer) || !event.data.byteLength) {
      throw new Error('Empty or invalid spreadsheet input');
    }
    if (event.data.byteLength > MAX_FILE_BYTES) {
      response = { status: 'error', code: 'tooLarge' };
    } else {
      const options = {
        type: 'array' as const,
        dense: true,
        cellFormula: false,
        cellHTML: false,
        cellStyles: false,
        cellText: true,
        bookVBA: false,
        bookDeps: false,
        bookFiles: false,
        sheetRows: MAX_ROWS,
      };
      // XLS ignores the sheets option. Check metadata first so extra sheets are never parsed.
      const metadata = read(event.data, { ...options, bookSheets: true });
      if (!metadata.SheetNames.length) {
        response = { status: 'error', code: 'noSheets' };
      } else if (metadata.SheetNames.length > MAX_SHEETS) {
        response = {
          status: 'error',
          code: 'tooManySheets',
        };
      } else {
        const workbook = read(event.data, options);
        // Enforce the same bound after the full read, including formats with limited metadata support.
        if (!workbook.SheetNames.length || workbook.SheetNames.length > MAX_SHEETS) {
          throw new Error('Invalid worksheet count');
        }
        response = {
          status: 'success',
          sheets: workbook.SheetNames.map((name) => {
            const sheet = workbook.Sheets[name];
            if (!sheet) throw new Error('Missing worksheet');
            return previewSheet(name, sheet);
          }),
        };
      }
    }
  } catch {
    response = {
      status: 'error',
      code: 'parseFailed',
    };
  }
  self.postMessage(response);
};

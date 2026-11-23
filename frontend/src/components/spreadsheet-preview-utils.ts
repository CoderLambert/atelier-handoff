/**
 * @file 表格预览校验、状态与列标计算工具。
 * @implementation 提供 Worker 响应守卫、表格结构类型断言及 Excel 列名字母转换。
 * @updated 2026-11-23T18:25:00+08:00
 */
import type { FileInfo } from '@lamberl-lee/file-preview';
import type {
  SpreadsheetErrorCode,
  SpreadsheetSheet,
  SpreadsheetWorkerResponse,
} from './spreadsheet-preview.worker';

export const workerErrorKeys = {
  tooLarge: 'spreadsheet.tooLarge',
  noSheets: 'spreadsheet.noSheets',
  tooManySheets: 'spreadsheet.tooManySheets',
  parseFailed: 'spreadsheet.parseFailed',
} as const satisfies Record<SpreadsheetErrorCode, string>;

export type SpreadsheetMessageKey =
  | (typeof workerErrorKeys)[SpreadsheetErrorCode]
  | 'spreadsheet.timeout'
  | 'spreadsheet.invalidResponse'
  | 'spreadsheet.workerFailed'
  | 'spreadsheet.messageFailed'
  | 'spreadsheet.loadFailed';

export type PreviewState = {
  source: FileInfo['source'];
  attempt: number;
} & (
  | { status: 'loading' }
  | { status: 'error'; messageKey: SpreadsheetMessageKey }
  | { status: 'success'; sheets: SpreadsheetSheet[] }
);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSheet(value: unknown): value is SpreadsheetSheet {
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

export function isWorkerResponse(value: unknown): value is SpreadsheetWorkerResponse {
  if (!isRecord(value)) return false;
  if (value.status === 'error') {
    return typeof value.code === 'string' && Object.hasOwn(workerErrorKeys, value.code);
  }
  return (
    value.status === 'success' &&
    Array.isArray(value.sheets) &&
    value.sheets.length > 0 &&
    value.sheets.length <= 20 &&
    value.sheets.every(isSheet)
  );
}

export function columnLabel(index: number): string {
  let label = '';
  for (let column = index + 1; column > 0; column = Math.floor((column - 1) / 26)) {
    label = String.fromCharCode(65 + ((column - 1) % 26)) + label;
  }
  return label;
}

/**
 * @file 定义本地文档解析 worker 的数据契约与资源预算。
 * @implementation 共享 MIME、消息 schema 和解析预算；解析文本保留在私有文件中，仅返回短预览。
 * @updated 2026-11-21T15:30:00+08:00
 */
import { z } from 'zod';

export const documentMimeSchema = z.enum([
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// These are parser working budgets, independent of upload and renderer preview limits.
export const documentParserLimits = {
  timeoutMs: 60_000,
  oldGenerationMb: 512,
  sourceBytes: 256 * 1024 * 1024,
  zipEntries: 20_000,
  zipEntryBytes: 128 * 1024 * 1024,
  zipExpandedBytes: 256 * 1024 * 1024,
  zipExpansionRatio: 1000,
  outputBytes: 128 * 1024 * 1024,
  worksheets: 1000,
  cells: 2_000_000,
  pdfPages: 10_000,
  lineCharacters: 1600,
  previewCharacters: 6000,
} as const;

export const documentJobSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('validate'), path: z.string(), mime: documentMimeSchema }),
  z.object({
    operation: z.literal('prepare'),
    path: z.string(),
    mime: documentMimeSchema,
    directory: z.string(),
  }),
]);

const fileSchema = z.object({
  name: z.string().regex(/^(?:document|sheet-\d{4})\.txt$/),
  description: z.string().max(3000),
});
export const documentReplySchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    files: z.array(fileSchema).max(documentParserLimits.worksheets),
    preview: z.string().max(documentParserLimits.previewCharacters),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'DOCUMENT_INVALID',
      'DOCUMENT_PASSWORD_REQUIRED',
      'DOCUMENT_NO_TEXT',
      'DOCUMENT_RESOURCE_LIMIT',
      'DOCUMENT_WRITE_FAILED',
    ]),
    message: z.string().max(3000),
  }),
]);
export type DocumentJob = z.infer<typeof documentJobSchema>;
export type DocumentReply = z.infer<typeof documentReplySchema>;
export type DocumentFailureCode = Extract<DocumentReply, { ok: false }>['code'];

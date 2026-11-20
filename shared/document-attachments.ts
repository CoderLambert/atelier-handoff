/**
 * @file 定义会话文档附件的类型和预览预算。
 * @implementation 共享文件名、MIME 匹配及表格预览大小，独立于原件保存。
 * @updated 2026-11-21T00:00:00+08:00
 */
const documentTypes = {
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;
export type DocumentAttachmentMime = (typeof documentTypes)[keyof typeof documentTypes];
export const documentPreviewBytes = 20 * 1024 * 1024;

export function documentAttachmentMime(name: string): DocumentAttachmentMime | undefined {
  const extension = /\.(xls|xlsx|pdf|docx)$/iu.exec(name)?.[1]?.toLowerCase();
  if (extension === 'xls' || extension === 'xlsx' || extension === 'pdf' || extension === 'docx')
    return documentTypes[extension];
}

export function isDocumentAttachmentMime(mime: string): mime is DocumentAttachmentMime {
  return Object.values<string>(documentTypes).includes(mime);
}

export function spreadsheetAttachmentMime(mime: string): boolean {
  return mime === documentTypes.xls || mime === documentTypes.xlsx;
}

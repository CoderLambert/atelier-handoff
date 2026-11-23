/**
 * @file 文件预览插件注册与数据结构适配。
 * @implementation 构造 FileVista 插件注册表，并将附件、交付物和 ArrayBuffer 映射为标准 FileInfo。
 * @updated 2026-11-23T18:25:00+08:00
 */
import { getTranslator } from '@/i18n';
import {
  createPreviewPluginRegistry,
  csvPlugin,
  imagePlugin,
  markdownPlugin,
  sourceCodePlugin,
  textPlugin,
  type FileInfo,
  type PreviewError,
} from '@lamberl-lee/file-preview';
import { pdfPlugin } from '@lamberl-lee/file-preview/plugins/pdf';

export type PreviewFile = (
  | { name: string; text: string }
  | { name: string; size: number; url: string }
  | { name: string; bytes: ArrayBuffer; mimeType: string }
) & { id?: string; onError?: (error: PreviewError) => void };

export function previewRegistry() {
  const t = getTranslator('inspector');
  return createPreviewPluginRegistry([
    sourceCodePlugin,
    textPlugin,
    csvPlugin,
    markdownPlugin,
    pdfPlugin,
    imagePlugin,
    {
      id: 'atelier.spreadsheet',
      name: t('preview.spreadsheetPlugin'),
      match: (file) => file.fileType === 'xlsx' || file.fileType === 'xls',
      load: () => import('./spreadsheet-preview'),
    },
  ]);
}

const markdownFile = /\.(?:md|markdown)$/i;
const sourceFile = /\.(?:[cm]?[jt]sx?|css|html?|json|py|sh|sql|toml|xml|ya?ml)$/i;

export function toFileInfo(file: PreviewFile): FileInfo {
  const { name } = file;
  if ('url' in file) {
    return {
      id: file.id ?? file.url,
      name,
      size: file.size,
      type: 'application/pdf',
      fileType: 'pdf',
      source: { kind: 'url', url: file.url, name },
    };
  }
  if ('bytes' in file) {
    const { mimeType, bytes } = file;
    return {
      id: file.id ?? name,
      name,
      size: bytes.byteLength,
      type: mimeType,
      fileType:
        mimeType === 'application/pdf'
          ? 'pdf'
          : mimeType.startsWith('image/')
            ? 'image'
            : mimeType === 'application/vnd.ms-excel'
              ? 'xls'
              : 'xlsx',
      source: { kind: 'arrayBuffer', buffer: bytes, name, mimeType },
    };
  }
  const markdown = markdownFile.test(name);
  const blob = new Blob([file.text], { type: markdown ? 'text/markdown' : 'text/plain' });
  const simpleCsv = /\.csv$/i.test(name) && !file.text.includes('"');
  return {
    id: file.id ?? name,
    name,
    size: blob.size,
    type: blob.type,
    fileType: markdown ? 'markdown' : simpleCsv ? 'csv' : sourceFile.test(name) ? 'code' : 'text',
    source: { kind: 'blob', blob, name },
  };
}

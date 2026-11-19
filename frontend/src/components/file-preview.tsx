import { useMemo } from 'react';
import {
  PluginPreviewRenderer,
  createPreviewPluginRegistry,
  csvPlugin,
  markdownPlugin,
  sourceCodePlugin,
  textPlugin,
  type FileInfo,
} from '@lamberl-lee/file-preview';
import { pdfPlugin } from '@lamberl-lee/file-preview/plugins/pdf';
import '@lamberl-lee/file-preview/styles/index.css';

type PreviewFile = { name: string; text: string } | { name: string; size: number; url: string };

const registry = createPreviewPluginRegistry([
  sourceCodePlugin,
  textPlugin,
  csvPlugin,
  markdownPlugin,
  pdfPlugin,
]);
const markdownFile = /\.(?:md|markdown)$/i;
const sourceFile = /\.(?:[cm]?[jt]sx?|css|html?|json|py|sh|sql|toml|xml|ya?ml)$/i;

function toFileInfo(file: PreviewFile): FileInfo {
  const { name } = file;
  if ('url' in file) {
    return {
      id: file.url,
      name,
      size: file.size,
      type: 'application/pdf',
      fileType: 'pdf',
      source: { kind: 'url', url: file.url, name },
    };
  }
  const markdown = markdownFile.test(name);
  const blob = new Blob([file.text], { type: markdown ? 'text/markdown' : 'text/plain' });
  // FileVista's CSV parser splits on newlines before interpreting quotes.
  const simpleCsv = /\.csv$/i.test(name) && !file.text.includes('"');
  return {
    id: name,
    name,
    size: blob.size,
    type: blob.type,
    fileType: markdown ? 'markdown' : simpleCsv ? 'csv' : sourceFile.test(name) ? 'code' : 'text',
    source: { kind: 'blob', blob, name },
  };
}

export default function FilePreview(file: PreviewFile) {
  const text = 'text' in file ? file.text : undefined;
  const url = 'url' in file ? file.url : undefined;
  const size = 'size' in file ? file.size : undefined;
  const { name } = file;
  const info = useMemo(
    () =>
      toFileInfo(url === undefined ? { name, text: text ?? '' } : { name, url, size: size ?? 0 }),
    [name, size, text, url],
  );
  if (text === '') return <p className="p-4">（空文件）</p>;
  return <PluginPreviewRenderer key={info.id} file={info} registry={registry} />;
}

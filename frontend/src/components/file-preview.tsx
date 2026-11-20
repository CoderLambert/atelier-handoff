/**
 * @file 复用 FileVista 渲染聊天附件、交付物和本地下载。
 * @implementation 按来源及可选文件 ID 构造预览数据，注册适用插件，支持可选失败回调，并在 Markdown 中单独展示结构化元数据。
 * @updated 2026-11-21T00:00:00+08:00
 */
import { useMemo, useState } from 'react';
import { Markdown } from '@atelier/markdown';
import '@atelier/markdown/style.css';
import { readMarkdownFrontmatter } from './markdown-frontmatter';
import {
  PluginPreviewRenderer,
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
import '@lamberl-lee/file-preview/styles/index.css';

type PreviewFile = (
  | { name: string; text: string }
  | { name: string; size: number; url: string }
  | { name: string; bytes: ArrayBuffer; mimeType: string }
) & { id?: string; onError?: (error: PreviewError) => void };

const registry = createPreviewPluginRegistry([
  sourceCodePlugin,
  textPlugin,
  csvPlugin,
  markdownPlugin,
  pdfPlugin,
  imagePlugin,
  {
    id: 'atelier.spreadsheet',
    name: '电子表格预览',
    match: (file) => file.fileType === 'xlsx' || file.fileType === 'xls',
    load: () => import('./spreadsheet-preview'),
  },
]);
const markdownFile = /\.(?:md|markdown)$/i;
const sourceFile = /\.(?:[cm]?[jt]sx?|css|html?|json|py|sh|sql|toml|xml|ya?ml)$/i;

function toFileInfo(file: PreviewFile): FileInfo {
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
  // FileVista's CSV parser splits on newlines before interpreting quotes.
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

function FrontmatterPreview({
  file,
  frontmatter,
  onError,
}: {
  file: FileInfo;
  frontmatter: NonNullable<ReturnType<typeof readMarkdownFrontmatter>>;
  onError?: (error: PreviewError) => void;
}) {
  const { body, fields } = frontmatter;
  const [source, setSource] = useState(false);

  return (
    <div className="fv-markdown">
      <div className="fv-view-mode-bar">
        <div className="fv-view-mode-group" role="group" aria-label="文件视图">
          <button
            type="button"
            className={`fv-view-mode-btn${source ? '' : ' fv-view-mode-btn--active'}`}
            aria-pressed={!source}
            onClick={() => setSource(false)}
          >
            预览
          </button>
          <button
            type="button"
            className={`fv-view-mode-btn${source ? ' fv-view-mode-btn--active' : ''}`}
            aria-pressed={source}
            onClick={() => setSource(true)}
          >
            源码
          </button>
        </div>
      </div>
      {source ? (
        <PluginPreviewRenderer
          file={{ ...file, fileType: 'code' }}
          registry={registry}
          onError={onError}
        />
      ) : (
        <div className="fv-markdown__preview">
          <section className="markdown-metadata" aria-label="文档元数据">
            <h2>文档元数据</h2>
            <dl>
              {fields.map(({ key, value, structured }, index) => (
                <div key={index}>
                  <dt>{key}</dt>
                  <dd>{structured ? <pre>{value}</pre> : value}</dd>
                </div>
              ))}
            </dl>
          </section>
          {body.trim() ? <Markdown text={body} className="fv-prose" /> : '（无正文）'}
        </div>
      )}
    </div>
  );
}

export default function FilePreview(file: PreviewFile) {
  const text = 'text' in file ? file.text : undefined;
  const url = 'url' in file ? file.url : undefined;
  const size = 'size' in file ? file.size : undefined;
  const bytes = 'bytes' in file ? file.bytes : undefined;
  const mimeType = 'mimeType' in file ? file.mimeType : undefined;
  const { id, name, onError } = file;
  const content = useMemo(
    () =>
      bytes && (mimeType?.startsWith('text/') || mimeType === 'application/json')
        ? new TextDecoder().decode(bytes)
        : text,
    [bytes, mimeType, text],
  );
  const info = useMemo(() => {
    if (url !== undefined) return toFileInfo({ id, name, url, size: size ?? 0 });
    if (bytes && mimeType && content === undefined)
      return toFileInfo({ id, name, bytes, mimeType });
    return toFileInfo({ id, name, text: content ?? '' });
  }, [id, name, url, size, bytes, mimeType, content]);
  const frontmatter = useMemo(
    () =>
      info.fileType === 'markdown' && content !== undefined
        ? readMarkdownFrontmatter(content)
        : undefined,
    [info.fileType, content],
  );
  if (content === '' || bytes?.byteLength === 0) return <p className="p-4">（空文件）</p>;
  if (frontmatter)
    return (
      <FrontmatterPreview key={info.id} file={info} frontmatter={frontmatter} onError={onError} />
    );
  return <PluginPreviewRenderer key={info.id} file={info} registry={registry} onError={onError} />;
}

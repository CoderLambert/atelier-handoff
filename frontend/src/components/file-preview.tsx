/**
 * @file 复用 FileVista 渲染聊天附件、交付物和本地下载。
 * @implementation 按来源及可选文件 ID 构造预览数据，注册适用插件，支持可选失败回调，并在 Markdown 中单独展示结构化元数据。
 * @updated 2026-11-21T00:00:00+08:00
 */
import { useUiTranslation, getTranslator } from '@/i18n';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@atelier/markdown';
import '@atelier/markdown/style.css';
import { readMarkdownFrontmatter } from './markdown-frontmatter';
import {
  PluginPreviewRenderer,
  LocaleProvider,
  zhCN,
  enUS,
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
import {
  previewRegistry,
  toFileInfo,
  type PreviewFile,
} from './file-preview-utils';

export type { PreviewFile } from './file-preview-utils';

function FrontmatterPreview({
  file,
  frontmatter,
  onError,
}: {
  file: FileInfo;
  frontmatter: NonNullable<ReturnType<typeof readMarkdownFrontmatter>>;
  onError?: (error: PreviewError) => void;
}) {
  const { t, locale } = useUiTranslation('inspector');
  const registry = useMemo(() => previewRegistry(), [locale]);
  const { body, fields } = frontmatter;
  const [source, setSource] = useState(false);

  return (
    <div className="fv-markdown">
      <div className="fv-view-mode-bar">
        <div className="fv-view-mode-group" role="group" aria-label={t('preview.fileViews')}>
          <Button
            size="xs"
            variant={source ? 'ghost' : 'secondary'}
            aria-pressed={!source}
            onClick={() => setSource(false)}
          >
            {t('common.preview')}
          </Button>
          <Button
            size="xs"
            variant={source ? 'secondary' : 'ghost'}
            aria-pressed={source}
            onClick={() => setSource(true)}
          >
            {t('common.source')}
          </Button>
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
          <section className="markdown-metadata" aria-label={t('preview.metadata')}>
            <h2>{t('preview.metadata')}</h2>
            <dl>
              {fields.map(({ key, value, structured }, index) => (
                <div key={index}>
                  <dt>{key}</dt>
                  <dd>{structured ? <pre>{value}</pre> : value}</dd>
                </div>
              ))}
            </dl>
          </section>
          {body.trim() ? (
            <Markdown text={body} locale={locale} className="fv-prose" />
          ) : (
            t('preview.noBody')
          )}
        </div>
      )}
    </div>
  );
}

function FilePreviewContent(file: PreviewFile) {
  const { t, locale } = useUiTranslation('inspector');
  const registry = useMemo(() => previewRegistry(), [locale]);
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
  if (content === '' || bytes?.byteLength === 0)
    return <p className="p-4">{t('common.emptyFile')}</p>;
  if (frontmatter)
    return (
      <FrontmatterPreview key={info.id} file={info} frontmatter={frontmatter} onError={onError} />
    );
  return <PluginPreviewRenderer key={info.id} file={info} registry={registry} onError={onError} />;
}

export default function FilePreview(file: PreviewFile) {
  const { t, locale } = useUiTranslation('inspector');
  const messages = useMemo(
    () =>
      locale === 'en'
        ? enUS
        : {
            ...zhCN,
            loadingEbook: t('preview.loadingEbook'),
            noChaptersFound: t('preview.noChapters'),
            ebookLoadFailed: t('preview.ebookLoadFailed'),
            tableOfContents: t('preview.tableOfContents'),
            foundInChapters: t('preview.foundInChapters', { chapters: '{count}' }),
          },
    [t, locale],
  );
  return (
    <LocaleProvider value={messages}>
      <FilePreviewContent {...file} />
    </LocaleProvider>
  );
}

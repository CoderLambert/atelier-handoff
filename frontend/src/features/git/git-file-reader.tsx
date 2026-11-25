/**
 * @file 显示 Git 阅读标签中的完整文件和来源。
 * @implementation 复用文本查询与代码高亮，提供行号、代码选区引用、文本与路径复制及滚动恢复。
 * @updated 2026-11-25T17:22:06+08:00
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Copy, Link2, Quote, RefreshCw } from 'lucide-react';
import { loadCodeHighlighter, type HighlightResult } from '@atelier/markdown';
import { Button } from '@/components/ui/button';
import { translateError, useUiTranslation } from '@/i18n';
import { useGitFileContent } from '@/use-query/git/use-git-file-content';
import { HighlightedLine, languageForPath } from './git-diff';
import { GitRevealFileButton } from './git-file-actions';
import type { GitOpenFile } from './git-open-file';
import { readGitCodeSelection, type QuoteGitCode } from './git-code-selection';

export type GitReaderScroll = { left: number; top: number };

function SourceViewport({
  path,
  text,
  position,
  onScroll,
  code,
}: {
  path: string;
  text: string;
  position?: GitReaderScroll;
  onScroll: (position: GitReaderScroll) => void;
  code: RefObject<HTMLElement | null>;
}) {
  const { t } = useUiTranslation('git');
  const viewport = useRef<HTMLDivElement>(null);
  const initial = useRef(position);
  useLayoutEffect(() => {
    if (initial.current) viewport.current?.scrollTo(initial.current);
  }, []);

  const source = text.replace(/\r\n/gu, '\n');
  const lines = useMemo(() => source.replace(/\n$/u, '').split('\n'), [source]);
  const numbers = useMemo(() => lines.map((_, index) => index + 1).join('\n'), [lines]);
  const [highlight, setHighlight] = useState<{ text: string; tokens: HighlightResult['tokens'] }>();
  useEffect(() => {
    const languageId = languageForPath(path);
    if (!languageId || source.length > 80_000 || lines.length > 3000) return;
    let active = true;
    void loadCodeHighlighter()
      .then((highlighter) => {
        const language = highlighter.getSupportedLanguages().find((item) => item === languageId);
        if (!active || !language) return;
        const receive = ({ tokens }: HighlightResult) => {
          if (active) setHighlight({ text: source, tokens });
        };
        const cached = highlighter.highlight(
          { code: source, language, themes: highlighter.getThemes() },
          receive,
        );
        if (cached) receive(cached);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [path, source, lines.length]);

  return (
    <div
      className="git-reader-viewport"
      ref={viewport}
      role="region"
      tabIndex={0}
      aria-label={t('diff.fileReader')}
      onScroll={({ currentTarget }) => {
        onScroll({ top: currentTarget.scrollTop, left: currentTarget.scrollLeft });
      }}
    >
      <div className="git-reader-source">
        <pre className="git-reader-numbers" aria-hidden="true">
          {numbers}
        </pre>
        <pre className="git-reader-code">
          <code ref={code}>
            {highlight?.text === source
              ? lines.map((line, index) => (
                  <Fragment key={index}>
                    {index > 0 ? '\n' : null}
                    <HighlightedLine text={line} tokens={highlight.tokens[index]} />
                  </Fragment>
                ))
              : lines.length === 1
                ? lines[0]
                : source.replace(/\n$/u, '')}
          </code>
        </pre>
      </div>
    </div>
  );
}

export function GitFileReader({
  projectId,
  file,
  position,
  onScroll,
  showToast,
  onQuoteCode,
  checkout,
}: {
  projectId: string;
  file: GitOpenFile;
  position?: GitReaderScroll;
  onScroll: (position: GitReaderScroll) => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
  onQuoteCode?: QuoteGitCode;
  checkout?: string;
}) {
  const { t } = useUiTranslation('git');
  const { target, worktreeId, revealPath } = file;
  const content = useGitFileContent(projectId, target);
  const sourceLabel = t(`diff.source.${target.source}`);
  const revision = target.kind === 'history' ? target.commitOid : undefined;
  const code = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<ReturnType<typeof readGitCodeSelection>>();
  const canQuote = Boolean(onQuoteCode);
  function quoteCode() {
    const excerpt = code.current && readGitCodeSelection(code.current, window.getSelection());
    if (!excerpt || !onQuoteCode) return;
    const { text, startLine, endLine } = excerpt;
    const result = onQuoteCode(
      {
        path: target.path,
        startLine,
        endLine,
        version: target.source,
        revision,
        checkout: revision ? undefined : checkout,
      },
      text,
    );
    if (result === 'added' || result === 'duplicate') {
      window.getSelection()?.removeAllRanges();
      setSelection(undefined);
      if (result === 'added') showToast(t('diff.quoteAdded'), 'success');
    } else {
      showToast(t(`diff.quoteError.${result}`), 'error');
    }
  }
  useEffect(() => {
    if (!canQuote) return;
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setSelection(
          code.current ? readGitCodeSelection(code.current, window.getSelection()) : undefined,
        ),
      );
    };
    document.addEventListener('selectionchange', read);
    read();
    return () => {
      document.removeEventListener('selectionchange', read);
      cancelAnimationFrame(frame);
    };
  }, [canQuote, content.data?.text]);

  const copy = async (text: string, kind: 'file' | 'path') => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t(kind === 'path' ? 'diff.pathCopied' : 'diff.fileCopied'), 'success');
    } catch {
      showToast(t(kind === 'path' ? 'diff.pathCopyFailed' : 'diff.fileCopyFailed'), 'error');
    }
  };

  return (
    <div
      className="git-file-reader"
      onKeyDown={(event) => {
        if (
          !canQuote ||
          !selection ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.repeat ||
          !event.altKey ||
          !event.shiftKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.code !== 'KeyQ'
        )
          return;
        event.preventDefault();
        quoteCode();
      }}
    >
      <div className="git-reader-toolbar">
        <div className="git-reader-location">
          <span
            className="git-reader-version"
            title={revision ? sourceLabel + ' · ' + revision : sourceLabel}
          >
            {sourceLabel}
            {revision ? ' ' + revision.slice(0, 8) : ''}
          </span>
          <span className="git-reader-path" title={target.path}>
            {target.path}
          </span>
        </div>
        <div className="git-file-actions">
          {canQuote && selection ? (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onMouseDown={(event) => event.preventDefault()}
              aria-keyshortcuts="Alt+Shift+Q"
              title={t('diff.quoteCodeHint')}
              onClick={quoteCode}
            >
              <Quote data-icon="inline-start" aria-hidden="true" />
              {t('diff.quoteCode')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={t('diff.copyPath')}
            aria-label={t('diff.copyPath')}
            onClick={() => void copy(target.path, 'path')}
          >
            <Link2 aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={t('diff.copyFile')}
            aria-label={t('diff.copyFile')}
            disabled={!content.data}
            onClick={() => content.data && void copy(content.data.text, 'file')}
          >
            <Copy aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={t('diff.refreshFile')}
            aria-label={t('diff.refreshFile')}
            disabled={content.isFetching}
            onClick={() => void content.refetch()}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
          <GitRevealFileButton
            projectId={projectId}
            worktreeId={worktreeId}
            path={revealPath}
            onRevealFailed={showToast}
          />
        </div>
      </div>
      {content.error ? (
        <div role="alert" className="git-feedback">
          <p>{translateError(content.error, t('diff.fullFileFailed'))}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void content.refetch()}>
            {t('board.retry')}
          </Button>
        </div>
      ) : !content.data ? (
        <p role="status" className="git-feedback">
          {t('board.loading')}
        </p>
      ) : content.data.text === '' ? (
        <p className="git-feedback">{t('diff.emptyFile')}</p>
      ) : (
        <SourceViewport
          path={target.path}
          text={content.data.text}
          position={position}
          onScroll={onScroll}
          code={code}
        />
      )}
    </div>
  );
}

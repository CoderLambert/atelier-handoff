/**
 * @file 显示 Git 阅读标签中的完整文件和来源。
 * @implementation 复用文本查询、代码高亮与 Markdown 渲染，提供预览/源码切换、自动换行、行号、文件内搜索、代码选区引用与滚动恢复。
 * @updated 2026-11-27T23:04:00+08:00
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Eye,
  Link2,
  Quote,
  RefreshCw,
  Search,
  WrapText,
  X,
} from 'lucide-react';
import { loadCodeHighlighter, Markdown, type HighlightResult } from '@atelier/markdown';
import '@atelier/markdown/style.css';
import '@/components/file-preview.css';
import { readMarkdownFrontmatter } from '@/components/markdown-frontmatter';
import { Button } from '@/components/ui/button';
import { translateError, useUiTranslation } from '@/i18n';
import { useGitFileContent } from '@/use-query/git/use-git-file-content';
import { languageForPath } from './git-diff';
import { GitRevealFileButton } from './git-file-actions';
import {
  clearDomMatches,
  findLineMatches,
  highlightDomMatches,
  isMarkdownPath,
  setActiveDomMatch,
  splitLineTokensWithMatches,
  type LineMatch,
} from './git-file-search';
import type { GitOpenFile } from './git-open-file';
import { readGitCodeSelection, type QuoteGitCode } from './git-code-selection';

export type GitReaderScroll = { left: number; top: number };

type TokenStyle = CSSProperties & {
  '--git-token-light'?: string;
  '--git-token-dark'?: string;
};

function SearchableLine({
  text,
  tokens,
  matches,
  activeMatchIndex,
}: {
  text: string;
  tokens: HighlightResult['tokens'][number] | undefined;
  matches: readonly LineMatch[];
  activeMatchIndex: number;
}) {
  const slices = splitLineTokensWithMatches(text, tokens, matches);
  return slices.map((slice, index) => {
    const inner = slice.htmlStyle ? (
      <span
        className="git-syntax-token"
        style={
          {
            '--git-token-light': slice.htmlStyle.color,
            '--git-token-dark': slice.htmlStyle['--shiki-dark'],
          } as TokenStyle
        }
      >
        {slice.content}
      </span>
    ) : (
      slice.content
    );
    if (slice.matchIndex !== undefined) {
      return (
        <mark
          key={index}
          className="git-search-match"
          data-git-search-mark={slice.matchIndex}
          data-active={slice.matchIndex === activeMatchIndex ? 'true' : undefined}
        >
          {inner}
        </mark>
      );
    }
    return <Fragment key={index}>{inner}</Fragment>;
  });
}

function SourceViewport({
  path,
  lines,
  position,
  onScroll,
  code,
  wordWrap,
  matchesByLine,
  activeMatchIndex,
  searchActive,
}: {
  path: string;
  lines: readonly string[];
  position?: GitReaderScroll;
  onScroll: (position: GitReaderScroll) => void;
  code: RefObject<HTMLElement | null>;
  wordWrap: boolean;
  matchesByLine: ReadonlyMap<number, LineMatch[]>;
  activeMatchIndex: number;
  searchActive: boolean;
}) {
  const { t } = useUiTranslation('git');
  const viewport = useRef<HTMLDivElement>(null);
  const initial = useRef(position);
  useLayoutEffect(() => {
    if (initial.current) viewport.current?.scrollTo(initial.current);
  }, []);

  const source = useMemo(() => lines.join('\n'), [lines]);
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

  useEffect(() => {
    if (!searchActive) return;
    const activeEl = viewport.current?.querySelector<HTMLElement>('mark[data-active="true"]');
    activeEl?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [searchActive, activeMatchIndex, matchesByLine]);

  const activeTokens = highlight?.text === source ? highlight.tokens : undefined;

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
      <div className="git-reader-source" data-wrap={wordWrap ? 'true' : undefined}>
        {!wordWrap ? (
          <pre className="git-reader-numbers" aria-hidden="true">
            {numbers}
          </pre>
        ) : null}
        <pre className="git-reader-code">
          <code ref={code}>
            {lines.map((line, index) => {
              const lineMatches = matchesByLine.get(index) ?? [];
              const tokens = activeTokens?.[index];
              const renderedLine = (
                <SearchableLine
                  text={line}
                  tokens={tokens}
                  matches={lineMatches}
                  activeMatchIndex={activeMatchIndex}
                />
              );
              if (wordWrap) {
                return (
                  <Fragment key={index}>
                    {index > 0 ? '\n' : null}
                    <span className="git-reader-wrap-line" data-line={index + 1}>
                      {renderedLine}
                    </span>
                  </Fragment>
                );
              }
              return (
                <Fragment key={index}>
                  {index > 0 ? '\n' : null}
                  {renderedLine}
                </Fragment>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}

function MarkdownPreviewViewport({
  text,
  position,
  onScroll,
  searchQuery,
  caseSensitive,
  activeMatchIndex,
  onMatchCountChange,
}: {
  text: string;
  position?: GitReaderScroll;
  onScroll: (position: GitReaderScroll) => void;
  searchQuery: string;
  caseSensitive: boolean;
  activeMatchIndex: number;
  onMatchCountChange: (count: number) => void;
}) {
  const { t, locale } = useUiTranslation('git');
  const viewport = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const initial = useRef(position);
  useLayoutEffect(() => {
    if (initial.current) viewport.current?.scrollTo(initial.current);
  }, []);

  const frontmatter = useMemo(() => readMarkdownFrontmatter(text), [text]);
  const body = frontmatter ? frontmatter.body : text;

  useLayoutEffect(() => {
    const container = previewRef.current;
    if (!container) return;
    const count = highlightDomMatches(container, searchQuery, caseSensitive);
    onMatchCountChange(count);
    return () => {
      clearDomMatches(container);
    };
  }, [text, searchQuery, caseSensitive, onMatchCountChange]);

  useEffect(() => {
    const container = previewRef.current;
    if (!container || !searchQuery) return;
    const activeEl = setActiveDomMatch(container, activeMatchIndex);
    activeEl?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [searchQuery, activeMatchIndex, text, caseSensitive]);

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
      <div className="git-reader-preview" ref={previewRef}>
        {frontmatter ? (
          <section className="markdown-metadata" aria-label={t('diff.metadata')}>
            <h2>{t('diff.metadata')}</h2>
            <dl>
              {frontmatter.fields.map(({ key, value, structured }, index) => (
                <div key={index}>
                  <dt>{key}</dt>
                  <dd>{structured ? <pre>{value}</pre> : value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        {body.trim() ? (
          <Markdown text={body} locale={locale} className="markdown-body git-reader-markdown" />
        ) : frontmatter ? (
          <p className="git-reader-empty-body">{t('diff.emptyMarkdownBody')}</p>
        ) : null}
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<ReturnType<typeof readGitCodeSelection>>();

  const isMarkdown = isMarkdownPath(target.path);
  const [viewMode, setViewMode] = useState<'preview' | 'source'>(() =>
    isMarkdown ? 'preview' : 'source',
  );
  const [wordWrap, setWordWrap] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeMatch, setActiveMatch] = useState(0);
  const [previewMatchCount, setPreviewMatchCount] = useState(0);

  useEffect(() => {
    setViewMode(isMarkdownPath(target.path) ? 'preview' : 'source');
  }, [target.path]);

  const effectiveQuery = searchOpen ? searchQuery : '';
  const sourceLines = useMemo(() => {
    const raw = (content.data?.text ?? '').replace(/\r\n/gu, '\n');
    return raw.replace(/\n$/u, '').split('\n');
  }, [content.data?.text]);

  const sourceMatches = useMemo(
    () =>
      viewMode === 'source' ? findLineMatches(sourceLines, effectiveQuery, caseSensitive) : [],
    [viewMode, sourceLines, effectiveQuery, caseSensitive],
  );

  const matchesByLine = useMemo(() => {
    const grouped = new Map<number, LineMatch[]>();
    for (const match of sourceMatches) {
      const list = grouped.get(match.lineIndex);
      if (list) {
        list.push(match);
      } else {
        grouped.set(match.lineIndex, [match]);
      }
    }
    return grouped;
  }, [sourceMatches]);

  const totalMatches = viewMode === 'preview' ? previewMatchCount : sourceMatches.length;
  const safeActiveMatch =
    totalMatches > 0 ? ((activeMatch % totalMatches) + totalMatches) % totalMatches : 0;

  useEffect(() => {
    setActiveMatch(0);
  }, [effectiveQuery, caseSensitive, viewMode, target.path]);

  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  };

  const closeSearch = () => {
    setSearchOpen(false);
    requestAnimationFrame(() => {
      searchToggleRef.current?.focus();
    });
  };

  const stepMatch = (delta: number) => {
    if (totalMatches === 0) return;
    setActiveMatch((prev) => (((prev + delta) % totalMatches) + totalMatches) % totalMatches);
  };

  const canQuote = Boolean(onQuoteCode) && viewMode === 'source';
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
    if (!canQuote) {
      setSelection(undefined);
      return;
    }
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
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.code === 'KeyF'
        ) {
          event.preventDefault();
          openSearch();
          return;
        }
        if (searchOpen && !event.defaultPrevented && event.key === 'Escape') {
          event.preventDefault();
          closeSearch();
          return;
        }
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
          {isMarkdown ? (
            <div className="git-reader-mode-group" role="group" aria-label={t('diff.viewMode')}>
              <Button
                type="button"
                size="xs"
                variant={viewMode === 'preview' ? 'secondary' : 'ghost'}
                aria-pressed={viewMode === 'preview'}
                onClick={() => setViewMode('preview')}
              >
                <Eye data-icon="inline-start" aria-hidden="true" />
                {t('diff.previewMode')}
              </Button>
              <Button
                type="button"
                size="xs"
                variant={viewMode === 'source' ? 'secondary' : 'ghost'}
                aria-pressed={viewMode === 'source'}
                onClick={() => setViewMode('source')}
              >
                <Code2 data-icon="inline-start" aria-hidden="true" />
                {t('diff.sourceMode')}
              </Button>
            </div>
          ) : null}
          {viewMode === 'source' ? (
            <Button
              type="button"
              variant={wordWrap ? 'secondary' : 'ghost'}
              size="icon-xs"
              aria-pressed={wordWrap}
              title={t('diff.wordWrap')}
              aria-label={t('diff.wordWrap')}
              onClick={() => setWordWrap((current) => !current)}
            >
              <WrapText aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            ref={searchToggleRef}
            type="button"
            variant={searchOpen ? 'secondary' : 'ghost'}
            size="icon-xs"
            aria-pressed={searchOpen}
            aria-keyshortcuts="Control+F Meta+F"
            title={t('diff.searchFileHint')}
            aria-label={t('diff.searchFile')}
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
          >
            <Search aria-hidden="true" />
          </Button>
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
      {searchOpen ? (
        <div className="git-reader-search" role="search" aria-label={t('diff.searchFile')}>
          <div className="git-reader-search-box">
            <Search className="git-reader-search-icon" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              className="git-reader-search-input"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('diff.searchPlaceholder')}
              aria-label={t('diff.searchPlaceholder')}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  stepMatch(event.shiftKey ? -1 : 1);
                }
              }}
            />
          </div>
          <Button
            type="button"
            variant={caseSensitive ? 'secondary' : 'ghost'}
            size="icon-xs"
            aria-pressed={caseSensitive}
            title={t('diff.searchCaseSensitive')}
            aria-label={t('diff.searchCaseSensitive')}
            onClick={() => setCaseSensitive((current) => !current)}
          >
            <CaseSensitive aria-hidden="true" />
          </Button>
          <span className="git-reader-search-count" aria-live="polite">
            {effectiveQuery
              ? totalMatches > 0
                ? t('diff.searchCount', { current: safeActiveMatch + 1, total: totalMatches })
                : t('diff.searchNoResults')
              : null}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={totalMatches === 0}
            title={t('diff.searchPrev')}
            aria-label={t('diff.searchPrev')}
            onClick={() => stepMatch(-1)}
          >
            <ChevronUp aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={totalMatches === 0}
            title={t('diff.searchNext')}
            aria-label={t('diff.searchNext')}
            onClick={() => stepMatch(1)}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={t('diff.searchClose')}
            aria-label={t('diff.searchClose')}
            onClick={closeSearch}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}
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
      ) : viewMode === 'preview' ? (
        <MarkdownPreviewViewport
          text={content.data.text}
          position={position}
          onScroll={onScroll}
          searchQuery={effectiveQuery}
          caseSensitive={caseSensitive}
          activeMatchIndex={safeActiveMatch}
          onMatchCountChange={setPreviewMatchCount}
        />
      ) : (
        <SourceViewport
          path={target.path}
          lines={sourceLines}
          position={position}
          onScroll={onScroll}
          code={code}
          wordWrap={wordWrap}
          matchesByLine={matchesByLine}
          activeMatchIndex={safeActiveMatch}
          searchActive={Boolean(effectiveQuery)}
        />
      )}
    </div>
  );
}

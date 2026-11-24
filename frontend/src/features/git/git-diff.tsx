/**
 * @file 展示 Git 文件和提交的差异预览。
 * @implementation 保留原始补丁回退，按语言延迟加载高亮，并在同一区域显示原行和新行。
 * @updated 2026-11-24T04:04:00+08:00
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { FileCode2 } from 'lucide-react';
import { loadCodeHighlighter, type HighlightResult } from '@atelier/markdown';
import { useUiTranslation } from '@/i18n';
import { describeGitPatch, type GitDiffHunk, type GitDiffLine } from './git-diff-model';

const aliases: Readonly<Record<string, string>> = {
  cjs: 'javascript',
  cts: 'typescript',
  h: 'c',
  hpp: 'cpp',
  mjs: 'javascript',
  mts: 'typescript',
  'code-workspace': 'jsonc',
};

function languageForPath(path: string) {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  if (/^(?:dockerfile|containerfile)(?:\.|$)/u.test(name)) return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'make';
  if (name === '.gitattributes' || name === '.gitconfig') return 'ini';
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '') : '';
  return aliases[extension] ?? extension;
}

type Tokens = HighlightResult['tokens'];
type TokenStyle = CSSProperties & {
  '--git-token-light'?: string;
  '--git-token-dark'?: string;
};

function useHunkTokens(path: string | undefined, lines: GitDiffLine[]) {
  const [highlight, setHighlight] = useState<{
    path: string;
    lines: GitDiffLine[];
    old?: Tokens;
    new?: Tokens;
  }>();
  useEffect(() => {
    if (!path) return;
    const candidate = languageForPath(path);
    if (!candidate) return;
    let active = true;
    void loadCodeHighlighter()
      .then((highlighter) => {
        if (!active) return;
        const language = highlighter.getSupportedLanguages().find((item) => item === candidate);
        if (!language) return;
        for (const side of ['old', 'new'] as const) {
          const source = lines
            .filter((line) => (side === 'old' ? line.oldLine : line.newLine) !== null)
            .map((line) => line.text.replace(/\r$/u, ''))
            .join('\n');
          if (!source) continue;
          const receive = ({ tokens }: HighlightResult) => {
            if (!active) return;
            setHighlight((current) => ({
              ...(current?.path === path && current.lines === lines ? current : { path, lines }),
              [side]: tokens,
            }));
          };
          const cached = highlighter.highlight(
            { code: source, language, themes: highlighter.getThemes() },
            receive,
          );
          if (cached) receive(cached);
        }
      })
      .catch(() => {
        // Plain text is already available if the tokenizer cannot load.
      });
    return () => {
      active = false;
    };
  }, [path, lines]);

  return highlight?.path === path && highlight?.lines === lines ? highlight : undefined;
}

function HighlightedLine({ text, tokens }: { text: string; tokens: Tokens[number] | undefined }) {
  if (!tokens?.length) return text;
  return tokens.map(({ content, htmlStyle }, index) => {
    const style: TokenStyle = {
      '--git-token-light': htmlStyle?.color,
      '--git-token-dark': htmlStyle?.['--shiki-dark'],
    };
    return (
      <span key={index} className="git-syntax-token" style={style}>
        {content}
      </span>
    );
  });
}

function PatchHunk({ hunk, path }: { hunk: GitDiffHunk; path: string | undefined }) {
  const { t } = useUiTranslation('inspector');
  const tokens = useHunkTokens(path, hunk.lines);
  let oldIndex = 0;
  let newIndex = 0;
  return (
    <tbody>
      <tr className="git-diff-hunk">
        <td colSpan={4}>{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, index) => {
        const previous = line.oldLine === null ? undefined : tokens?.old?.[oldIndex];
        const next = line.newLine === null ? undefined : tokens?.new?.[newIndex];
        if (line.oldLine !== null) oldIndex++;
        if (line.newLine !== null) newIndex++;
        const crlf = line.text.endsWith('\r');
        return (
          <tr className="git-diff-line" data-kind={line.kind} key={index}>
            <td className="git-diff-number">{line.oldLine}</td>
            <td className="git-diff-number">{line.newLine}</td>
            <td className="git-diff-sign" aria-label={t(`diff.${line.kind}`)}>
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
            </td>
            <td className="git-diff-text">
              <code>
                <HighlightedLine
                  text={crlf ? line.text.slice(0, -1) : line.text}
                  tokens={line.kind === 'removed' ? previous : next}
                />
              </code>
              {crlf ? (
                <span className="git-line-note" title={t('diff.crlf')}>
                  ␍
                </span>
              ) : null}
              {line.noFinalNewline ? (
                <span className="git-line-note">{t('diff.noFinalNewline')}</span>
              ) : null}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

export function GitPatch({ text, path }: { text: string; path?: string }) {
  const { t, locale } = useUiTranslation('git');
  const { t: diff } = useUiTranslation('inspector');
  const files = useMemo(() => describeGitPatch(text, path), [text, path]);
  const highlight = text.length <= 96_000;
  const format = new Intl.NumberFormat(locale);
  return (
    <div className="git-diff-code" role="region" aria-label={t('diff.preview')} tabIndex={0}>
      {files.map((file, index) => {
        const filename = !path || files.length > 1 ? file.path : undefined;
        return (
          <div className="git-patch" key={index}>
            {filename || file.kind === 'text' ? (
              <header className="git-patch-heading">
                {filename ? (
                  <h4 title={filename}>
                    <FileCode2 aria-hidden="true" />
                    <span className="truncate">{filename}</span>
                  </h4>
                ) : null}
                {file.kind === 'text' ? (
                  <div className="git-patch-stats">
                    <span aria-label={diff('diff.addedLines', { count: file.added })}>
                      +{format.format(file.added)}
                    </span>
                    <span aria-label={diff('diff.removedLines', { count: file.removed })}>
                      −{format.format(file.removed)}
                    </span>
                  </div>
                ) : null}
              </header>
            ) : null}
            {file.kind === 'raw' ? (
              <>
                {file.binary ? <p className="git-feedback">{t('diff.binary')}</p> : null}
                <pre className="git-patch-raw">{file.text}</pre>
              </>
            ) : (
              <>
                {file.metadata.length ? (
                  <pre className="git-patch-raw">{file.metadata.join('\n')}</pre>
                ) : null}
                <table className="git-diff-table" aria-label={filename}>
                  <colgroup>
                    <col className="git-diff-number-column" />
                    <col className="git-diff-number-column" />
                    <col className="git-diff-sign-column" />
                    <col />
                  </colgroup>
                  <thead className="sr-only">
                    <tr>
                      <th scope="col">{diff('diff.oldLine')}</th>
                      <th scope="col">{diff('diff.newLine')}</th>
                      <th scope="col">{t('diff.change')}</th>
                      <th scope="col">{t('diff.content')}</th>
                    </tr>
                  </thead>
                  {file.hunks.map((hunk, hunkIndex) => (
                    <PatchHunk
                      key={hunkIndex}
                      hunk={hunk}
                      path={highlight ? file.path : undefined}
                    />
                  ))}
                </table>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

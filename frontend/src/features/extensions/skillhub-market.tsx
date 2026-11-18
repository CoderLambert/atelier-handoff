import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import {
  endpoint,
  extensionsQuery,
  messageOf,
  useExtensionMutation,
  type PublicEntry,
} from './api';
import { ActionButton, ErrorMessage, MarkdownPreview } from './components';

interface SkillHubItem {
  source: string;
  coordinate: string;
  title: string;
  version: string;
  description: string;
  publisher?: string;
}

export function SkillHubMarket({
  projectId,
  onSaved,
}: {
  projectId: string;
  onSaved: (message: string) => void;
}) {
  const detailId = useId();
  const resultScroll = useRef<HTMLDivElement>(null);
  const detailScroll = useRef<HTMLDivElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const restoring = useRef(false);
  const resultPosition = useRef(0);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SkillHubItem>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const install = useExtensionMutation(projectId);
  const extensions = useQuery(extensionsQuery(projectId));
  const results = useQuery({
    queryKey: ['extensions', projectId, 'skillhub-search', query],
    enabled: Boolean(query),
    queryFn: ({ signal }) =>
      api<{ items: SkillHubItem[] }>(
        `${endpoint(projectId, 'skillhub-search')}?q=${encodeURIComponent(query)}`,
        { signal },
      ),
  });
  const preview = useQuery({
    queryKey: ['extensions', projectId, 'skillhub-preview', selected?.source],
    enabled: Boolean(selected),
    queryFn: async ({ signal }) => {
      const { items } = await api<{ items: PublicEntry[] }>(endpoint(projectId, 'public-preview'), {
        method: 'POST',
        body: { source: selected?.source, kind: 'skill' },
        signal,
      });
      return items[0];
    },
  });
  const entry = preview.data;
  const installed =
    entry &&
    extensions.data?.some(
      (item) => item.origin?.location === entry.location && item.origin.key === entry.key,
    );
  const selectedSource = selected?.source;
  useLayoutEffect(() => {
    if (selectedSource) {
      detailHeading.current?.focus({ preventScroll: true });
      if (detailScroll.current) detailScroll.current.scrollTop = 0;
    } else if (restoring.current) {
      restoring.current = false;
      if (resultScroll.current) resultScroll.current.scrollTop = resultPosition.current;
      opener.current?.focus({ preventScroll: true });
    }
  }, [selectedSource]);
  function back() {
    restoring.current = true;
    setSelected(undefined);
    setError('');
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = input.trim();
    if (!next) return;
    setSelected(undefined);
    setError('');
    setMessage('');
    if (resultScroll.current) resultScroll.current.scrollTop = 0;
    if (next === query) void results.refetch();
    else setQuery(next);
  }
  async function save() {
    if (!entry?.revision || entry.issue || !selected || installed || install.isPending) return;
    setError('');
    try {
      await install.mutateAsync({
        suffix: 'public-import',
        method: 'POST',
        body: { kind: 'skill', source: selected.source, key: entry.key, revision: entry.revision },
      });
      const status = `已导入 /${entry.name}，可在对话中手动调用。`;
      setMessage(status);
      onSaved(status);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }
  const items = results.data?.items ?? [];
  return (
    <div className="ext-market skillhub-market" data-show-detail={Boolean(selected)}>
      <form className="skillhub-search" onSubmit={search}>
        <label className="ext-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            name="q"
            autoComplete="off"
            placeholder="搜索技能，例如 React、写作或项目规划"
            aria-label="搜索 SkillHub"
            value={input}
            maxLength={120}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <ActionButton type="submit" primary disabled={!input.trim() || install.isPending}>
          搜索
        </ActionButton>
      </form>
      <p className="sr-only" role="status">
        {message}
      </p>
      <div className="skillhub-browser" data-has-results={items.length > 0}>
        <section className="skillhub-results" aria-label="搜索结果" aria-busy={results.isFetching}>
          <p className="skillhub-result-count" role="status">
            {results.isFetching
              ? '正在搜索…'
              : query && !results.isError
                ? `「${query}」· ${items.length} 项结果`
                : 'SkillHub 搜索结果'}
          </p>
          <div ref={resultScroll} className="skillhub-result-scroll">
            <ErrorMessage error={results.error} />
            {!query || (results.isSuccess && !items.length) ? (
              <p className="skillhub-empty">
                {query ? '没有匹配的技能。试试更短的关键词。' : '输入关键词查找 SkillHub 技能。'}
              </p>
            ) : null}
            <ul className="skillhub-list">
              {items.map((item) => (
                <li key={item.coordinate}>
                  <button
                    type="button"
                    className="skillhub-result"
                    aria-controls={detailId}
                    aria-current={selected?.coordinate === item.coordinate ? 'true' : undefined}
                    disabled={install.isPending}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      resultPosition.current = resultScroll.current?.scrollTop ?? 0;
                      setSelected(item);
                      setError('');
                      setMessage('');
                    }}
                  >
                    <span className="skillhub-result-copy">
                      <strong>{item.title}</strong>
                      <span className="skillhub-result-summary">
                        {item.description || '暂无简介'}
                      </span>
                      <span className="skillhub-result-meta">
                        <span>{item.publisher || item.coordinate.split('/')[0]}</span>
                        <span>v{item.version}</span>
                      </span>
                    </span>
                    <span aria-hidden="true" className="skillhub-chevron">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <section id={detailId} className="skillhub-detail" aria-label="SkillHub 技能预览">
          {selected ? (
            <>
              <div className="skillhub-detail-header">
                <ActionButton className="skillhub-back" disabled={install.isPending} onClick={back}>
                  ← 返回结果
                </ActionButton>
                <h3 ref={detailHeading} tabIndex={-1}>
                  {selected.title}
                </h3>
                <p>
                  {selected.coordinate} · v{selected.version}
                </p>
              </div>
              <div ref={detailScroll} className="skillhub-detail-scroll">
                <p className="skillhub-detail-description">{selected.description}</p>
                {preview.isFetching ? <p role="status">正在读取 SKILL.md…</p> : null}
                <ErrorMessage error={preview.error} />
                {entry?.issue ? <p className="ext-compatibility">{entry.issue}</p> : null}
                {entry?.body ? (
                  <MarkdownPreview
                    key={selected.source}
                    body={entry.body}
                    label="SKILL.md"
                    initiallyOpen
                  />
                ) : null}
              </div>
              <div className="skillhub-detail-footer">
                <ErrorMessage error={error} />
                <p className="ext-help">
                  {installed ? '已加入当前项目' : '导入 SKILL.md，默认手动调用'}
                </p>
                <ActionButton
                  primary
                  disabled={
                    !entry?.revision ||
                    !!entry.issue ||
                    preview.isFetching ||
                    extensions.isPending ||
                    !!installed ||
                    install.isPending
                  }
                  onClick={() => void save()}
                >
                  {installed ? '已导入' : install.isPending ? '正在导入…' : '导入当前项目'}
                </ActionButton>
              </div>
            </>
          ) : (
            <p className="skillhub-empty">选择一项技能，查看正文和导入选项。</p>
          )}
        </section>
      </div>
    </div>
  );
}

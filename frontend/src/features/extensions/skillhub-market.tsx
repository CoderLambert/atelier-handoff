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
import { ActionButton, ErrorMessage, MarketCategoryIcon, MarkdownPreview } from './components';

interface SkillHubItem {
  source: string;
  coordinate: string;
  title: string;
  version: string;
  description: string;
  publisher?: string;
  category?: string;
}

const categoryLabels: Record<string, string> = {
  'dev-programming': '编程开发',
  professional: '专业服务',
  'ai-agent': '智能体',
  'design-media': '设计与媒体',
  'knowledge-management': '知识管理',
  'office-efficiency': '办公效率',
  'data-analysis': '数据分析',
  'content-creation': '内容创作',
  'life-service': '生活服务',
  'business-ops': '商业运营',
};

export function SkillHubMarket({
  projectId,
  active,
  onSaved,
  onStartSkill,
}: {
  projectId: string;
  active: boolean;
  onSaved: (message: string) => void;
  onStartSkill?: (projectId: string, name: string, editable: boolean) => Promise<void>;
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
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState<SkillHubItem>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [starting, setStarting] = useState(false);
  const install = useExtensionMutation(projectId);
  const extensions = useQuery(extensionsQuery(projectId));
  const results = useQuery({
    queryKey: ['extensions', projectId, 'skillhub-search', query],
    enabled: active,
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
    extensions.data?.find(
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
    setCategory('');
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
        body: {
          kind: 'skill',
          source: selected.source,
          key: entry.key,
          revision: entry.revision,
          packageDigest: entry.packageManifest?.digest,
        },
      });
      const status = `已导入 /${entry.name}，可在对话中手动调用。`;
      setMessage(status);
      onSaved(status);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }
  async function startSkill() {
    if (!installed || !onStartSkill || starting) return;
    setStarting(true);
    setError('');
    try {
      await onStartSkill(
        projectId,
        installed.name,
        entry?.packageManifest?.files.some((path) => /\.py$/i.test(path)) ?? false,
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setStarting(false);
    }
  }
  const items = results.data?.items ?? [];
  const categories = [...new Set(items.flatMap((item) => (item.category ? [item.category] : [])))];
  const filtered = category ? items.filter((item) => item.category === category) : items;
  return (
    <div className="ext-market skillhub-market">
      {categories.length > 0 ? (
        <div
          className="market-categories"
          role="group"
          aria-label="SkillHub 分类"
          hidden={Boolean(selected)}
        >
          {['', ...categories].map((value) => (
            <ActionButton
              key={value}
              primary={value === category}
              aria-pressed={value === category}
              onClick={() => {
                setCategory(value);
                if (resultScroll.current) resultScroll.current.scrollTop = 0;
              }}
            >
              {value ? (categoryLabels[value] ?? value) : '全部分类'}
            </ActionButton>
          ))}
        </div>
      ) : null}
      <form className="skillhub-search" onSubmit={search} hidden={Boolean(selected)}>
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
        <ActionButton type="submit" primary disabled={install.isPending}>
          搜索
        </ActionButton>
      </form>
      <p className="sr-only" role="status">
        {message}
      </p>
      <div className="skillhub-browser">
        <section
          className="skillhub-results"
          aria-label="搜索结果"
          aria-busy={results.isFetching}
          hidden={Boolean(selected)}
        >
          <p className="market-result-count" role="status">
            {results.isFetching
              ? '正在搜索…'
              : results.isSuccess
                ? `${query ? `「${query}」` : '推荐技能'} · ${filtered.length} 项`
                : 'SkillHub 技能'}
          </p>
          <div ref={resultScroll} className="skillhub-result-scroll">
            <ErrorMessage error={results.error} />
            {results.isSuccess && !filtered.length ? (
              <p className="skillhub-empty">没有匹配的技能。可以换一个关键词或分类。</p>
            ) : null}
            <ul className="market-catalog-list">
              {filtered.map((item) => (
                <li key={item.coordinate}>
                  <button
                    type="button"
                    className="market-result"
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
                    <MarketCategoryIcon category={item.category} />
                    <span className="market-result-copy">
                      <span className="market-result-title">
                        <strong>{item.title}</strong>
                        {item.category ? (
                          <span className="market-row-category">
                            {categoryLabels[item.category] ?? item.category}
                          </span>
                        ) : null}
                      </span>
                      <span className="market-result-summary">
                        {item.description || '暂无简介'}
                      </span>
                    </span>
                    <span className="market-result-meta">
                      <span>{item.publisher || item.coordinate.split('/')[0]}</span>
                      <span>v{item.version}</span>
                    </span>
                    <span aria-hidden="true" className="market-result-arrow">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <section
          id={detailId}
          className="skillhub-detail"
          aria-label="SkillHub 技能预览"
          hidden={!selected}
        >
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
                {entry?.packageManifest ? (
                  <details className="ext-preview">
                    <summary>包内文件 · {entry.packageManifest.files.length} 项</summary>
                    <pre className="ext-body-preview">{entry.packageManifest.files.join('\n')}</pre>
                  </details>
                ) : null}
                {entry?.issue ? <p className="ext-compatibility">{entry.issue}</p> : null}
                {entry?.body ? (
                  <MarkdownPreview
                    key={selected.source}
                    body={entry.body
                      .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
                      .trimStart()}
                    standalone
                  />
                ) : null}
              </div>
              <div className="skillhub-detail-footer">
                <ErrorMessage error={error} />
                <p className="ext-help">
                  {installed
                    ? '已加入当前项目'
                    : entry?.packageManifest
                      ? `导入技能包 · ${entry.packageManifest.files.length} 个文件`
                      : '导入技能 · 默认手动调用'}
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
                {installed &&
                installed.kind === 'skill' &&
                installed.enabled &&
                installed.supported &&
                installed.userInvocable &&
                onStartSkill ? (
                  <ActionButton primary disabled={starting} onClick={() => void startSkill()}>
                    {starting ? '正在打开…' : '到对话中使用'}
                  </ActionButton>
                ) : null}
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

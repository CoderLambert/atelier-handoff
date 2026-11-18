import { useState, type FormEvent } from 'react';
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
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = input.trim();
    if (!next) return;
    setSelected(undefined);
    setError('');
    setMessage('');
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
      setSelected(undefined);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }
  return (
    <div className="ext-market">
      <form className="ext-market-filters" onSubmit={search}>
        <label className="ext-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="例如 React、写作、项目规划"
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
      {message ? <p role="status">{message}</p> : null}
      <ErrorMessage error={error || results.error || preview.error} />
      {selected ? (
        <section aria-label="SkillHub 技能预览" className="space-y-3">
          <div className="ext-market-actions">
            <ActionButton
              disabled={install.isPending}
              onClick={() => {
                setSelected(undefined);
                setError('');
              }}
            >
              返回搜索结果
            </ActionButton>
          </div>
          <h3>{selected.title}</h3>
          <p className="ext-card-source">
            {selected.coordinate} · v{selected.version}
          </p>
          <p className="ext-help">
            导入此版本的 SKILL.md。安装后可手动调用，自动调用可在项目扩展中开启。
          </p>
          {preview.isFetching ? <p role="status">正在读取 SKILL.md…</p> : null}
          {entry?.issue ? <p className="ext-compatibility">{entry.issue}</p> : null}
          {entry?.body ? <MarkdownPreview body={entry.body} label="SkillHub SKILL.md" /> : null}
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
        </section>
      ) : (
        <>
          {results.isFetching ? <p role="status">正在搜索 SkillHub…</p> : null}
          {results.isSuccess && !results.data.items.length ? (
            <p className="ext-help">没有匹配的 Skill。</p>
          ) : null}
          <div className="ext-card-grid ext-market-grid">
            {results.data?.items.map((item) => (
              <article key={item.coordinate} className="ext-card ext-market-card">
                <p className="ext-card-kind">
                  {item.publisher ?? 'SkillHub'} · v{item.version}
                </p>
                <h3>{item.title}</h3>
                <code>{item.coordinate}</code>
                <p className="ext-market-description">{item.description}</p>
                <ActionButton
                  onClick={() => {
                    setSelected(item);
                    setError('');
                    setMessage('');
                  }}
                >
                  查看正文
                </ActionButton>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

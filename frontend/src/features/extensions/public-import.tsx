import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Extension } from '@shared/types';
import { api } from '@/api/client';
import {
  ActionButton,
  BackupActions,
  ErrorMessage,
  FeatureDialog,
  Field,
  MarkdownPreview,
} from './components';
import {
  endpoint,
  isConflict,
  marketQuery,
  messageOf,
  useExtensionMutation,
  type ExtensionKind,
  type PublicEntry,
} from './api';

export function PublicImport({
  projectId,
  projectName,
  kind,
  updating,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  kind: ExtensionKind;
  updating?: Extension;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const initialSource = updating?.origin?.location ?? '';
  const [source, setSource] = useState(initialSource);
  const [submitted, setSubmitted] = useState(initialSource);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const mutation = useExtensionMutation(projectId);
  const query = useQuery({
    queryKey: ['extensions', projectId, 'public-preview', kind, submitted],
    queryFn: async ({ signal }) => {
      const result = await api<{ items: PublicEntry[] }>(endpoint(projectId, 'public-preview'), {
        method: 'POST',
        body: { source: submitted, kind },
        signal,
      });
      if (!Array.isArray(result?.items)) throw new Error('公开来源响应缺少 items。');
      return updating
        ? result.items.filter((entry) => entry.key === updating.origin?.key)
        : result.items;
    },
    enabled: Boolean(submitted),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const busy = query.isFetching || mutation.isPending;
  const ready =
    Boolean(submitted) && query.isSuccess && !query.isFetching && !query.isError && !stale;
  const needsConfirmation = Boolean(updating && updating.kind !== 'mcp');
  async function load(value: string) {
    const normalized =
      kind === 'mcp' && !value.includes('://') && !value.startsWith('registry:')
        ? `registry:${value}`
        : value;
    setError('');
    setStale(false);
    setReplaceConfirmed(false);
    if (normalized === submitted) await query.refetch();
    else setSubmitted(normalized);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy && source.trim()) void load(source.trim());
  }
  async function select(entry: PublicEntry) {
    if (!ready || mutation.isPending || entry.issue || (needsConfirmation && !replaceConfirmed))
      return;
    if (!entry.revision) {
      setSource(entry.location);
      await load(entry.location);
      return;
    }
    setError('');
    try {
      await mutation.mutateAsync({
        suffix: 'public-import',
        method: 'POST',
        body: {
          source: entry.location,
          key: entry.key,
          revision: entry.revision,
          packageDigest: entry.packageManifest?.digest,
          kind,
          ...(updating ? { update: { id: updating.id, version: updating.version } } : {}),
        },
      });
      onSaved(updating ? '同步已完成' : '已导入当前项目');
      onClose();
    } catch (cause) {
      if (isConflict(cause)) {
        setStale(true);
        setReplaceConfirmed(false);
      }
      setError(
        `${messageOf(cause)}${isConflict(cause) ? ' 请关闭后重新打开最新版本，再检查更新。' : ''}`,
      );
    }
  }
  function preset() {
    const value =
      kind === 'mcp'
        ? 'context7'
        : 'https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md';
    setSource(value);
    void load(value);
  }
  return (
    <FeatureDialog
      title={updating ? '同步公开来源' : '从公开来源导入'}
      description={`当前项目 · ${projectName}`}
      busy={mutation.isPending}
      onClose={onClose}
    >
      <form className="ext-editor" onSubmit={submit}>
        <Field
          label={kind === 'mcp' ? 'MCP Registry 搜索词或 GitHub 配置链接' : 'GitHub 仓库或文件链接'}
        >
          <input
            autoFocus
            readOnly={Boolean(updating)}
            required
            maxLength={4096}
            autoComplete="off"
            value={source}
            disabled={busy}
            onChange={(event) => setSource(event.target.value)}
          />
        </Field>
        <div className="ext-dialog-actions">
          {!updating && (kind === 'skill' || kind === 'mcp') ? (
            <ActionButton disabled={busy} onClick={preset}>
              {kind === 'mcp' ? '搜索 Context7' : 'Anthropic Frontend Design'}
            </ActionButton>
          ) : null}
          <ActionButton type="submit" disabled={busy || !source.trim()}>
            {updating ? '检查更新' : '查询'}
          </ActionButton>
        </div>
        <p className="ext-save-state" role="status">
          {mutation.isPending ? '正在导入…' : query.isFetching ? '正在读取公开来源…' : ''}
        </p>
        <ErrorMessage error={error || query.error} />
        {updating && updating.kind !== 'mcp' ? (
          <section className="ext-preview-pane">
            <h4>当前项目正文 · v{updating.version}</h4>
            <pre className="ext-body-preview" tabIndex={0}>
              {updating.body}
            </pre>
            <BackupActions body={updating.body} name={updating.name} version={updating.version} />
            <fieldset className="ext-replacement" disabled={busy}>
              <p>同步将替换当前 Markdown 正文。请比较预览，并按需备份。</p>
              <label>
                <input
                  type="checkbox"
                  checked={replaceConfirmed}
                  onChange={(event) => setReplaceConfirmed(event.target.checked)}
                />
                我已检查正文，确认同步公开来源
              </label>
            </fieldset>
          </section>
        ) : null}
        <div className="grid gap-3">
          {query.data?.map((entry) => {
            const unchanged = Boolean(
              updating?.origin?.revision && updating.origin.revision === entry.revision,
            );
            return (
              <article className="ext-card gap-3" key={`${entry.location}:${entry.key}`}>
                <strong>{entry.name}</strong>
                <p>{entry.description}</p>
                {entry.body != null ? (
                  <>
                    <pre className="ext-body-preview" tabIndex={0}>
                      {entry.body}
                    </pre>
                    <MarkdownPreview body={entry.body} label="预览 Markdown" />
                  </>
                ) : entry.transport ? (
                  <pre className="ext-body-preview">{JSON.stringify(entry.transport, null, 2)}</pre>
                ) : null}
                {entry.issue ? (
                  <p className="ext-compatibility">{entry.issue}</p>
                ) : unchanged ? (
                  <p className="ext-help">当前已是此来源的最新版本。</p>
                ) : (
                  <ActionButton
                    primary
                    disabled={
                      !ready || mutation.isPending || (needsConfirmation && !replaceConfirmed)
                    }
                    onClick={() => void select(entry)}
                  >
                    {entry.revision ? (updating ? '应用更新' : '导入到当前项目') : '查看文件'}
                  </ActionButton>
                )}
              </article>
            );
          })}
        </div>
        {submitted && query.isSuccess && !query.data.length ? (
          <p className="ext-help">未找到匹配的扩展。</p>
        ) : null}
        <div className="ext-dialog-actions">
          <ActionButton disabled={mutation.isPending} onClick={onClose}>
            关闭
          </ActionButton>
        </div>
      </form>
    </FeatureDialog>
  );
}

export function InstalledSourceResolver({
  projectId,
  item,
  onMarket,
  onPublic,
  onClose,
}: {
  projectId: string;
  item: Extension;
  onMarket: (id: string, installedId?: string) => void;
  onPublic: (item: Extension) => void;
  onClose: () => void;
}) {
  const query = useQuery({ ...marketQuery(projectId), refetchOnMount: 'always' });
  const match = query.data?.find((skill) => skill.installedId === item.id);
  useEffect(() => {
    if (!query.isSuccess || query.isFetching) return;
    if (match) onMarket(match.id, item.id);
    else if (item.origin) onPublic(item);
  }, [query.isSuccess, query.isFetching, match, item, onMarket, onPublic]);
  return (
    <FeatureDialog title="检查 Skill 更新" onClose={onClose}>
      <p className="ext-help" role="status">
        {query.isFetching
          ? '正在核对市场来源…'
          : query.isSuccess && !match && !item.origin
            ? '此 Skill 尚未关联公开来源。可在“查看与编辑”中检查正文，或从 Skill 市场导入。'
            : ''}
      </p>
      <ErrorMessage error={query.error} />
      <div className="ext-dialog-actions">
        <ActionButton onClick={onClose}>取消</ActionButton>
        <ActionButton disabled={query.isFetching} onClick={() => void query.refetch()}>
          重新检查
        </ActionButton>
      </div>
    </FeatureDialog>
  );
}

import { useDeferredValue, useState } from 'react';
import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Extension } from '@shared/types';
import { api } from '@/api/client';
import { SkillHubMarket } from './skillhub-market';
import {
  ActionButton,
  BackupActions,
  Capabilities,
  ErrorMessage,
  FeatureDialog,
  MarketCategoryIcon,
  MarketSource,
  MarketStatus,
  MarkdownPreview,
} from './components';
import {
  endpoint,
  extensionKeys,
  extensionsQuery,
  isConflict,
  marketQuery,
  messageOf,
  needsMarketReview,
  useExtensionMutation,
  type MarketPreview,
  type MarketSkill,
} from './api';

export function SkillMarket({
  projectId,
  projectName,
  onClose,
  onPreview,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onPreview: (id: string, installedId?: string) => void;
  onSaved: (message: string) => void;
}) {
  const query = useQuery(marketQuery(projectId));
  const install = useExtensionMutation(projectId);
  const pending = useIsMutating({ mutationKey: extensionKeys.mutations(projectId) }) > 0;
  const [marketSource, setMarketSource] = useState<'curated' | 'skillhub'>('curated');
  const [search, setSearch] = useState('');
  const searchText = useDeferredValue(search.trim().toLocaleLowerCase());
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const skills = query.data ?? [];
  const categories = [...new Set(skills.map((skill) => skill.category))];
  const results = skills.filter(
    (skill) =>
      (!category || skill.category === category) &&
      `${skill.title} ${skill.name} ${skill.description} ${skill.publisher} ${skill.repository} ${skill.upstreamName}`
        .toLocaleLowerCase()
        .includes(searchText),
  );
  const ready = query.isSuccess && !query.isFetching && !query.isError;
  async function apply(skill: MarketSkill) {
    if (!ready || pending || !['available', 'disabled'].includes(skill.status)) return;
    if (needsMarketReview(skill)) return onPreview(skill.id, skill.installedId);
    if (!skill.revision) {
      setError('目录缺少修订号，请刷新目录后重试。');
      return;
    }
    setStatus('');
    setError('');
    try {
      await install.mutateAsync({
        suffix: 'market',
        method: 'POST',
        body: { id: skill.id, revision: skill.revision },
      });
      const text = `已启用 /${skill.name}，可以回到该项目的对话使用。`;
      setStatus(text);
      onSaved(text);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <FeatureDialog
      title="Skill 市场"
      className="market-catalog-dialog"
      description={`安装到 ${projectName}`}
      busy={pending}
      onClose={onClose}
    >
      <div className="market-catalog-content">
        <div className="market-intro">
          <div className="market-intro-copy">
            <strong>{marketSource === 'curated' ? '为项目扩展工作流程' : '发现社区技能'}</strong>
            <p>
              {marketSource === 'curated'
                ? '从界面设计、开发到写作，选择适合当前任务的技能。'
                : '浏览推荐或按分类查找，预览说明后导入当前项目。'}
            </p>
          </div>
          <span className="market-intro-art" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div role="group" aria-label="市场来源" className="market-source-tabs">
          <ActionButton
            primary={marketSource === 'curated'}
            aria-pressed={marketSource === 'curated'}
            disabled={pending}
            onClick={() => setMarketSource('curated')}
          >
            精选
          </ActionButton>
          <ActionButton
            primary={marketSource === 'skillhub'}
            aria-pressed={marketSource === 'skillhub'}
            disabled={pending}
            onClick={() => setMarketSource('skillhub')}
          >
            SkillHub
          </ActionButton>
        </div>
        <div className="market-source-panel" hidden={marketSource !== 'skillhub'}>
          <SkillHubMarket
            projectId={projectId}
            active={marketSource === 'skillhub'}
            onSaved={onSaved}
          />
        </div>
        <div className="market-source-panel" hidden={marketSource !== 'curated'}>
          <div className="ext-market market-curated">
            <div className="market-categories" role="group" aria-label="精选分类">
              {['', ...categories].map((value) => (
                <ActionButton
                  key={value}
                  aria-pressed={category === value}
                  primary={category === value}
                  onClick={() => setCategory(value)}
                >
                  {value || '全部分类'}
                </ActionButton>
              ))}
            </div>
            <div className="skillhub-search">
              <label className="ext-search">
                <span aria-hidden="true">⌕</span>
                <input
                  type="search"
                  placeholder="搜索精选技能名称、说明或发布者"
                  aria-label="搜索精选 Skill"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <ActionButton
                disabled={query.isFetching || pending}
                onClick={() => {
                  setError('');
                  void query.refetch();
                }}
              >
                刷新目录
              </ActionButton>
            </div>
            <p className="ext-save-state" role="status" aria-live="polite">
              {pending
                ? '正在处理…'
                : query.isFetching
                  ? skills.length
                    ? '正在刷新目录，保留上次显示的内容…'
                    : '正在读取精选目录…'
                  : status}
            </p>
            <ErrorMessage error={error || query.error} />
            {query.isError && skills.length ? (
              <p className="ext-help">当前显示上次成功读取的目录，安装前请刷新。</p>
            ) : null}
            <div className="market-catalog-results">
              <p className="market-result-count" role="status">
                {query.isPending ? '正在读取精选目录…' : `${results.length} 项技能`}
              </p>
              <ul className="market-catalog-list" aria-busy={query.isFetching || pending}>
                {results.map((skill) => {
                  const review = needsMarketReview(skill);
                  return (
                    <li key={skill.id} className="market-catalog-item">
                      <button
                        type="button"
                        className="market-result"
                        disabled={!ready || pending}
                        onClick={() => onPreview(skill.id, skill.installedId)}
                      >
                        <MarketCategoryIcon category={skill.category} />
                        <span className="market-result-copy">
                          <span className="market-result-title">
                            <strong>{skill.title || skill.name}</strong>
                            <span className="market-row-category">{skill.category}</span>
                          </span>
                          <span className="market-result-summary">{skill.description}</span>
                        </span>
                        <span className="market-result-meta">
                          <span>{skill.publisher}</span>
                        </span>
                        <span aria-hidden="true" className="market-result-arrow">
                          ›
                        </span>
                      </button>
                      <div className="market-curated-action">
                        {review || !['available', 'disabled'].includes(skill.status) ? (
                          <MarketStatus skill={skill} />
                        ) : (
                          <ActionButton
                            disabled={!ready || pending}
                            onClick={() => void apply(skill)}
                          >
                            {skill.status === 'disabled' ? '启用' : '安装'}
                          </ActionButton>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {!results.length && !query.isPending ? (
                <p className="market-empty">没有匹配的技能。</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </FeatureDialog>
  );
}

export function SkillMarketPreview({
  projectId,
  projectName,
  id,
  installedId,
  onBack,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  id: string;
  installedId?: string;
  onBack: () => void;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const client = useQueryClient();
  const mutation = useExtensionMutation(projectId);
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [stale, setStale] = useState(false);
  const [confirmedAt, setConfirmedAt] = useState<number>();
  const query = useQuery({
    queryKey: extensionKeys.preview(projectId, id),
    queryFn: async ({ signal }) => {
      const response = await api<MarketPreview>(endpoint(projectId, 'market-preview'), {
        method: 'POST',
        body: { id },
        signal,
      });
      if (
        response?.skill?.id !== id ||
        !response.skill.revision ||
        typeof response.entry?.body !== 'string'
      )
        throw new Error('市场预览响应不完整，请重新读取。');
      if (installedId && response.update?.id !== installedId)
        throw new Error('安装关联已变化，请返回市场刷新后重新预览。');
      if (
        response.update &&
        (!response.update.id ||
          !Number.isInteger(response.update.version) ||
          !response.update.revision)
      )
        throw new Error('市场预览缺少更新版本，请重新读取。');
      if (response.update && typeof response.localBody !== 'string') {
        const update = response.update;
        let local = client
          .getQueryData<Extension[]>(extensionKeys.list(projectId))
          ?.find((item) => item.id === update.id && item.version === update.version);
        if (!local) {
          const items = await client.fetchQuery({ ...extensionsQuery(projectId), staleTime: 0 });
          local = items.find((item) => item.id === update.id && item.version === update.version);
        }
        if (!local || local.kind === 'mcp')
          throw new Error('无法读取与预览版本一致的本地正文，请重新读取预览。');
        response.localBody = local.body;
      }
      return response;
    },
    staleTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const preview = query.data;
  const requiresReplacement = Boolean(preview?.requiresReplacement || preview?.skill.localModified);
  const confirmed = confirmedAt === query.dataUpdatedAt;
  const canApply =
    query.isSuccess &&
    !query.isFetching &&
    !query.isError &&
    !stale &&
    !mutation.isPending &&
    preview &&
    !preview.entry.issue &&
    preview.skill.status !== 'conflict' &&
    (!requiresReplacement || confirmed);
  async function apply() {
    if (!canApply || !preview) return;
    setError('');
    try {
      await mutation.mutateAsync({
        suffix: preview.update ? 'market-update' : 'market',
        method: 'POST',
        body: preview.update
          ? {
              id,
              update: {
                id: preview.update.id,
                version: preview.update.version,
                revision: preview.update.revision,
                ...(requiresReplacement ? { replaceLocal: true } : {}),
              },
            }
          : { id, revision: preview.skill.revision },
      });
      onSaved(preview.update ? '审核更新已应用' : 'Skill 已安装并启用');
      onClose();
    } catch (cause) {
      if (isConflict(cause)) {
        setStale(true);
        setConfirmedAt(undefined);
      }
      setError(
        `${messageOf(cause)}${isConflict(cause) ? ' 请重新读取预览、核对新旧正文后再应用。' : ' 可重试，或重新读取预览。'}`,
      );
    }
  }
  async function reload() {
    setError('');
    setStale(true);
    setConfirmedAt(undefined);
    const result = await query.refetch();
    if (result.isSuccess) setStale(false);
  }
  return (
    <FeatureDialog
      title="Skill 市场 · 预览"
      description={`当前项目 · ${projectName}`}
      busy={mutation.isPending}
      onClose={onClose}
    >
      <div className="ext-market-preview">
        <p className="ext-save-state" role="status" aria-live="polite">
          {mutation.isPending ? '正在应用…' : query.isFetching ? '正在读取固定版本并校验来源…' : ''}
        </p>
        <ErrorMessage error={error || query.error} />
        {preview ? (
          <div className="ext-market-preview">
            <h3>{preview.skill.title || preview.skill.name}</h3>
            <p className="ext-help">
              安装别名 /{preview.skill.name} · {preview.skill.publisher}
            </p>
            <MarketStatus skill={preview.skill} />
            <Capabilities skill={preview.skill} />
            <MarketSource skill={preview.skill} />
            {preview.entry.issue ? (
              <p className="ext-compatibility">{preview.entry.issue}</p>
            ) : null}
            <p className="ext-help">
              {preview.update
                ? preview.skill.legacy
                  ? '当前安装来自 atelier 的旧版内置正文。应用迁移会换成市场审核的公开版本，并保留调用名和启停状态。'
                  : '请比较当前正文与审核后的新正文。应用更新会保留调用名和启停状态。'
                : '确认正文与来源后，安装到当前项目。'}
            </p>
            <div className="ext-preview-columns">
              {preview.update ? (
                <section className="ext-preview-pane">
                  <h4>当前项目正文 · v{preview.update.version}</h4>
                  <pre className="ext-body-preview" tabIndex={0}>
                    {preview.localBody}
                  </pre>
                  <BackupActions
                    key={`${query.dataUpdatedAt}`}
                    body={preview.localBody ?? ''}
                    name={preview.skill.name}
                    version={preview.update.version}
                  />
                </section>
              ) : null}
              <section className="ext-preview-pane">
                <div className="ext-market-preview-toolbar">
                  <h4>
                    审核后的正文 ·{' '}
                    {preview.skill.commit?.slice(0, 12) || preview.skill.revision.slice(0, 12)}
                  </h4>
                  <div
                    role="group"
                    aria-label="审核正文显示方式"
                    className="ext-market-preview-switch"
                  >
                    <ActionButton
                      primary={!showSource}
                      aria-pressed={!showSource}
                      onClick={() => setShowSource(false)}
                    >
                      阅读
                    </ActionButton>
                    <ActionButton
                      primary={showSource}
                      aria-pressed={showSource}
                      onClick={() => setShowSource(true)}
                    >
                      源文件
                    </ActionButton>
                  </div>
                </div>
                {showSource ? (
                  <pre className="ext-body-preview" tabIndex={0}>
                    {preview.entry.body}
                  </pre>
                ) : (
                  <MarkdownPreview
                    standalone
                    body={preview.entry.body
                      .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
                      .trimStart()}
                  />
                )}
              </section>
            </div>
            {requiresReplacement ? (
              <fieldset
                className="ext-replacement"
                disabled={mutation.isPending || query.isFetching || stale}
              >
                <p>当前正文包含本地修改，应用将覆盖这些修改。可先复制或下载备份。</p>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) =>
                      setConfirmedAt(event.target.checked ? query.dataUpdatedAt : undefined)
                    }
                  />
                  我已检查新旧正文，确认替换本地修改
                </label>
              </fieldset>
            ) : null}
          </div>
        ) : null}
        <div className="ext-dialog-actions">
          <ActionButton disabled={mutation.isPending} onClick={onBack}>
            返回市场
          </ActionButton>
          <ActionButton
            disabled={mutation.isPending || query.isFetching}
            onClick={() => void reload()}
          >
            重新读取预览
          </ActionButton>
          <ActionButton primary disabled={!canApply} onClick={() => void apply()}>
            {preview?.update
              ? requiresReplacement
                ? '替换本地正文并应用更新'
                : preview.skill.legacy
                  ? '应用迁移'
                  : '应用审核更新'
              : '安装并启用'}
          </ActionButton>
        </div>
      </div>
    </FeatureDialog>
  );
}

/**
 * @file 提供 SkillHub 市场的搜索、预览与安装界面。
 * @implementation 按关键词和类别展示结果，预览公开来源并安装技能；已安装技能可通过回调启动。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { getTranslator, useUiTranslation } from '@/i18n';
import { ArrowLeft, ChevronRight, Search } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { usePublicExtensionPreview } from '@/use-query/extensions/use-public-extension-preview';
import { useImportPublicExtension } from '@/use-query/extensions/use-import-public-extension';
import {
  extensionDetail,
  messageOf,
  useExtensions,
  useSkillHubSearch,
  type SkillHubItem,
  type StartSkill,
} from './api';
import { ActionButton, ErrorMessage, MarketCategoryIcon, MarkdownPreview } from './components';

const categoryLabels: Record<string, string> = {
  get 'dev-programming'() {
    return getTranslator('extensions')('category.programming');
  },
  get professional() {
    return getTranslator('extensions')('category.professional');
  },
  get 'ai-agent'() {
    return getTranslator('extensions')('category.agent');
  },
  get 'design-media'() {
    return getTranslator('extensions')('category.design');
  },
  get 'knowledge-management'() {
    return getTranslator('extensions')('category.knowledge');
  },
  get 'office-efficiency'() {
    return getTranslator('extensions')('category.office');
  },
  get 'data-analysis'() {
    return getTranslator('extensions')('category.data');
  },
  get 'content-creation'() {
    return getTranslator('extensions')('category.content');
  },
  get 'life-service'() {
    return getTranslator('extensions')('category.life');
  },
  get 'business-ops'() {
    return getTranslator('extensions')('category.business');
  },
};

export function SkillHubMarket({
  projectId,
  onSaved,
  onStartSkill,
}: {
  projectId: string;
  onSaved: (message: string) => void;
  onStartSkill?: StartSkill;
}) {
  const { t } = useUiTranslation('extensions');
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
  const install = useImportPublicExtension(projectId);
  const extensions = useExtensions(projectId);
  const results = useSkillHubSearch(projectId, query);
  const preview = usePublicExtensionPreview(projectId, {
    source: selected?.source ?? '',
    kind: 'skill',
  });
  const entry = preview.data?.[0];
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
        kind: 'skill',
        source: selected.source,
        key: entry.key,
        revision: entry.revision,
        packageDigest: entry.packageManifest?.digest,
      });
      const status = t('market.importedNotice', { name: entry.name });
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
        { id: installed.id, version: installed.version },
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
          aria-label={t('market.categoryLabel')}
          hidden={Boolean(selected)}
        >
          {['', ...categories].map((value) => (
            <ActionButton
              key={value}
              variant={value === category ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={value === category}
              onClick={() => {
                setCategory(value);
                if (resultScroll.current) resultScroll.current.scrollTop = 0;
              }}
            >
              {value ? (categoryLabels[value] ?? value) : t('market.allCategories')}
            </ActionButton>
          ))}
        </div>
      ) : null}
      <form className="skillhub-search" onSubmit={search} hidden={Boolean(selected)}>
        <label className="ext-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            name="q"
            autoComplete="off"
            placeholder={t('market.searchPlaceholder')}
            aria-label={t('market.searchLabel')}
            value={input}
            maxLength={120}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <ActionButton type="submit" variant="default" disabled={install.isPending}>
          {t('market.search')}
        </ActionButton>
      </form>
      <p className="sr-only" role="status">
        {message}
      </p>
      <div className="skillhub-browser">
        <section
          className="skillhub-results"
          aria-label={t('market.resultsLabel')}
          aria-busy={results.isFetching}
          hidden={Boolean(selected)}
        >
          <p className="market-result-count" role="status">
            {results.isFetching
              ? t('market.searching')
              : results.isSuccess
                ? t('market.resultsCount', {
                    label: query ? `「${query}」` : t('market.recommended'),
                    count: filtered.length,
                  })
                : t('market.skills')}
          </p>
          <div ref={resultScroll} className="skillhub-result-scroll">
            <ErrorMessage error={results.error} />
            {results.isSuccess && !filtered.length ? (
              <p className="skillhub-empty">{t('market.empty')}</p>
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
                        {item.description || t('common.noSummary')}
                      </span>
                    </span>
                    <span className="market-result-meta">
                      <span>{item.publisher || item.coordinate.split('/')[0]}</span>
                      <span>v{item.version}</span>
                    </span>
                    <ChevronRight aria-hidden="true" className="market-result-arrow" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <section
          id={detailId}
          className="skillhub-detail"
          aria-label={t('market.previewLabel')}
          hidden={!selected}
        >
          {selected ? (
            <>
              <div className="skillhub-detail-header">
                <ActionButton className="skillhub-back" disabled={install.isPending} onClick={back}>
                  <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                  {t('market.back')}
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
                {preview.isFetching ? <p role="status">{t('market.loading')}</p> : null}
                <ErrorMessage error={preview.error} />
                {entry?.packageManifest ? (
                  <details className="ext-preview">
                    <summary>
                      {t('market.packageFiles', { count: entry.packageManifest.files.length })}
                    </summary>
                    <pre className="ext-body-preview">{entry.packageManifest.files.join('\n')}</pre>
                  </details>
                ) : null}
                {entry?.issue ? (
                  <p className="ext-compatibility">{extensionDetail(entry.issue)}</p>
                ) : null}
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
                    ? t('market.installed')
                    : entry?.packageManifest
                      ? t('market.importPackage', { count: entry.packageManifest.files.length })
                      : t('market.manualImport')}
                </p>
                <ActionButton
                  variant="default"
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
                  {installed
                    ? t('market.imported')
                    : install.isPending
                      ? t('publicImport.importing')
                      : t('market.import')}
                </ActionButton>
                {installed &&
                installed.kind === 'skill' &&
                installed.enabled &&
                installed.supported &&
                installed.userInvocable &&
                onStartSkill ? (
                  <ActionButton
                    variant="default"
                    disabled={starting}
                    onClick={() => void startSkill()}
                  >
                    {starting ? t('market.opening') : t('market.useInChat')}
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

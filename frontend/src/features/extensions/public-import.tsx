/**
 * @file 提供公开来源扩展的查询、预览、导入和更新界面。
 * @implementation 查询 GitHub 候选及固定提交详情，翻译安装兼容性提示并管理安装、更新及对话选用。
 * @updated 2026-11-27T17:05:30+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useState, type FormEvent } from 'react';
import { Download, LoaderCircle, Search } from 'lucide-react';
import type { Extension } from '@shared/types';
import { usePublicExtensionPreview } from '@/use-query/extensions/use-public-extension-preview';
import { useGithubPublicConnection } from '@/use-query/extensions/use-github-public-connection';
import { useUpdateGithubPublicConnection } from '@/use-query/extensions/use-update-github-public-connection';
import { useImportPublicExtension } from '@/use-query/extensions/use-import-public-extension';
import { Badge } from '@/components/ui/badge';
import {
  ActionButton,
  BackupActions,
  ErrorMessage,
  FeatureDialog,
  Field,
  MarkdownPreview,
  SourceLink,
} from './components';
import {
  extensionDetail,
  isConflict,
  messageOf,
  useInvalidateExtensionPickers,
  type ExtensionKind,
  type PublicEntry,
  type StartSkill,
} from './api';
import { Input } from '@/components/ui/input';

export function PublicImport({
  projectId,
  projectName,
  kind,
  updating,
  onClose,
  onSaved,
  onStartSkill,
}: {
  projectId: string;
  projectName: string;
  kind: ExtensionKind;
  updating?: Extension;
  onClose: () => void;
  onSaved: (message: string) => void;
  onStartSkill?: StartSkill;
}) {
  const { t } = useUiTranslation('extensions');
  const initialSource = updating?.origin?.location ?? '';
  const [source, setSource] = useState(initialSource);
  const [submitted, setSubmitted] = useState(initialSource);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [choice, setChoice] = useState<PublicEntry>();
  const [installed, setInstalled] = useState<Extension>();
  const [starting, setStarting] = useState(false);
  const mutation = useImportPublicExtension(projectId);
  const invalidatePickers = useInvalidateExtensionPickers();
  const githubSource =
    kind === 'skill' &&
    !initialSource.startsWith('skillhub:') &&
    !submitted.startsWith('skillhub:');
  const github = useGithubPublicConnection(githubSource);
  const updateGithub = useUpdateGithubPublicConnection();
  const query = usePublicExtensionPreview(projectId, { source: submitted, kind });
  const results = (query.data ?? []).filter(
    (entry) => !updating || entry.key === updating.origin?.key,
  );
  const githubCatalog = githubSource && results.some((entry) => entry.github && !entry.revision);
  const choices = githubCatalog
    ? [...results].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)))
    : [];
  const available = choices.filter((entry) => !entry.issue);
  const recommended = available.filter((entry) => entry.recommended);
  const suggested =
    available.length === 1 ? available[0] : recommended.length === 1 ? recommended[0] : undefined;
  const selected = choice ?? (query.isSuccess && !query.isFetching ? suggested : undefined);
  // Pinned details have a distinct cache key and their own cancellation lifecycle.
  const detail = usePublicExtensionPreview(projectId, {
    source: selected?.location ?? '',
    kind,
    github: selected?.github,
  });
  const active = selected ? detail : query;
  const items = selected ? (detail.data ?? []) : results;
  const busy = active.isFetching || mutation.isPending || starting;
  const ready = Boolean(submitted) && active.isSuccess && !busy && !active.isError && !stale;
  const needsConfirmation = Boolean(updating && updating.kind !== 'mcp');
  function unchanged(entry: PublicEntry) {
    return Boolean(
      updating?.origin?.revision &&
      updating.origin.revision === entry.revision &&
      (!entry.github || updating.origin.packageDigest === entry.packageManifest?.digest),
    );
  }
  const skillPreview = githubSource
    ? items.find((entry) => entry.revision && entry.github)
    : undefined;
  const upToDate = skillPreview ? unchanged(skillPreview) : false;
  const canInstall =
    ready &&
    Boolean(skillPreview?.packageManifest && !skillPreview.issue && !upToDate) &&
    (!needsConfirmation || replaceConfirmed);
  const installVisible =
    githubSource && Boolean(submitted && (!updating || (skillPreview && !upToDate)));
  const phase = mutation.isPending
    ? t('publicImport.importing')
    : detail.isFetching && githubSource
      ? t('publicImport.loadingSkill')
      : active.isFetching
        ? t('publicImport.loading')
        : '';
  function changeSource(value: string) {
    setSource(value);
    if (submitted) {
      setSubmitted('');
      setChoice(undefined);
      setError('');
      setStale(false);
    }
  }
  function choose(entry: PublicEntry) {
    setChoice(entry);
    setError('');
    setStale(false);
  }
  async function load(value: string) {
    const normalized =
      kind === 'mcp' && !value.includes('://') && !value.startsWith('registry:')
        ? `registry:${value}`
        : value;
    setError('');
    setChoice(undefined);
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
      choose(entry);
      return;
    }
    setError('');
    try {
      const { item } = await mutation.mutateAsync({
        source: entry.location,
        key: entry.key,
        revision: entry.revision,
        packageDigest: entry.packageManifest?.digest,
        github: entry.github,
        kind,
        ...(updating ? { update: { id: updating.id, version: updating.version } } : {}),
      });
      if (item.kind !== 'skill') void invalidatePickers();
      onSaved(updating ? t('publicImport.synced') : t('publicImport.imported'));
      if (entry.github && !updating) setInstalled(item);
      else onClose();
    } catch (cause) {
      if (isConflict(cause)) {
        setStale(true);
        setReplaceConfirmed(false);
      }
      setError(`${messageOf(cause)}${isConflict(cause) ? t('publicImport.conflictSuffix') : ''}`);
    }
  }
  async function changeGithubConnection(connect: boolean) {
    try {
      await updateGithub.mutateAsync(connect);
      if (connect && submitted && active.isError) await active.refetch();
    } catch {
      // The connection mutation owns the error shown below the account controls.
    }
  }
  async function startSkill(item: Extension) {
    if (!onStartSkill || starting) return;
    setStarting(true);
    setError('');
    try {
      await onStartSkill(projectId, { id: item.id, version: item.version }, false);
    } catch (cause) {
      setError(messageOf(cause));
      setStarting(false);
    }
  }
  if (installed) {
    return (
      <FeatureDialog
        title={t('publicImport.imported')}
        description={installed.name}
        busy={starting}
        onClose={onClose}
      >
        <ErrorMessage error={error} />
        <div className="ext-dialog-actions">
          {onStartSkill &&
          installed.kind === 'skill' &&
          installed.enabled &&
          installed.userInvocable ? (
            <ActionButton
              variant="default"
              disabled={starting}
              onClick={() => void startSkill(installed)}
            >
              {t('market.useInChat')}
            </ActionButton>
          ) : null}
          <ActionButton disabled={starting} onClick={onClose}>
            {t('common.close')}
          </ActionButton>
        </div>
      </FeatureDialog>
    );
  }
  function searchContext7() {
    setSource('context7');
    void load('context7');
  }
  return (
    <FeatureDialog
      title={updating ? t('publicImport.sync') : t('extensions.publicImport')}
      description={t('publicImport.project', { name: projectName })}
      busy={mutation.isPending}
      className="ext-public-import-dialog"
      onClose={onClose}
    >
      <form className="ext-public-import" onSubmit={submit}>
        <div className="ext-import-source">
          <Field
            label={
              kind === 'mcp' ? t('publicImport.registrySource') : t('publicImport.githubSource')
            }
          >
            <Input
              autoFocus
              readOnly={Boolean(updating)}
              required
              maxLength={4096}
              autoComplete="off"
              value={source}
              disabled={mutation.isPending}
              onChange={(event) => changeSource(event.target.value)}
            />
          </Field>
          <ActionButton
            type="submit"
            variant={installVisible ? 'outline' : 'default'}
            disabled={busy || !source.trim()}
          >
            <Search data-icon="inline-start" aria-hidden="true" />
            {updating ? t('extensions.checkUpdates') : t('publicImport.query')}
          </ActionButton>
        </div>
        {githubSource ? (
          <div className="ext-import-account">
            <p className="ext-help" role="status">
              {github.data?.login
                ? t('publicImport.githubConnected', { login: github.data.login })
                : t('publicImport.githubAnonymous')}
            </p>
            <ActionButton
              variant="ghost"
              size="sm"
              disabled={busy || github.isPending || updateGithub.isPending}
              onClick={() => void changeGithubConnection(!github.data?.login)}
            >
              {github.data?.login
                ? t('publicImport.githubDisconnect')
                : t('publicImport.githubConnect')}
            </ActionButton>
            {updateGithub.error ? (
              <div className="basis-full">
                <ErrorMessage error={updateGithub.error} />
                <SourceLink url="https://cli.github.com/manual/gh_auth_login">
                  {t('publicImport.githubLoginHelp')}
                </SourceLink>
              </div>
            ) : null}
          </div>
        ) : kind === 'mcp' && !updating ? (
          <div>
            <ActionButton disabled={busy} size="sm" onClick={searchContext7}>
              {t('publicImport.searchContext7')}
            </ActionButton>
          </div>
        ) : null}
        <div className="ext-import-content">
          {selected && !githubCatalog ? (
            <ActionButton
              size="sm"
              disabled={mutation.isPending}
              onClick={() => {
                setChoice(undefined);
                setError('');
                setStale(false);
              }}
            >
              {t('publicImport.backToResults')}
            </ActionButton>
          ) : null}
          <ErrorMessage error={active.error} />
          {updating && updating.kind !== 'mcp' && !upToDate ? (
            <section className="ext-preview-pane">
              <details>
                <summary>{t('publicImport.localVersion', { version: updating.version })}</summary>
                <pre className="ext-body-preview" tabIndex={0}>
                  {updating.body}
                </pre>
                <BackupActions
                  body={updating.body}
                  name={updating.name}
                  version={updating.version}
                />
              </details>
              <fieldset className="ext-replacement" disabled={busy}>
                <p>{t('publicImport.replaceWarning')}</p>
                <label>
                  <input
                    type="checkbox"
                    checked={replaceConfirmed}
                    onChange={(event) => setReplaceConfirmed(event.target.checked)}
                  />
                  {t('publicImport.confirmReplace')}
                </label>
              </fieldset>
            </section>
          ) : null}
          {githubSource ? (
            <>
              {githubCatalog || skillPreview ? (
                <div className={githubCatalog ? 'ext-import-catalog' : undefined}>
                  {githubCatalog ? (
                    <section className="ext-import-results">
                      <h3>{t('publicImport.skillResults', { count: results.length })}</h3>
                      <ul className="ext-import-choices">
                        {choices.map((entry) => (
                          <li key={entry.key}>
                            <ActionButton
                              className="ext-import-choice"
                              variant={selected?.key === entry.key ? 'secondary' : 'ghost'}
                              aria-pressed={selected?.key === entry.key}
                              disabled={mutation.isPending || Boolean(entry.issue)}
                              onClick={() => choose(entry)}
                            >
                              <span className="ext-import-choice-title">
                                <strong>{entry.name}</strong>
                                {entry.recommended ? (
                                  <Badge variant="secondary">
                                    {t('publicImport.claudeRecommended')}
                                  </Badge>
                                ) : null}
                              </span>
                              <code>{entry.key}</code>
                              {entry.issue ? <span>{extensionDetail(entry.issue)}</span> : null}
                            </ActionButton>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {skillPreview ? (
                    <GithubSkillPreview entry={skillPreview} current={upToDate} />
                  ) : githubCatalog && !selected ? (
                    <p className="ext-import-empty">{t('publicImport.chooseSkill')}</p>
                  ) : null}
                </div>
              ) : null}
              {!githubCatalog && items[0]?.issue ? (
                <p className="ext-compatibility">{extensionDetail(items[0].issue)}</p>
              ) : null}
            </>
          ) : (
            <div className="grid gap-3">
              {items.map((entry) => (
                <article className="ext-card gap-3" key={`${entry.location}:${entry.key}`}>
                  <strong>{entry.name}</strong>
                  {entry.description ? <p>{entry.description}</p> : null}
                  {entry.body != null ? (
                    <>
                      <pre className="ext-body-preview" tabIndex={0}>
                        {entry.body}
                      </pre>
                      <MarkdownPreview body={entry.body} label={t('publicImport.preview')} />
                    </>
                  ) : entry.transport ? (
                    <pre className="ext-body-preview">
                      {JSON.stringify(entry.transport, null, 2)}
                    </pre>
                  ) : null}
                  {entry.issue ? (
                    <p className="ext-compatibility">{extensionDetail(entry.issue)}</p>
                  ) : unchanged(entry) ? (
                    <p className="ext-help">{t('publicImport.upToDate')}</p>
                  ) : (
                    <ActionButton
                      variant="default"
                      disabled={!ready || (needsConfirmation && !replaceConfirmed)}
                      onClick={() => void select(entry)}
                    >
                      {entry.revision
                        ? updating
                          ? t('publicImport.applyUpdate')
                          : t('publicImport.import')
                        : t('publicImport.viewFile')}
                    </ActionButton>
                  )}
                </article>
              ))}
            </div>
          )}
          {submitted && active.isSuccess && !items.length && !githubCatalog ? (
            <p className="ext-import-empty">{t('publicImport.noMatches')}</p>
          ) : null}
        </div>
        <ErrorMessage error={error} />
        <footer className="ext-import-footer">
          <div className="ext-import-status" role="status">
            {phase ? (
              <>
                <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
                {phase}
              </>
            ) : null}
          </div>
          <ActionButton disabled={mutation.isPending} onClick={onClose}>
            {t('common.close')}
          </ActionButton>
          {installVisible ? (
            <ActionButton
              variant="default"
              disabled={!canInstall}
              onClick={() => {
                if (skillPreview) void select(skillPreview);
              }}
            >
              <Download data-icon="inline-start" aria-hidden="true" />
              {updating ? t('publicImport.applyUpdate') : t('publicImport.installSkill')}
            </ActionButton>
          ) : null}
        </footer>
      </form>
    </FeatureDialog>
  );
}

function GithubSkillPreview({ entry, current }: { entry: PublicEntry; current: boolean }) {
  const { t } = useUiTranslation('extensions');
  const manifest = entry.packageManifest;
  const version = entry.github;
  return (
    <article className="ext-import-skill">
      <header>
        <h3>{entry.name}</h3>
        {version ? (
          <code title={version.commit}>
            {t('publicImport.githubCommit', { commit: version.commit.slice(0, 12) })}
          </code>
        ) : null}
      </header>
      {entry.description ? <p>{entry.description}</p> : null}
      {entry.compatibility || entry.issue ? (
        <p className="ext-compatibility">
          {extensionDetail(entry.issue ?? entry.compatibility, 'github-preview')}
        </p>
      ) : null}
      {current ? <p className="ext-help">{t('publicImport.upToDate')}</p> : null}
      {manifest ? (
        <details className="ext-import-files">
          <summary>{t('publicImport.packageFiles', { count: manifest.files.length })}</summary>
          <ul className="ext-package-files">
            {manifest.files.map((path) => (
              <li key={path} className="flex flex-wrap items-center gap-2">
                <code className="break-all">{path}</code>
                {manifest.executables?.includes(path) ? (
                  <Badge variant="outline">{t('publicImport.executable')}</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {entry.body != null ? (
        <MarkdownPreview body={entry.body} label={t('publicImport.skillBody')} />
      ) : null}
      <p className="ext-help">{t('publicImport.githubPolicy')}</p>
    </article>
  );
}

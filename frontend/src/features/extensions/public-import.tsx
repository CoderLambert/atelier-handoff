/**
 * @file 提供公开来源扩展的预览、导入和更新界面。
 * @implementation 查询来源条目，按版本信息提交导入；更新时处理替换确认和冲突后的重新预览。
 * @updated 2026-11-23T04:48:56+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useState, type FormEvent } from 'react';
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
  extensionDetail,
  isConflict,
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
  const { t } = useUiTranslation('extensions');
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
      onSaved(updating ? t('publicImport.synced') : t('publicImport.imported'));
      onClose();
    } catch (cause) {
      if (isConflict(cause)) {
        setStale(true);
        setReplaceConfirmed(false);
      }
      setError(`${messageOf(cause)}${isConflict(cause) ? t('publicImport.conflictSuffix') : ''}`);
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
      title={updating ? t('publicImport.sync') : t('extensions.publicImport')}
      description={t('publicImport.project', { name: projectName })}
      busy={mutation.isPending}
      onClose={onClose}
    >
      <form className="ext-editor" onSubmit={submit}>
        <Field
          label={kind === 'mcp' ? t('publicImport.registrySource') : t('publicImport.githubSource')}
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
              {kind === 'mcp' ? t('publicImport.searchContext7') : t('publicImport.frontendDesign')}
            </ActionButton>
          ) : null}
          <ActionButton type="submit" disabled={busy || !source.trim()}>
            {updating ? t('extensions.checkUpdates') : t('publicImport.query')}
          </ActionButton>
        </div>
        <p className="ext-save-state" role="status">
          {mutation.isPending
            ? t('publicImport.importing')
            : query.isFetching
              ? t('publicImport.loading')
              : ''}
        </p>
        <ErrorMessage error={error || query.error} />
        {updating && updating.kind !== 'mcp' ? (
          <section className="ext-preview-pane">
            <h4>{t('publicImport.localVersion', { version: updating.version })}</h4>
            <pre className="ext-body-preview" tabIndex={0}>
              {updating.body}
            </pre>
            <BackupActions body={updating.body} name={updating.name} version={updating.version} />
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
                    <MarkdownPreview body={entry.body} label={t('publicImport.preview')} />
                  </>
                ) : entry.transport ? (
                  <pre className="ext-body-preview">{JSON.stringify(entry.transport, null, 2)}</pre>
                ) : null}
                {entry.issue ? (
                  <p className="ext-compatibility">{extensionDetail(entry.issue)}</p>
                ) : unchanged ? (
                  <p className="ext-help">{t('publicImport.upToDate')}</p>
                ) : (
                  <ActionButton
                    variant="default"
                    disabled={
                      !ready || mutation.isPending || (needsConfirmation && !replaceConfirmed)
                    }
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
            );
          })}
        </div>
        {submitted && query.isSuccess && !query.data.length ? (
          <p className="ext-help">{t('publicImport.noMatches')}</p>
        ) : null}
        <div className="ext-dialog-actions">
          <ActionButton disabled={mutation.isPending} onClick={onClose}>
            {t('common.close')}
          </ActionButton>
        </div>
      </form>
    </FeatureDialog>
  );
}

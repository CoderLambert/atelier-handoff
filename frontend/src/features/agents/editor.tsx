/**
 * @file 提供智能体配置编辑对话框。
 * @implementation 管理配置草稿、依赖刷新和版本冲突，在保存前重新检查依赖，并处理放弃更改确认。
 * @updated 2026-11-23T04:52:18+08:00
 */
import { OptionsSelect } from '@/components/options-select';
import { useUiTranslation } from '@/i18n';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentCard, AgentConfig } from '@shared/types';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { extensionsQuery, messageOf, useExtensions } from '@/features/extensions/api';
import {
  agentsQuery,
  capabilityLabels,
  capabilityOptions,
  dependencyIssues,
  dependencyRefresh,
  initialConfig,
  needsEdit,
  useAgentMutation,
} from './api';
import { AgentDialog, AgentProblems } from './components';
import { AgentDependencies } from './dependencies';

export function AgentEditor({
  projectId,
  projectName,
  initialItem,
  template = false,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  initialItem?: AgentCard;
  template?: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t } = useUiTranslation('extensions');
  const client = useQueryClient();
  const save = useAgentMutation(projectId);
  const extensions = useExtensions(projectId);
  const agents = useQuery(agentsQuery(projectId));
  const id = useId();
  const [item, setItem] = useState(initialItem);
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(initialItem?.config ?? initialConfig(template)),
  );
  const [config, setConfig] = useState<AgentConfig>(() =>
    structuredClone(initialItem?.config ?? initialConfig(template)),
  );
  const [working, setWorking] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [discard, setDiscard] = useState(false);
  const [replacement, setReplacement] = useState<AgentCard>();
  const [refresh, setRefresh] = useState<ReturnType<typeof dependencyRefresh>>();
  const latest = item ? agents.data?.find((value) => value.id === item.id) : undefined;
  const revisionChanged = Boolean(item && latest && latest.revisionId !== item.revisionId);
  const archived = Boolean(item?.archived || latest?.archived);
  const missing = Boolean(item && agents.isSuccess && !latest);
  const busy = working || save.isPending;
  const dirty = JSON.stringify(config) !== baseline;
  const issues = extensions.data ? dependencyIssues(config, extensions.data) : [];
  const badCapabilities = config.mode === 'readonly' && config.capabilities.some(needsEdit);
  const blocked = Boolean(
    archived ||
    missing ||
    revisionChanged ||
    badCapabilities ||
    issues.length ||
    extensions.isPending ||
    extensions.isError ||
    extensions.isFetching,
  );
  function change(next: AgentConfig) {
    setConfig(next);
    setNotice('');
    setError('');
  }
  function close() {
    if (busy) return;
    if (dirty && !archived) setDiscard(true);
    else onClose();
  }
  async function refreshDependencies() {
    if (lock.current) return;
    lock.current = true;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const items = await client.fetchQuery({ ...extensionsQuery(projectId), staleTime: 0 });
      const result = dependencyRefresh(config, items);
      if (result.changes.length) setRefresh(result);
      else setNotice(t('agentEditor.dependenciesCurrent'));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  async function loadLatest() {
    if (!item || lock.current) return;
    lock.current = true;
    setWorking(true);
    setError('');
    try {
      const items = await client.fetchQuery({ ...agentsQuery(projectId), staleTime: 0 });
      const found = items.find((value) => value.id === item.id);
      if (!found) throw new Error(t('agentEditor.missingAgent'));
      setReplacement(found);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || blocked || refresh || replacement || discard) return;
    const prepared: AgentConfig = {
      ...config,
      name: config.name.trim(),
      description: config.description.trim(),
      instructions: config.instructions.trim(),
      starters: config.starters.map((value) => value.trim()).filter(Boolean),
    };
    if (!prepared.name || !prepared.instructions) {
      setError(t('agentEditor.required'));
      return;
    }
    lock.current = true;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      // Check the latest dependency list immediately before saving the pinned versions.
      const items = await client.fetchQuery({ ...extensionsQuery(projectId), staleTime: 0 });
      if (dependencyIssues(prepared, items).length) {
        setError(t('agentEditor.dependenciesChanged'));
        return;
      }
      const saved = await save.mutateAsync(
        item
          ? { action: 'save', id: item.id, baseRevisionId: item.revisionId, config: prepared }
          : { action: 'create', config: prepared },
      );
      onSaved(t('agentEditor.saved', { name: saved.config.name, version: saved.version }));
      onClose();
    } catch (cause) {
      setError(t('agentEditor.saveError', { error: messageOf(cause) }));
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  return (
    <>
      <AgentDialog
        title={
          archived
            ? t('agentEditor.viewTitle')
            : item
              ? t('agentEditor.editTitle')
              : template
                ? t('agentEditor.templateTitle')
                : t('agents.create')
        }
        description={`${projectName}${item ? ` · v${item.version}` : ''} · ${t('agentEditor.versionHelp')}`}
        busy={busy}
        wide
        onClose={close}
      >
        <form onSubmit={(event) => void submit(event)}>
          {archived ? <p className="agent-callout">{t('agentEditor.archived')}</p> : null}
          {missing ? (
            <p className="agent-error" role="alert">
              {t('agentEditor.missing')}
            </p>
          ) : null}
          {revisionChanged ? (
            <div className="agent-callout" role="alert">
              <p>{t('agentEditor.conflict')}</p>
              <Button variant="secondary" disabled={busy} onClick={() => void loadLatest()}>
                {t('agentEditor.loadLatest')}
              </Button>
            </div>
          ) : null}
          <fieldset
            className="agent-editor-fields"
            disabled={busy || archived || Boolean(refresh || replacement || discard)}
          >
            <section className="agent-editor-section">
              <h3>{t('agentEditor.basicInfo')}</h3>
              <div className="agent-basic-fields">
                <label className="agent-field">
                  <span>
                    {t('agentEditor.nameLabel') + ' '}
                    <span aria-hidden="true">*</span>
                  </span>
                  <input
                    required
                    value={config.name}
                    placeholder={t('agentEditor.namePlaceholder')}
                    onChange={(event) => change({ ...config, name: event.target.value })}
                  />
                </label>
                <label className="agent-field">
                  <span>{t('agentEditor.introLabel')}</span>
                  <input
                    value={config.description}
                    placeholder={t('agentEditor.introPlaceholder')}
                    onChange={(event) => change({ ...config, description: event.target.value })}
                  />
                </label>
              </div>
              <label className="agent-field">
                <span>
                  {t('agentEditor.instructionsLabel') + ' '}
                  <span aria-hidden="true">*</span>
                </span>
                <textarea
                  required
                  rows={7}
                  value={config.instructions}
                  placeholder={t('agentEditor.instructionsPlaceholder')}
                  onChange={(event) => change({ ...config, instructions: event.target.value })}
                />
                <small>{t('agentEditor.instructionsHelp')}</small>
              </label>
            </section>
            <section className="agent-editor-section">
              <h3>{t('agentEditor.starters')}</h3>
              <p className="agent-help">{t('agentEditor.startersHelp')}</p>
              <div className="agent-starters">
                {config.starters.map((starter, index) => (
                  <div className="agent-starter" key={index}>
                    <input
                      aria-label={t('agentEditor.starterLabel', { number: index + 1 })}
                      value={starter}
                      placeholder={t('agentEditor.starterPlaceholder')}
                      onChange={(event) =>
                        change({
                          ...config,
                          starters: config.starters.map((value, position) =>
                            position === index ? event.target.value : value,
                          ),
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      aria-label={t('agentEditor.removeStarter', { number: index + 1 })}
                      onClick={() =>
                        change({
                          ...config,
                          starters: config.starters.filter((_, position) => position !== index),
                        })
                      }
                    >
                      {t('common.remove')}
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="secondary"
                onClick={() => change({ ...config, starters: [...config.starters, ''] })}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                {t('agentEditor.addStarter')}
              </Button>
            </section>
            <section className="agent-editor-section">
              <h3>{t('agentEditor.capabilitiesTitle')}</h3>
              <label className="agent-field agent-mode-field">
                <span>{t('agentEditor.modeLabel')}</span>
                <OptionsSelect
                  aria-label={t('agentEditor.modeLabel')}
                  className="w-full"
                  value={config.mode}
                  options={[
                    { value: 'readonly', label: t('agents.readonlyMode') },
                    { value: 'edit', label: t('agentEditor.controlledEdit') },
                  ]}
                  onValueChange={(mode) => {
                    change({
                      ...config,
                      mode,
                      capabilities:
                        mode === 'readonly'
                          ? config.capabilities.filter((value) => !needsEdit(value))
                          : config.capabilities,
                    });
                  }}
                />
                <small>{t('agentEditor.modeHelp')}</small>
              </label>
              <div className="agent-capability-grid">
                {capabilityOptions.map((capability) => (
                  <label className="agent-check agent-capability" key={capability}>
                    <input
                      type="checkbox"
                      checked={config.capabilities.includes(capability)}
                      disabled={config.mode === 'readonly' && needsEdit(capability)}
                      onChange={(event) =>
                        change({
                          ...config,
                          capabilities: event.target.checked
                            ? [...config.capabilities, capability]
                            : config.capabilities.filter((value) => value !== capability),
                        })
                      }
                    />
                    <span>
                      <strong>{capabilityLabels[capability].label}</strong>
                      <small>{capabilityLabels[capability].description}</small>
                    </span>
                  </label>
                ))}
              </div>
              {badCapabilities ? (
                <p className="agent-error">{t('agentEditor.invalidCapabilities')}</p>
              ) : null}
            </section>
            <section
              className="agent-editor-section agent-dependency-status"
              aria-labelledby={`${id}-dependencies`}
            >
              <div>
                <h3 id={`${id}-dependencies`}>{t('agentEditor.dependenciesTitle')}</h3>
                <p className="agent-help">{t('agentEditor.dependenciesHelp')}</p>
              </div>
              <Button
                variant="secondary"
                disabled={extensions.isFetching}
                onClick={() => void refreshDependencies()}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {extensions.isFetching
                  ? t('agentEditor.reading')
                  : t('agentEditor.refreshDependencies')}
              </Button>
            </section>
            {extensions.isPending ? (
              <p role="status" className="agent-help">
                {t('extensions.loading')}
              </p>
            ) : null}
            {extensions.isError ? (
              <p className="agent-error" role="alert">
                {t('agentEditor.dependencyError', { error: messageOf(extensions.error) })}
              </p>
            ) : null}
            {extensions.data ? (
              <AgentDependencies config={config} items={extensions.data} onChange={change} />
            ) : null}
          </fieldset>
          <AgentProblems issues={issues} label={t('agentEditor.dependencyProblems')} />
          {notice ? (
            <p className="agent-notice" role="status">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="agent-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="agent-dialog-actions">
            <Button variant="secondary" disabled={busy} onClick={close}>
              {archived ? t('common.close') : t('common.cancel')}
            </Button>
            {!archived ? (
              <Button type="submit" disabled={busy || blocked}>
                {busy
                  ? t('common.saving')
                  : item
                    ? t('agentEditor.saveVersion')
                    : t('agents.create')}
              </Button>
            ) : null}
          </footer>
        </form>
      </AgentDialog>
      {refresh ? (
        <AgentDialog
          title={t('agentEditor.confirmDependencies')}
          description={t('agentEditor.confirmDependenciesHelp')}
          onClose={() => setRefresh(undefined)}
        >
          <ul className="agent-refresh-list">
            {refresh.changes.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
          <p className="agent-help">{t('agentEditor.refreshHelp')}</p>
          <footer className="agent-dialog-actions">
            <Button variant="secondary" onClick={() => setRefresh(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                setConfig(refresh.config);
                setRefresh(undefined);
                setError('');
                setNotice(t('agentEditor.dependenciesUpdated'));
              }}
            >
              {t('agentEditor.confirmDraftUpdate')}
            </Button>
          </footer>
        </AgentDialog>
      ) : null}
      {replacement ? (
        <AgentDialog
          title={t('agentEditor.loadTitle')}
          description={t('agentEditor.replaceConfirmation', {
            name: replacement.config.name,
            version: replacement.version,
          })}
          onClose={() => setReplacement(undefined)}
        >
          <p>{t('agentEditor.unsavedLost')}</p>
          <footer className="agent-dialog-actions">
            <Button variant="secondary" onClick={() => setReplacement(undefined)}>
              {t('agentEditor.keepEditing')}
            </Button>
            <Button
              onClick={() => {
                setItem(replacement);
                setConfig(structuredClone(replacement.config));
                setBaseline(JSON.stringify(replacement.config));
                setReplacement(undefined);
                setError('');
                setNotice(t('agentEditor.loaded'));
              }}
            >
              {t('agentEditor.confirmLoad')}
            </Button>
          </footer>
        </AgentDialog>
      ) : null}
      {discard ? (
        <AgentDialog
          title={t('agentEditor.discardTitle')}
          description={t('agentEditor.discardHelp')}
          onClose={() => setDiscard(false)}
        >
          <footer className="agent-dialog-actions">
            <Button variant="secondary" onClick={() => setDiscard(false)}>
              {t('agentEditor.continueEditing')}
            </Button>
            <Button variant="destructive" onClick={onClose}>
              {t('agentEditor.discard')}
            </Button>
          </footer>
        </AgentDialog>
      ) : null}
    </>
  );
}

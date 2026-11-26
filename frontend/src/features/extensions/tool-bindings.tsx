/**
 * @file 提供技能工具绑定编辑对话框。
 * @implementation 加载绑定及扩展信息，维护可选择和编辑的绑定草稿，并提交保存。
 * @updated 2026-11-23T04:51:57+08:00
 */
import { OptionsSelect } from '@/components/options-select';
import { useUiTranslation } from '@/i18n';
import { Plus, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { SkillToolBinding } from '@shared/types';
import { ActionButton, ErrorMessage, FeatureDialog, Field } from './components';
import { messageOf, useExtensions, useSaveSkillToolBindings, useSkillToolBindings } from './api';
import { allowedTools } from './picker-model';
import {
  bindingKinds,
  builtinTools,
  maxBindings,
  mcpBindingIssue,
  newBinding,
  validateBindings,
} from './tool-bindings-model';

export function SkillToolBindingsDialog({
  projectId,
  projectName,
  skillId,
  skillName,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  skillId: string;
  skillName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useUiTranslation('extensions');
  const query = useSkillToolBindings(projectId, skillId);
  const extensions = useExtensions(projectId);
  const save = useSaveSkillToolBindings(projectId, skillId);
  const [draft, setDraft] = useState<SkillToolBinding[]>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const focusRow = useRef<number | undefined>(undefined);
  const nameInputs = useRef<(HTMLInputElement | null)[]>([]);
  const addButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const bindings = draft ?? query.data ?? [];
  const dirty = JSON.stringify(bindings) !== JSON.stringify(query.data ?? []);
  const items = extensions.data ?? [];
  const servers = items.filter((item) => item.kind === 'mcp');
  const hasMcp = bindings.some((binding) => binding.kind === 'mcp');
  const busy = save.isPending;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (focusRow.current === undefined) return;
    if (focusRow.current < 0) addButton.current?.focus();
    else nameInputs.current[focusRow.current]?.focus();
    focusRow.current = undefined;
  }, [bindings.length]);

  function change(next: SkillToolBinding[]) {
    setDraft(next);
    setError('');
    setNotice('');
  }
  function update(index: number, binding: SkillToolBinding) {
    change(bindings.map((value, position) => (position === index ? binding : value)));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !query.data || !dirty) return;
    setError('');
    setNotice('');
    try {
      const validated = validateBindings(bindings, items);
      await save.mutateAsync(validated);
      if (mounted.current) {
        setDraft(undefined);
        setNotice(t('bindings.saved'));
        onSaved();
      }
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    }
  }

  return (
    <FeatureDialog
      title={t('extensionEditor.bindings')}
      className="ext-binding-dialog"
      description={`${skillName} · ${projectName}`}
      busy={busy}
      onClose={onClose}
    >
      <form className="ext-binding-form" onSubmit={(event) => void submit(event)}>
        <div className="ext-binding-body">
          {query.isPending ? <p role="status">{t('bindings.loading')}</p> : null}
          {query.error ? (
            <div className="ext-error" role="alert">
              {messageOf(query.error)}
              <ActionButton
                disabled={query.isFetching || busy}
                onClick={() => void query.refetch()}
              >
                {t('bindings.reload')}
              </ActionButton>
            </div>
          ) : null}
          {query.data ? (
            <>
              <fieldset className="ext-binding-layout" disabled={busy}>
                <div className="ext-binding-list">
                  <div className="ext-binding-list-title">
                    <h3>{t('bindings.boundTools')}</h3>
                    <span>
                      {bindings.length} / {maxBindings}
                    </span>
                  </div>
                  {bindings.map((binding, index) => {
                    const service =
                      binding.kind === 'mcp'
                        ? servers.find((item) => item.id === binding.extensionId)
                        : undefined;
                    const target =
                      binding.kind === 'mcp' && binding.tool
                        ? `${service?.name ?? t('common.mcp')} / ${binding.tool}`
                        : binding.kind === 'builtin'
                          ? builtinTools[binding.tool]
                          : binding.kind === 'command'
                            ? binding.preset
                            : bindingKinds[binding.kind];
                    return (
                      <button
                        type="button"
                        className="ext-binding-list-item"
                        aria-pressed={activeIndex === index}
                        key={index}
                        onClick={() => setActiveIndex(index)}
                      >
                        <strong>{binding.name || t('bindings.unnamed')}</strong>
                        <span>{target}</span>
                      </button>
                    );
                  })}
                  <ActionButton
                    ref={addButton}
                    className="ext-binding-add"
                    disabled={bindings.length >= maxBindings}
                    onClick={() => {
                      setActiveIndex(bindings.length);
                      focusRow.current = bindings.length;
                      change([...bindings, newBinding('builtin')]);
                    }}
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {t('bindings.add')}
                  </ActionButton>
                  {hasMcp ? (
                    <div className="ext-binding-mcp-status">
                      <ErrorMessage error={extensions.error} />
                      <ActionButton
                        className="ext-binding-refresh"
                        disabled={extensions.isFetching || busy}
                        onClick={() => void extensions.refetch()}
                      >
                        <RefreshCw data-icon="inline-start" aria-hidden="true" />
                        {extensions.isFetching
                          ? t('bindings.refreshing')
                          : t('bindings.refreshMcp')}
                      </ActionButton>
                    </div>
                  ) : null}
                </div>
                {!bindings.length ? (
                  <p className="ext-binding-empty">{t('bindings.empty')}</p>
                ) : null}
                {bindings.map((binding, index) => {
                  if (index !== activeIndex) return null;
                  const label = binding.name || t('bindings.numberedLabel', { number: index + 1 });
                  const server =
                    binding.kind === 'mcp'
                      ? servers.find((item) => item.id === binding.extensionId)
                      : undefined;
                  const tools = server ? allowedTools(server, 'edit') : [];
                  const mcpIssue =
                    binding.kind === 'mcp' && extensions.data
                      ? mcpBindingIssue(binding, items)
                      : '';
                  return (
                    <fieldset className="ext-binding" key={index}>
                      <legend>{label}</legend>
                      <div className="ext-binding-fields">
                        <div className="ext-binding-pair">
                          <Field label={t('bindings.nameLabel')} help={t('bindings.nameHelp')}>
                            <input
                              ref={(element) => {
                                nameInputs.current[index] = element;
                              }}
                              required
                              pattern="[a-z][a-z0-9_]{0,31}"
                              maxLength={32}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="weather"
                              value={binding.name}
                              onChange={(event) =>
                                update(index, { ...binding, name: event.target.value })
                              }
                            />
                          </Field>
                          <Field label={t('bindings.sourceLabel')}>
                            <OptionsSelect
                              aria-label={t('bindings.sourceLabel')}
                              className="w-full"
                              value={binding.kind}
                              options={(
                                Object.keys(bindingKinds) as (keyof typeof bindingKinds)[]
                              ).map((value) => ({
                                value,
                                label: bindingKinds[value],
                              }))}
                              onValueChange={(kind) =>
                                update(index, newBinding(kind, binding.name))
                              }
                            />
                          </Field>
                        </div>
                        {binding.kind === 'builtin' ? (
                          <Field label={t('bindings.builtin')}>
                            <OptionsSelect
                              aria-label={t('bindings.builtin')}
                              className="w-full"
                              value={binding.tool}
                              options={(
                                Object.keys(builtinTools) as (keyof typeof builtinTools)[]
                              ).map((value) => ({
                                value,
                                label: `${builtinTools[value]} · ${value}`,
                              }))}
                              onValueChange={(tool) => update(index, { ...binding, tool })}
                            />
                          </Field>
                        ) : binding.kind === 'mcp' ? (
                          <>
                            <div className="ext-binding-pair">
                              <Field label={t('bindings.mcpService')}>
                                <OptionsSelect
                                  required
                                  aria-label={t('bindings.mcpService')}
                                  className="w-full"
                                  value={binding.extensionId}
                                  aria-describedby={`${id}-mcp-${index}`}
                                  options={[
                                    { value: '', label: t('bindings.chooseMcp') },
                                    ...(binding.extensionId && !server
                                      ? [
                                          {
                                            value: binding.extensionId,
                                            label: t('bindings.removedTarget', {
                                              name: binding.extensionId,
                                            }),
                                            disabled: true,
                                          },
                                        ]
                                      : []),
                                    ...servers.map((item) => {
                                      const available = allowedTools(item, 'edit').length > 0;
                                      return {
                                        value: item.id,
                                        label:
                                          item.name +
                                          (available ? '' : t('bindings.noToolsSuffix')),
                                        disabled: !available,
                                      };
                                    }),
                                  ]}
                                  onValueChange={(extensionId) => {
                                    const selected = servers.find(
                                      (item) => item.id === extensionId,
                                    );
                                    update(index, {
                                      ...binding,
                                      extensionId,
                                      tool: selected
                                        ? (allowedTools(selected, 'edit')[0]?.name ?? '')
                                        : '',
                                    });
                                  }}
                                />
                              </Field>
                              <Field label={t('bindings.allowedTools')}>
                                <OptionsSelect
                                  required
                                  aria-label={t('bindings.allowedTools')}
                                  className="w-full"
                                  value={binding.tool}
                                  disabled={!tools.length}
                                  aria-describedby={`${id}-mcp-${index}`}
                                  options={[
                                    { value: '', label: t('bindings.chooseTool') },
                                    ...(binding.tool &&
                                    !tools.some((tool) => tool.name === binding.tool)
                                      ? [
                                          {
                                            value: binding.tool,
                                            label: t('bindings.unavailableTarget', {
                                              name: binding.tool,
                                            }),
                                            disabled: true,
                                          },
                                        ]
                                      : []),
                                    ...tools.map((tool) => ({
                                      value: tool.name,
                                      label: `${tool.name} · ${tool.access === 'read' ? t('common.readOnly') : t('common.approval')}`,
                                    })),
                                  ]}
                                  onValueChange={(tool) => update(index, { ...binding, tool })}
                                />
                              </Field>
                            </div>
                            <p
                              className={mcpIssue ? 'ext-binding-warning' : 'ext-help'}
                              id={`${id}-mcp-${index}`}
                            >
                              {extensions.isPending
                                ? t('bindings.loadingMcp')
                                : mcpIssue || (!servers.length ? t('bindings.addMcpHelp') : '')}
                            </p>
                            {server?.tools.find((tool) => tool.name === binding.tool)
                              ?.description ? (
                              <p className="ext-help">
                                {
                                  server.tools.find((tool) => tool.name === binding.tool)
                                    ?.description
                                }
                              </p>
                            ) : null}
                          </>
                        ) : binding.kind === 'http' ? (
                          <>
                            <Field label={t('bindings.fixedUrl')} help={t('bindings.urlHelp')}>
                              <input
                                required
                                type="url"
                                maxLength={1000}
                                autoComplete="off"
                                spellCheck={false}
                                placeholder="https://wttr.in/{location}?format=j1"
                                value={binding.url}
                                onChange={(event) =>
                                  update(index, { ...binding, url: event.target.value })
                                }
                              />
                            </Field>
                            <Field
                              label={t('bindings.parameterLabel')}
                              help={t('bindings.parameterHelp')}
                            >
                              <input
                                required
                                pattern="[a-z][a-z0-9_]{0,31}"
                                maxLength={32}
                                autoComplete="off"
                                spellCheck={false}
                                value={binding.parameter}
                                onChange={(event) =>
                                  update(index, { ...binding, parameter: event.target.value })
                                }
                              />
                            </Field>
                            <Field
                              label={t('bindings.inputDescription')}
                              help={t('bindings.inputDescriptionHelp')}
                            >
                              <textarea
                                required
                                rows={2}
                                maxLength={300}
                                placeholder={t('bindings.weatherPlaceholder')}
                                value={binding.description}
                                onChange={(event) =>
                                  update(index, { ...binding, description: event.target.value })
                                }
                              />
                            </Field>
                            <p className="ext-help">{t('bindings.httpsHelp')}</p>
                          </>
                        ) : (
                          <>
                            <Field label={t('bindings.command')}>
                              <OptionsSelect
                                aria-label={t('bindings.command')}
                                className="w-full"
                                value={binding.preset}
                                options={[{ value: 'pdftotext', label: t('bindings.pdfPreset') }]}
                                disabled
                              />
                            </Field>
                            <p className="ext-help">{t('bindings.pdfHelp')}</p>
                          </>
                        )}
                        <div className="ext-binding-actions">
                          <ActionButton
                            variant="destructive"
                            aria-label={t('bindings.removeLabel', { name: label })}
                            onClick={() => {
                              const next = Math.max(0, index - 1);
                              setActiveIndex(next);
                              focusRow.current = bindings.length > 1 ? next : -1;
                              change(bindings.filter((_, position) => position !== index));
                            }}
                          >
                            {t('bindings.remove')}
                          </ActionButton>
                        </div>
                      </div>
                    </fieldset>
                  );
                })}
              </fieldset>
            </>
          ) : null}
          <ErrorMessage error={error} />
        </div>
        <div className="ext-dialog-actions">
          <span className="ext-save-state" role="status" aria-live="polite">
            {busy ? t('bindings.saving') : dirty ? t('bindings.unsaved') : notice}
          </span>
          <ActionButton disabled={busy} onClick={onClose}>
            {t('common.close')}
          </ActionButton>
          <ActionButton
            type="submit"
            variant="default"
            disabled={busy || !query.data || !dirty || (hasMcp && !extensions.data)}
          >
            {t('bindings.save')}
          </ActionButton>
        </div>
      </form>
    </FeatureDialog>
  );
}

/**
 * @file 提供 Skill 和 Command Markdown 扩展的独立编辑表单。
 * @implementation 按共享扩展契约校验名称、描述、来源与正文，支持导入本地 Markdown 文件并托管 Skill 工具绑定弹窗。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Switch } from '@/components/ui/switch';
import { useUiTranslation } from '@/i18n';
import {
  EXTENSION_BODY_MAX,
  EXTENSION_DESCRIPTION_MAX,
  EXTENSION_NAME_MAX,
  EXTENSION_SOURCE_MAX,
} from '@shared/extensions';
import {
  allowsAuto,
  autoEnabled,
  extensionDetail,
  isConflict,
  kinds,
  messageOf,
  returnedItem,
  useExtensionCache,
  useExtensionMutation,
  type MarkdownExtension,
} from './api';
import { ActionButton, ErrorMessage, FeatureDialog, Field, MarkdownPreview } from './components';
import { SkillToolBindingsDialog } from './tool-bindings';
import { parseExtensionPayload } from './validation';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export function deriveMarkdownExtensionName(filename: string): string {
  const stem = filename.replace(/\.(md|markdown)$/i, '').toLowerCase();
  const slug = stem
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  return slug.slice(0, EXTENSION_NAME_MAX);
}

export function MarkdownExtensionForm({
  projectId,
  projectName,
  initialItem,
  kind,
  importFile = false,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  initialItem?: MarkdownExtension;
  kind: 'skill' | 'command';
  importFile?: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t } = useUiTranslation('extensions');
  const id = useId();
  const save = useExtensionMutation(projectId);
  const cache = useExtensionCache(projectId);
  const [item, setItem] = useState(initialItem);
  const [name, setName] = useState(initialItem?.name ?? '');
  const [description, setDescription] = useState(initialItem?.description ?? '');
  const [enabled, setEnabled] = useState(initialItem?.enabled ?? true);
  const [source, setSource] = useState(initialItem?.source ?? 'manual');
  const [body, setBody] = useState(initialItem?.body ?? '');
  const [autoInvoke, setAutoInvoke] = useState(autoEnabled(initialItem));
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [working, setWorking] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [bindingsOpen, setBindingsOpen] = useState(false);
  const bindingsButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileSequence = useRef(0);
  const mounted = useRef(true);
  const busy = working || save.isPending || readingFile;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      fileSequence.current++;
    };
  }, []);

  useEffect(() => {
    if (importFile) fileInput.current?.click();
  }, [importFile]);

  async function importMarkdown(file?: File) {
    if (!file) return;
    const sequence = ++fileSequence.current;
    setReadingFile(true);
    try {
      if (!/\.(md|markdown)$/i.test(file.name))
        throw new Error(t('extensionEditor.markdownRequired'));
      if (file.size > 1048576) throw new Error(t('extensionEditor.markdownTooLarge'));
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!mounted.current || sequence !== fileSequence.current) return;
      const derived = deriveMarkdownExtensionName(file.name);
      setName((old) => (old.trim() || !derived ? old : derived));
      setSource(file.name.slice(0, EXTENSION_SOURCE_MAX));
      setBody(text);
      setError('');
    } catch (cause) {
      if (mounted.current && sequence === fileSequence.current)
        setError(cause instanceof TypeError ? t('extensionEditor.invalidUtf8') : messageOf(cause));
    } finally {
      if (mounted.current && sequence === fileSequence.current) setReadingFile(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || stale) return;
    let fields: ReturnType<typeof parseExtensionPayload>;
    try {
      fields = parseExtensionPayload({
        kind,
        name: name.trim(),
        description: description.trim(),
        enabled,
        source: source.trim(),
        body,
        ...(kind === 'skill' ? { autoInvoke: allowsAuto(item) && autoInvoke } : {}),
      });
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    setError('');
    setWorking(true);
    try {
      const result = await save.mutateAsync({
        suffix: item ? encodeURIComponent(item.id) : undefined,
        method: item ? 'PATCH' : 'POST',
        body: { ...fields, ...(item ? { version: item.version } : {}) },
      });
      const returned = returnedItem(result);
      if (mounted.current && returned && returned.kind !== 'mcp') setItem(returned);
      if (mounted.current) {
        onSaved(t('extensionEditor.saved'));
        onClose();
      }
    } catch (cause) {
      if (mounted.current) {
        setStale(isConflict(cause));
        setError(
          `${messageOf(cause)}${isConflict(cause) ? t('extensionEditor.conflictSuffix') : ''}`,
        );
      }
    } finally {
      if (mounted.current) setWorking(false);
    }
  }

  return (
    <FeatureDialog
      title={`${initialItem ? t('agents.edit') : t('extensionEditor.new')} ${kinds[kind]}`}
      description={t('extensionEditor.project', { name: projectName })}
      busy={busy || bindingsOpen}
      onClose={onClose}
    >
      <form className="ext-editor" onSubmit={(event) => void submit(event)}>
        <fieldset className="ext-editor-fields" disabled={busy}>
          <div className="ext-field-pair">
            <Field label={t('common.name')} help={t('extensionEditor.markdownNameHelp')}>
              <Input
                autoFocus
                required
                maxLength={EXTENSION_NAME_MAX}
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <label className="ext-enable-field">
              <Switch checked={enabled} disabled={busy} onCheckedChange={setEnabled} />
              {t('extensionEditor.enable')}
            </label>
          </div>
          {kind === 'skill' ? (
            <section className="ext-tool-section" aria-label={t('extensionEditor.bindingsLabel')}>
              <div className="ext-tool-heading">
                <h3>{t('extensionEditor.bindings')}</h3>
                <ActionButton
                  ref={bindingsButton}
                  disabled={!item}
                  onClick={() => setBindingsOpen(true)}
                >
                  {t('extensionEditor.configureBindings')}
                </ActionButton>
              </div>
              <p className="ext-help">
                {item ? t('extensionEditor.bindingsHelp') : t('extensionEditor.saveSkillFirst')}
              </p>
            </section>
          ) : null}
          <Field label={t('common.description')}>
            <Textarea
              rows={2}
              maxLength={EXTENSION_DESCRIPTION_MAX}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field label={t('common.source')}>
            <Input
              maxLength={EXTENSION_SOURCE_MAX}
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </Field>
          <div className="ext-markdown-toolbar">
            <span>{t('extensionEditor.markdown')}</span>
            <label className="ext-file-button">
              {t('extensionEditor.importFile')}
              <input
                ref={fileInput}
                type="file"
                accept=".md,.markdown,text/markdown,text/plain"
                aria-label={t('extensionEditor.importMarkdownLabel')}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  void importMarkdown(file);
                }}
              />
            </label>
          </div>
          <Textarea
            className="ext-code-input ext-body-input"
            rows={12}
            required
            maxLength={EXTENSION_BODY_MAX}
            spellCheck={false}
            aria-label={t('extensionEditor.bodyLabel')}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <MarkdownPreview body={body} />
          {kind === 'skill' ? (
            <>
              <label className="ext-auto-field">
                <Switch
                  checked={autoInvoke && allowsAuto(item)}
                  disabled={busy || !allowsAuto(item)}
                  aria-describedby={`${id}-auto-invoke-help`}
                  onCheckedChange={setAutoInvoke}
                />
                <span>
                  {t('extensions.autoLabel')}
                  <small id={`${id}-auto-invoke-help`}>
                    {allowsAuto(item)
                      ? t('extensionEditor.autoHelp')
                      : t('extensionEditor.autoForbidden')}
                  </small>
                </span>
              </label>
              <p className="ext-help">
                {t('extensionEditor.metadataHelp')}
                {item?.userInvocable === false
                  ? t('extensionEditor.noManual')
                  : t('extensionEditor.manualHelp')}
              </p>
            </>
          ) : null}
          {item?.compatibility ? (
            <p className="ext-compatibility">{extensionDetail(item.compatibility)}</p>
          ) : null}
        </fieldset>
        <ErrorMessage error={error} />
        <div className="ext-dialog-actions">
          <ActionButton disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </ActionButton>
          <span className="ext-save-state" role="status">
            {busy ? (readingFile ? t('extensionEditor.readingFile') : t('common.saving')) : ''}
          </span>
          <ActionButton type="submit" value="save" variant="default" disabled={busy || stale}>
            {t('common.save')}
          </ActionButton>
        </div>
      </form>
      {bindingsOpen && item?.kind === 'skill' ? (
        <SkillToolBindingsDialog
          projectId={projectId}
          projectName={projectName}
          skillId={item.id}
          skillName={item.name}
          onClose={() => {
            setBindingsOpen(false);
            requestAnimationFrame(() => bindingsButton.current?.focus());
          }}
          onSaved={() => {
            const latest = cache.getById(item.id);
            if (latest && latest.kind !== 'mcp') setItem(latest);
            onSaved(t('extensionEditor.bindingsSaved'));
          }}
        />
      ) : null}
    </FeatureDialog>
  );
}

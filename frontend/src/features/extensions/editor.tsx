/**
 * @file 提供技能、命令和 MCP 扩展编辑表单。
 * @implementation 管理扩展内容、调用选项及 MCP 连接和工具配置，并提供技能工具绑定入口。
 * @updated 2026-11-23T04:52:50+08:00
 */
import { getTranslator, useUiTranslation } from '@/i18n';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Switch } from '@/components/ui/switch';
import { useQueryClient } from '@tanstack/react-query';
import type { AllowedMcpTool, DiscoveredTool, Extension, McpTransport } from '@shared/types';
import { ActionButton, ErrorMessage, FeatureDialog, Field, MarkdownPreview } from './components';
import { SkillToolBindingsDialog } from './tool-bindings';
import {
  allowsAuto,
  autoEnabled,
  extensionKeys,
  extensionDetail,
  extensionsQuery,
  isConflict,
  kinds,
  messageOf,
  returnedItem,
  testLabels,
  useExtensionMutation,
  type ExtensionKind,
  type TestResult,
} from './api';

function stringArray(value: string) {
  const t = getTranslator('extensions');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '[]');
  } catch {
    throw new Error(t('extensionEditor.invalidArgs'));
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string'))
    throw new Error(t('extensionEditor.invalidArgs'));
  return parsed as string[];
}
export function ExtensionEditor({
  projectId,
  projectName,
  initialItem,
  kind,
  importFile = false,
  testOnOpen = false,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  initialItem?: Extension;
  kind: ExtensionKind;
  importFile?: boolean;
  testOnOpen?: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t } = useUiTranslation('extensions');
  const id = useId();
  const client = useQueryClient();
  const save = useExtensionMutation(projectId);
  const test = useExtensionMutation<TestResult>(projectId);
  const [item, setItem] = useState(initialItem);
  const [name, setName] = useState(initialItem?.name ?? '');
  const [description, setDescription] = useState(initialItem?.description ?? '');
  const [enabled, setEnabled] = useState(initialItem?.enabled ?? true);
  const markdown = initialItem?.kind !== 'mcp' ? initialItem : undefined;
  const mcp = initialItem?.kind === 'mcp' ? initialItem : undefined;
  const [source, setSource] = useState(markdown?.source ?? 'manual');
  const [body, setBody] = useState(markdown?.body ?? '');
  const [autoUseInChat, setAutoUseInChat] = useState(mcp?.autoUseInChat === true);
  const [autoInvoke, setAutoInvoke] = useState(autoEnabled(markdown));
  const [transportType, setTransportType] = useState<McpTransport['type']>(
    mcp?.transport.type ?? 'http',
  );
  const [url, setUrl] = useState(mcp?.transport.type === 'http' ? mcp.transport.url : '');
  const [tokenEnv, setTokenEnv] = useState(
    mcp?.transport.type === 'http' ? (mcp.transport.tokenEnv ?? '') : '',
  );
  const [command, setCommand] = useState(
    mcp?.transport.type === 'stdio' ? mcp.transport.command : '',
  );
  const [args, setArgs] = useState(
    mcp?.transport.type === 'stdio' ? JSON.stringify(mcp.transport.args, null, 2) : '[]',
  );
  const [keepAlive, setKeepAlive] = useState(
    mcp?.transport.type === 'stdio' && mcp.transport.keepAlive === true,
  );
  const [envNames, setEnvNames] = useState(
    mcp?.transport.type === 'stdio' ? mcp.transport.envNames.join('\n') : '',
  );
  const [tools, setTools] = useState<DiscoveredTool[]>(mcp?.tools ?? []);
  const [allowedTools, setAllowedTools] = useState<AllowedMcpTool[]>(mcp?.allowedTools ?? []);
  const [connection, setConnection] = useState<TestResult | undefined>(
    mcp?.status ? { status: mcp.status, message: mcp.statusMessage, tools: mcp.tools } : undefined,
  );
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [working, setWorking] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [bindingsOpen, setBindingsOpen] = useState(false);
  const bindingsButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileSequence = useRef(0);
  const startedTest = useRef(false);
  const mounted = useRef(true);
  const busy = working || save.isPending || test.isPending || readingFile;
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

  async function performTest(target: Extension) {
    if (target.kind !== 'mcp') return;
    try {
      const result = await test.mutateAsync({
        suffix: `${encodeURIComponent(target.id)}/test`,
        method: 'POST',
        body: {},
      });
      if (
        !['connected', 'needs-auth', 'failed'].includes(result?.status) ||
        !Array.isArray(result.tools)
      )
        throw new Error(t('extensionEditor.invalidTest'));
      const latest =
        client
          .getQueryData<Extension[]>(extensionKeys.list(projectId))
          ?.find((value) => value.id === target.id) ??
        result.item ??
        target;
      // Older servers may return the test result without an item. Keep its status
      // alongside the current version so the picker never infers success from tools alone.
      if (
        latest.kind === 'mcp' &&
        JSON.stringify(latest.transport) === JSON.stringify(target.transport)
      ) {
        const updated = {
          ...latest,
          status: result.status,
          tools: result.tools,
          statusMessage: result.message ?? result.statusMessage ?? '',
        };
        client.setQueryData<Extension[]>(extensionKeys.list(projectId), (items) =>
          items?.map((value) => (value.id === target.id ? updated : value)),
        );
        if (mounted.current) setItem(updated);
      }
      if (mounted.current) {
        setConnection(result);
        setTools(result.tools);
      }
    } catch (cause) {
      client.setQueryData<Extension[]>(extensionKeys.list(projectId), (items) =>
        items?.map((value) =>
          value.id === target.id &&
          value.kind === 'mcp' &&
          JSON.stringify(value.transport) === JSON.stringify(target.transport)
            ? { ...value, status: 'failed', statusMessage: messageOf(cause), tools: [] }
            : value,
        ),
      );
      if (mounted.current) {
        setConnection({ status: 'failed', tools: [], message: messageOf(cause) });
        setError(messageOf(cause));
      }
    }
  }
  useEffect(() => {
    if (!testOnOpen || !initialItem || startedTest.current) return;
    startedTest.current = true;
    setWorking(true);
    void performTest(initialItem).finally(() => {
      if (mounted.current) setWorking(false);
    });
    // The initial test is intentionally bound to this editor's saved item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testOnOpen, initialItem]);

  function payload() {
    const trimmed = name.trim();
    if (!(kind === 'mcp' ? /^[\p{L}\p{N}_.:-]+$/u : /^[\p{L}\p{N}_:-]+$/u).test(trimmed))
      throw new Error(t('extensionEditor.invalidName'));
    const fields = { kind, name: trimmed, description: description.trim(), enabled };
    if (kind !== 'mcp')
      return {
        ...fields,
        source: source.trim(),
        body,
        ...(kind === 'skill' ? { autoInvoke: allowsAuto(markdown) && autoInvoke } : {}),
      };
    let transport: McpTransport;
    if (transportType === 'http') {
      let parsed: URL;
      try {
        parsed = new URL(url.trim());
      } catch {
        throw new Error(t('extensionEditor.invalidUrl'));
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error(t('extensionEditor.unsafeUrl'));
      const variable = tokenEnv.trim();
      if (variable && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
        throw new Error(t('extensionEditor.invalidToken'));
      transport = { type: 'http', url: url.trim(), ...(variable ? { tokenEnv: variable } : {}) };
    } else {
      const variables = [...new Set(envNames.split(/\s+/).filter(Boolean))];
      if (variables.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))
        throw new Error(t('extensionEditor.invalidEnv'));
      if (!command.trim()) throw new Error(t('extensionEditor.commandRequired'));
      transport = {
        type: 'stdio',
        command: command.trim(),
        args: stringArray(args),
        envNames: variables,
        ...(keepAlive ? { keepAlive: true } : {}),
      };
    }
    return { ...fields, transport, allowedTools, autoUseInChat };
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || stale) return;
    let fields: ReturnType<typeof payload>;
    try {
      fields = payload();
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const andTest = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'test';
    setError('');
    setWorking(true);
    try {
      const result = await save.mutateAsync({
        suffix: item ? encodeURIComponent(item.id) : undefined,
        method: item ? 'PATCH' : 'POST',
        body: { ...fields, ...(item ? { version: item.version } : {}) },
      });
      const returned = returnedItem(result);
      if (mounted.current && returned) setItem(returned);
      if (!andTest) {
        if (mounted.current) {
          onSaved(t('extensionEditor.saved'));
          onClose();
        }
        return;
      }
      let saved = returned;
      if (!saved) {
        try {
          const listed = await client.fetchQuery({ ...extensionsQuery(projectId), staleTime: 0 });
          const matches = listed.filter((value) =>
            item ? value.id === item.id : value.kind === kind && value.name === fields.name,
          );
          saved = matches.length === 1 ? matches[0] : undefined;
        } catch {
          /* A successful create must never be retried with an unknown identity. */
        }
      }
      if (!saved) {
        if (mounted.current) {
          setStale(true);
          setError(t('extensionEditor.unknownSavedId'));
        }
        return;
      }
      if (mounted.current) {
        setItem(saved);
        await performTest(saved);
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
      setName((old) =>
        old.trim()
          ? old
          : file.name.replace(/\.(md|markdown)$/i, '').replace(/[^\p{L}\p{N}_:-]+/gu, '-'),
      );
      setSource(file.name);
      setBody(text);
      setError('');
    } catch (cause) {
      if (mounted.current && sequence === fileSequence.current)
        setError(cause instanceof TypeError ? t('extensionEditor.invalidUtf8') : messageOf(cause));
    } finally {
      if (mounted.current && sequence === fileSequence.current) setReadingFile(false);
    }
  }
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  for (const permission of allowedTools)
    if (!toolMap.has(permission.name))
      toolMap.set(permission.name, {
        name: permission.name,
        description: t('extensionEditor.savedTool'),
      });
  const permissions = new Map(
    allowedTools.map((permission) => [permission.name, permission.access]),
  );
  function toggleTool(toolName: string, checked: boolean) {
    setAllowedTools((old) =>
      checked
        ? [
            ...old.filter((value) => value.name !== toolName),
            { name: toolName, access: 'approval' },
          ]
        : old.filter((value) => value.name !== toolName),
    );
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
            <Field
              label={t('common.name')}
              help={
                kind === 'mcp'
                  ? t('extensionEditor.mcpNameHelp')
                  : t('extensionEditor.markdownNameHelp')
              }
            >
              <input
                autoFocus
                required
                maxLength={100}
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
            <textarea
              rows={2}
              maxLength={2000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          {kind === 'mcp' ? (
            <>
              <label className="ext-auto-field">
                <Switch
                  checked={autoUseInChat}
                  disabled={busy}
                  aria-describedby={`${id}-auto-chat-help`}
                  onCheckedChange={setAutoUseInChat}
                />
                <span>
                  {t('extensionEditor.autoChat')}
                  <small id={`${id}-auto-chat-help`}>{t('extensionEditor.autoChatHelp')}</small>
                </span>
              </label>
              <Field label={t('extensionEditor.transport')}>
                <select
                  value={transportType}
                  onChange={(event) => setTransportType(event.target.value as McpTransport['type'])}
                >
                  <option value="http">{t('common.http')}</option>
                  <option value="stdio">{t('extensionEditor.stdio')}</option>
                </select>
              </Field>
              {transportType === 'http' ? (
                <>
                  <Field label={t('extensionEditor.serviceUrl')}>
                    <input
                      type="url"
                      required
                      placeholder="https://…"
                      autoComplete="off"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                  </Field>
                  <Field
                    label={t('extensionEditor.tokenEnv')}
                    help={t('extensionEditor.tokenEnvHelp')}
                  >
                    <input
                      pattern="[A-Za-z_][A-Za-z0-9_]*"
                      autoComplete="off"
                      value={tokenEnv}
                      onChange={(event) => setTokenEnv(event.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label={t('extensionEditor.command')}>
                    <input
                      required
                      spellCheck={false}
                      autoComplete="off"
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                    />
                  </Field>
                  <Field label={t('extensionEditor.args')}>
                    <textarea
                      className="ext-code-input"
                      rows={3}
                      spellCheck={false}
                      value={args}
                      onChange={(event) => setArgs(event.target.value)}
                    />
                  </Field>
                  <label className="ext-auto-field">
                    <Switch
                      checked={keepAlive}
                      disabled={busy}
                      aria-describedby={`${id}-keep-alive-help`}
                      onCheckedChange={setKeepAlive}
                    />
                    <span>
                      {t('extensionEditor.keepAlive')}{' '}
                      <small id={`${id}-keep-alive-help`}>
                        {t('extensionEditor.keepAliveHelp')}
                      </small>
                    </span>
                  </label>
                  <Field label={t('extensionEditor.envNames')} help={t('extensionEditor.envHelp')}>
                    <textarea
                      className="ext-code-input"
                      rows={3}
                      spellCheck={false}
                      value={envNames}
                      onChange={(event) => setEnvNames(event.target.value)}
                    />
                  </Field>
                </>
              )}
              <div role="status" aria-live="polite">
                {connection ? (
                  <div className="ext-test-result" data-ext-status={connection.status}>
                    <strong>{testLabels[connection.status]}</strong>
                    <p>
                      {extensionDetail(connection.message || connection.statusMessage) ||
                        t('extensionEditor.discoveredCount', { count: connection.tools.length })}
                    </p>
                  </div>
                ) : (
                  <p className="ext-help">{t('extensionEditor.notTested')}</p>
                )}
              </div>
              <section className="ext-tool-section">
                <div className="ext-tool-heading">
                  <h3>{t('extensionEditor.allowedTools')}</h3>
                  <span className="ext-tool-count">
                    {t('extensionEditor.selectedCount', { count: allowedTools.length })}
                  </span>
                </div>
                <p className="ext-help">{t('extensionEditor.allowedToolsHelp')}</p>
                <div className="ext-tool-list">
                  {toolMap.size ? (
                    [...toolMap.values()].map((tool) => (
                      <div className="ext-tool" key={tool.name}>
                        <label>
                          <input
                            type="checkbox"
                            checked={permissions.has(tool.name)}
                            onChange={(event) => toggleTool(tool.name, event.target.checked)}
                          />
                          <span>
                            <strong>{tool.name}</strong>
                            <small>{tool.description || t('common.noDescription')}</small>
                          </span>
                        </label>
                        <select
                          aria-label={t('extensionEditor.accessLabel', { name: tool.name })}
                          disabled={!permissions.has(tool.name)}
                          value={permissions.get(tool.name) ?? 'approval'}
                          onChange={(event) =>
                            setAllowedTools((old) =>
                              old.map((value) =>
                                value.name === tool.name
                                  ? {
                                      ...value,
                                      access: event.target.value as AllowedMcpTool['access'],
                                    }
                                  : value,
                              ),
                            )
                          }
                        >
                          <option value="approval">{t('common.approval')}</option>
                          <option value="read">{t('common.readOnly')}</option>
                        </select>
                      </div>
                    ))
                  ) : (
                    <p className="ext-tool-empty">{t('extensionEditor.noTools')}</p>
                  )}
                </div>
              </section>
            </>
          ) : (
            <>
              <Field label={t('common.source')}>
                <input
                  maxLength={500}
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
              <textarea
                className="ext-code-input ext-body-input"
                rows={12}
                required
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
                      checked={autoInvoke && allowsAuto(markdown)}
                      disabled={busy || !allowsAuto(markdown)}
                      aria-describedby={`${id}-auto-invoke-help`}
                      onCheckedChange={setAutoInvoke}
                    />
                    <span>
                      {t('extensions.autoLabel')}
                      <small id={`${id}-auto-invoke-help`}>
                        {allowsAuto(markdown)
                          ? t('extensionEditor.autoHelp')
                          : t('extensionEditor.autoForbidden')}
                      </small>
                    </span>
                  </label>
                  <p className="ext-help">
                    {t('extensionEditor.metadataHelp')}
                    {markdown?.userInvocable === false
                      ? t('extensionEditor.noManual')
                      : t('extensionEditor.manualHelp')}
                  </p>
                </>
              ) : null}
            </>
          )}
          {markdown?.compatibility ? (
            <p className="ext-compatibility">{extensionDetail(markdown.compatibility)}</p>
          ) : null}
        </fieldset>
        <ErrorMessage error={error} />
        <div className="ext-dialog-actions">
          <ActionButton disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </ActionButton>
          <span className="ext-save-state" role="status">
            {busy
              ? test.isPending
                ? t('extensionEditor.testing')
                : readingFile
                  ? t('extensionEditor.readingFile')
                  : t('common.saving')
              : ''}
          </span>
          {kind === 'mcp' ? (
            <ActionButton type="submit" value="test" disabled={busy || stale}>
              {t('extensionEditor.saveTest')}
            </ActionButton>
          ) : null}
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
            const latest = client
              .getQueryData<Extension[]>(extensionKeys.list(projectId))
              ?.find((value) => value.id === item.id);
            if (latest) setItem(latest);
            onSaved(t('extensionEditor.bindingsSaved'));
          }}
        />
      ) : null}
    </FeatureDialog>
  );
}

/**
 * @file 提供 MCP 扩展的独立编辑与连接测试表单。
 * @implementation 复用共享校验契约和 use-query 测试/缓存操作，管理 HTTP 与 stdio 传输参数、跨项目共享开关及工具授权列表。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { OptionsSelect } from '@/components/options-select';
import { Switch } from '@/components/ui/switch';
import { useUiTranslation } from '@/i18n';
import {
  EXTENSION_COMMAND_MAX,
  EXTENSION_DESCRIPTION_MAX,
  EXTENSION_ENV_NAME_MAX,
  EXTENSION_NAME_MAX,
  EXTENSION_URL_MAX,
  type AllowedMcpTool,
  type DiscoveredTool,
  type McpTransport,
} from '@shared/extensions';
import {
  isConflict,
  kinds,
  messageOf,
  returnedItem,
  testLabels,
  useExtensionCache,
  useExtensionMutation,
  useTestMcpExtension,
  type McpExtension,
  type TestResult,
} from './api';
import { extensionDetail } from './api';
import { ActionButton, ErrorMessage, FeatureDialog, Field } from './components';
import { mcpChatOptions } from './mcp-sharing';
import { parseExtensionPayload, parseJsonStringArray } from './validation';

export function McpExtensionForm({
  projectId,
  projectName,
  initialItem,
  testOnOpen = false,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  initialItem?: McpExtension;
  testOnOpen?: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t } = useUiTranslation('extensions');
  const id = useId();
  const save = useExtensionMutation(projectId);
  const test = useTestMcpExtension(projectId, messageOf);
  const cache = useExtensionCache(projectId);
  const [item, setItem] = useState(initialItem);
  const [name, setName] = useState(initialItem?.name ?? '');
  const [description, setDescription] = useState(initialItem?.description ?? '');
  const [enabled, setEnabled] = useState(initialItem?.enabled ?? true);
  const initialChatOptions = mcpChatOptions(
    initialItem?.transport.type ?? 'http',
    initialItem !== undefined &&
      'shareAcrossProjects' in initialItem &&
      initialItem.shareAcrossProjects === true,
    initialItem?.autoUseInChat === true,
  );
  const [shareAcrossProjects, setShareAcrossProjects] = useState(
    initialChatOptions.shareAcrossProjects,
  );
  const [autoUseInChat, setAutoUseInChat] = useState(initialChatOptions.autoUseInChat);
  const [transportType, setTransportType] = useState<McpTransport['type']>(
    initialItem?.transport.type ?? 'http',
  );
  const [url, setUrl] = useState(
    initialItem?.transport.type === 'http' ? initialItem.transport.url : '',
  );
  const [tokenEnv, setTokenEnv] = useState(
    initialItem?.transport.type === 'http' ? (initialItem.transport.tokenEnv ?? '') : '',
  );
  const [command, setCommand] = useState(
    initialItem?.transport.type === 'stdio' ? initialItem.transport.command : '',
  );
  const [args, setArgs] = useState(
    initialItem?.transport.type === 'stdio'
      ? JSON.stringify(initialItem.transport.args, null, 2)
      : '[]',
  );
  const [keepAlive, setKeepAlive] = useState(
    initialItem?.transport.type === 'stdio' && initialItem.transport.keepAlive === true,
  );
  const [envNames, setEnvNames] = useState(
    initialItem?.transport.type === 'stdio' ? initialItem.transport.envNames.join('\n') : '',
  );
  const [tools, setTools] = useState<DiscoveredTool[]>(initialItem?.tools ?? []);
  const [allowedTools, setAllowedTools] = useState<AllowedMcpTool[]>(
    initialItem?.allowedTools ?? [],
  );
  const [connection, setConnection] = useState<TestResult | undefined>(
    initialItem?.status
      ? {
          status: initialItem.status,
          message: initialItem.statusMessage,
          tools: initialItem.tools,
        }
      : undefined,
  );
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [working, setWorking] = useState(false);
  const startedTest = useRef(false);
  const mounted = useRef(true);
  const busy = working || save.isPending || test.isPending;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function performTest(target: McpExtension) {
    try {
      const { result, updatedItem } = await test.testExtension(target);
      if (!mounted.current) return;
      if (updatedItem) setItem(updatedItem);
      setConnection(result);
      setTools(result.tools);
    } catch (cause) {
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

  function buildPayload() {
    const transport: McpTransport =
      transportType === 'http'
        ? {
            type: 'http',
            url: url.trim(),
            ...(tokenEnv.trim() ? { tokenEnv: tokenEnv.trim() } : {}),
          }
        : {
            type: 'stdio',
            command: command.trim(),
            args: parseJsonStringArray(args),
            envNames: [...new Set(envNames.split(/\s+/).filter(Boolean))],
            ...(keepAlive ? { keepAlive: true } : {}),
          };
    return parseExtensionPayload({
      kind: 'mcp',
      name: name.trim(),
      description: description.trim(),
      enabled,
      transport,
      allowedTools,
      ...mcpChatOptions(transport.type, shareAcrossProjects, autoUseInChat),
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || stale) return;
    let fields: ReturnType<typeof buildPayload>;
    try {
      fields = buildPayload();
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
      const returnedMcp = returned?.kind === 'mcp' ? returned : undefined;
      if (mounted.current && returnedMcp) setItem(returnedMcp);
      if (!andTest) {
        if (mounted.current) {
          onSaved(t('extensionEditor.saved'));
          onClose();
        }
        return;
      }
      let saved = returnedMcp;
      if (!saved) {
        try {
          const listed = await cache.fetchLatestList();
          const matches = listed.filter(
            (value): value is McpExtension =>
              value.kind === 'mcp' && (item ? value.id === item.id : value.name === fields.name),
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
      title={`${initialItem ? t('agents.edit') : t('extensionEditor.new')} ${kinds.mcp}`}
      description={t('extensionEditor.project', { name: projectName })}
      busy={busy}
      onClose={onClose}
    >
      <form className="ext-editor" onSubmit={(event) => void submit(event)}>
        <fieldset className="ext-editor-fields" disabled={busy}>
          <div className="ext-field-pair">
            <Field label={t('common.name')} help={t('extensionEditor.mcpNameHelp')}>
              <input
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
          <Field label={t('common.description')}>
            <textarea
              rows={2}
              maxLength={EXTENSION_DESCRIPTION_MAX}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <label className="ext-auto-field">
            <Switch
              checked={!shareAcrossProjects && autoUseInChat}
              disabled={busy || shareAcrossProjects}
              aria-describedby={shareAcrossProjects ? `${id}-share-help` : `${id}-auto-chat-help`}
              onCheckedChange={setAutoUseInChat}
            />
            <span>
              {t('extensionEditor.autoChat')}
              <small id={`${id}-auto-chat-help`}>{t('extensionEditor.autoChatHelp')}</small>
            </span>
          </label>
          <Field label={t('extensionEditor.transport')}>
            <OptionsSelect
              aria-label={t('extensionEditor.transport')}
              className="w-full"
              value={transportType}
              options={[
                { value: 'http', label: t('common.http') },
                { value: 'stdio', label: t('extensionEditor.stdio') },
              ]}
              onValueChange={(type) => {
                setTransportType(type);
                if (type !== 'stdio') setShareAcrossProjects(false);
              }}
            />
          </Field>
          {transportType === 'stdio' ? (
            <label className="ext-auto-field">
              <Switch
                checked={shareAcrossProjects}
                disabled={busy}
                aria-describedby={`${id}-share-help`}
                onCheckedChange={(checked) => {
                  setShareAcrossProjects(checked);
                  if (checked) setAutoUseInChat(false);
                }}
              />
              <span>
                {t('extensionEditor.shareAcrossProjects')}
                <small id={`${id}-share-help`}>
                  {t('extensionEditor.shareAcrossProjectsHelp')}
                </small>
              </span>
            </label>
          ) : null}
          {transportType === 'http' ? (
            <>
              <Field label={t('extensionEditor.serviceUrl')}>
                <input
                  type="url"
                  required
                  maxLength={EXTENSION_URL_MAX}
                  placeholder="https://…"
                  autoComplete="off"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </Field>
              <Field label={t('extensionEditor.tokenEnv')} help={t('extensionEditor.tokenEnvHelp')}>
                <input
                  maxLength={EXTENSION_ENV_NAME_MAX}
                  pattern="[A-Z_][A-Z0-9_]*"
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
                  maxLength={EXTENSION_COMMAND_MAX}
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
                  <small id={`${id}-keep-alive-help`}>{t('extensionEditor.keepAliveHelp')}</small>
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
                    <OptionsSelect
                      className="ext-tool-access"
                      size="sm"
                      aria-label={t('extensionEditor.accessLabel', { name: tool.name })}
                      disabled={!permissions.has(tool.name)}
                      value={permissions.get(tool.name) ?? 'approval'}
                      options={[
                        { value: 'approval', label: t('common.approval') },
                        { value: 'read', label: t('common.readOnly') },
                      ]}
                      onValueChange={(access) =>
                        setAllowedTools((old) =>
                          old.map((value) =>
                            value.name === tool.name ? { ...value, access } : value,
                          ),
                        )
                      }
                    />
                  </div>
                ))
              ) : (
                <p className="ext-tool-empty">{t('extensionEditor.noTools')}</p>
              )}
            </div>
          </section>
        </fieldset>
        <ErrorMessage error={error} />
        <div className="ext-dialog-actions">
          <ActionButton disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </ActionButton>
          <span className="ext-save-state" role="status">
            {busy ? (test.isPending ? t('extensionEditor.testing') : t('common.saving')) : ''}
          </span>
          <ActionButton type="submit" value="test" disabled={busy || stale}>
            {t('extensionEditor.saveTest')}
          </ActionButton>
          <ActionButton type="submit" value="save" variant="default" disabled={busy || stale}>
            {t('common.save')}
          </ActionButton>
        </div>
      </form>
    </FeatureDialog>
  );
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AllowedMcpTool, DiscoveredTool, Extension, McpTransport } from '@shared/types';
import { ActionButton, ErrorMessage, FeatureDialog, Field, MarkdownPreview } from './components';
import { SkillToolBindingsDialog } from './tool-bindings';
import {
  allowsAuto,
  autoEnabled,
  extensionKeys,
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '[]');
  } catch {
    throw new Error('参数必须是 JSON 字符串数组。');
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string'))
    throw new Error('参数必须是 JSON 字符串数组。');
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
        throw new Error('连接测试响应格式不正确。');
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
      throw new Error('名称请使用字母、数字、短横线、下划线或冒号；MCP 名称也可以包含句点。');
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
        throw new Error('请输入完整的 HTTP 或 HTTPS 服务 URL。');
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error('服务 URL 需使用 HTTP 或 HTTPS，且不能包含用户名或密码。');
      const variable = tokenEnv.trim();
      if (variable && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
        throw new Error('请填写有效的令牌环境变量名。');
      transport = { type: 'http', url: url.trim(), ...(variable ? { tokenEnv: variable } : {}) };
    } else {
      const variables = [...new Set(envNames.split(/\s+/).filter(Boolean))];
      if (variables.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))
        throw new Error('环境变量名只能包含字母、数字和下划线，且不能以数字开头。');
      if (!command.trim()) throw new Error('请填写可执行命令。');
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
          onSaved('扩展已保存');
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
          setError('扩展已保存，但无法确认可用于测试的扩展 ID。请关闭编辑器并重新加载列表。');
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
          `${messageOf(cause)}${isConflict(cause) ? ' 当前编辑内容已保留，请关闭后重新打开最新版本再保存。' : ''}`,
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
        throw new Error('请选择 Markdown 文件（.md 或 .markdown）。');
      if (file.size > 1048576) throw new Error('Markdown 文件不能超过 1 MiB。');
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
        setError(cause instanceof TypeError ? '文件不是有效的 UTF-8 文本。' : messageOf(cause));
    } finally {
      if (mounted.current && sequence === fileSequence.current) setReadingFile(false);
    }
  }
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  for (const permission of allowedTools)
    if (!toolMap.has(permission.name))
      toolMap.set(permission.name, {
        name: permission.name,
        description: '已保存的工具；本次尚未发现。',
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
      title={`${initialItem ? '编辑' : '新建'} ${kinds[kind]}`}
      description={`项目 · ${projectName}`}
      busy={busy || bindingsOpen}
      onClose={onClose}
    >
      <form className="ext-editor" onSubmit={(event) => void submit(event)}>
        <fieldset className="ext-editor-fields" disabled={busy}>
          <div className="ext-field-pair">
            <Field
              label="名称"
              help={
                kind === 'mcp'
                  ? '在 # 菜单中显示的服务名称'
                  : '在 / 菜单中显示；使用字母、数字、短横线、下划线或冒号'
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
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              启用此扩展
            </label>
          </div>
          {kind === 'skill' ? (
            <section className="ext-tool-section" aria-label="Skill 工具绑定">
              <div className="ext-tool-heading">
                <h3>工具绑定</h3>
                <ActionButton
                  ref={bindingsButton}
                  disabled={!item}
                  onClick={() => setBindingsOpen(true)}
                >
                  配置工具绑定
                </ActionButton>
              </div>
              <p className="ext-help">
                {item
                  ? '配置 Skill 使用的内置工具、项目 MCP 工具、HTTPS 请求或命令预设，单独保存。'
                  : '先保存 Skill，再打开详情配置工具绑定。'}
              </p>
            </section>
          ) : null}
          <Field label="描述">
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
                <input
                  type="checkbox"
                  checked={autoUseInChat}
                  onChange={(event) => setAutoUseInChat(event.target.checked)}
                />
                <span>
                  在项目普通会话中自动提供工具<small>会话模式和已授权工具决定本轮可用范围。</small>
                </span>
              </label>
              <Field label="连接方式">
                <select
                  value={transportType}
                  onChange={(event) => setTransportType(event.target.value as McpTransport['type'])}
                >
                  <option value="http">HTTP</option>
                  <option value="stdio">本地进程 · stdio</option>
                </select>
              </Field>
              {transportType === 'http' ? (
                <>
                  <Field label="服务 URL">
                    <input
                      type="url"
                      required
                      placeholder="https://…"
                      autoComplete="off"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                  </Field>
                  <Field label="令牌环境变量名（可选）" help="填写本地服务端读取的变量名称。">
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
                  <Field label="可执行命令">
                    <input
                      required
                      spellCheck={false}
                      autoComplete="off"
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                    />
                  </Field>
                  <Field label="参数 · JSON 字符串数组">
                    <textarea
                      className="ext-code-input"
                      rows={3}
                      spellCheck={false}
                      value={args}
                      onChange={(event) => setArgs(event.target.value)}
                    />
                  </Field>
                  <label className="ext-auto-field">
                    <input
                      type="checkbox"
                      checked={keepAlive}
                      onChange={(event) => setKeepAlive(event.target.checked)}
                    />
                    <span>
                      跨会话保留进程{' '}
                      <small>同一项目的聊天共享此 MCP 状态，直到服务停止或配置变更。</small>
                    </span>
                  </label>
                  <Field label="环境变量名 · 每行一个" help="仅填写变量名，值由本地服务端提供。">
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
                      {connection.message ||
                        connection.statusMessage ||
                        `发现 ${connection.tools.length} 个工具`}
                    </p>
                  </div>
                ) : (
                  <p className="ext-help">连接尚未测试。测试会由本地服务端发起。</p>
                )}
              </div>
              <section className="ext-tool-section">
                <div className="ext-tool-heading">
                  <h3>允许的工具</h3>
                  <span className="ext-tool-count">已选择 {allowedTools.length} 个</span>
                </div>
                <p className="ext-help">
                  勾选项目可以使用的工具，并设置访问方式。新发现的工具默认不勾选。
                </p>
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
                            <small>{tool.description || '暂无描述'}</small>
                          </span>
                        </label>
                        <select
                          aria-label={`${tool.name} 访问方式`}
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
                          <option value="approval">每次审批</option>
                          <option value="read">只读</option>
                        </select>
                      </div>
                    ))
                  ) : (
                    <p className="ext-tool-empty">保存并测试连接后，在这里选择工具。</p>
                  )}
                </div>
              </section>
            </>
          ) : (
            <>
              <Field label="来源">
                <input
                  maxLength={500}
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                />
              </Field>
              <div className="ext-markdown-toolbar">
                <span>Markdown 指令</span>
                <label className="ext-file-button">
                  导入文件
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".md,.markdown,text/markdown,text/plain"
                    aria-label="导入 Markdown 文件"
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
                aria-label="Markdown 指令正文"
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <MarkdownPreview body={body} />
              {kind === 'skill' ? (
                <>
                  <label className="ext-auto-field">
                    <input
                      type="checkbox"
                      checked={autoInvoke && allowsAuto(markdown)}
                      disabled={!allowsAuto(markdown)}
                      onChange={(event) => setAutoInvoke(event.target.checked)}
                    />
                    <span>
                      允许自动调用
                      <small>
                        {allowsAuto(markdown)
                          ? '启用后，模型可在当前项目中按需加载。保存后从下一轮对话生效。'
                          : '上游声明禁止模型调用，当前自动调用已关闭。'}
                      </small>
                    </span>
                  </label>
                  <p className="ext-help">
                    手动调用与兼容性由服务端解析 Markdown 元数据。
                    {markdown?.userInvocable === false
                      ? '当前不支持 / 手动调用。'
                      : '关闭自动调用后，仍可使用 / 手动选择兼容的 Skill。'}
                  </p>
                </>
              ) : null}
            </>
          )}
          {markdown?.compatibility ? (
            <p className="ext-compatibility">{markdown.compatibility}</p>
          ) : null}
        </fieldset>
        <ErrorMessage error={error} />
        <div className="ext-dialog-actions">
          <ActionButton disabled={busy} onClick={onClose}>
            取消
          </ActionButton>
          <span className="ext-save-state" role="status">
            {busy
              ? test.isPending
                ? '正在测试连接…'
                : readingFile
                  ? '正在读取文件…'
                  : '正在保存…'
              : ''}
          </span>
          {kind === 'mcp' ? (
            <ActionButton type="submit" value="test" disabled={busy || stale}>
              保存并测试
            </ActionButton>
          ) : null}
          <ActionButton type="submit" value="save" primary disabled={busy || stale}>
            保存
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
            onSaved('工具绑定已保存');
          }}
        />
      ) : null}
    </FeatureDialog>
  );
}

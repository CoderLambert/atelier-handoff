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
  const query = useSkillToolBindings(projectId, skillId);
  const extensions = useExtensions(projectId);
  const save = useSaveSkillToolBindings(projectId, skillId);
  const [draft, setDraft] = useState<SkillToolBinding[]>();
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
        setNotice('工具绑定已保存。');
        onSaved();
      }
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    }
  }

  return (
    <FeatureDialog
      title={`${skillName} · 工具绑定`}
      description={`项目 · ${projectName}`}
      busy={busy}
      onClose={onClose}
    >
      <form className="ext-editor" onSubmit={(event) => void submit(event)}>
        <p className="ext-help">
          为 Skill 配置调用工具时使用的名称与来源，最多 {maxBindings} 个。这里单独保存工具绑定。
        </p>
        {query.isPending ? <p role="status">正在读取工具绑定…</p> : null}
        {query.error ? (
          <div className="ext-error" role="alert">
            {messageOf(query.error)}
            <ActionButton disabled={query.isFetching || busy} onClick={() => void query.refetch()}>
              重新加载绑定
            </ActionButton>
          </div>
        ) : null}
        {query.data ? (
          <>
            <fieldset className="ext-editor-fields" disabled={busy}>
              {!bindings.length ? (
                <p className="ext-tool-empty">尚未绑定工具。添加绑定，为 Skill 配置需要的工具。</p>
              ) : null}
              {bindings.map((binding, index) => {
                const label = binding.name || `第 ${index + 1} 个绑定`;
                const server =
                  binding.kind === 'mcp'
                    ? servers.find((item) => item.id === binding.extensionId)
                    : undefined;
                const tools = server ? allowedTools(server, 'edit') : [];
                const mcpIssue =
                  binding.kind === 'mcp' && extensions.data ? mcpBindingIssue(binding, items) : '';
                return (
                  <fieldset className="ext-binding" key={index}>
                    <legend>绑定 {index + 1}</legend>
                    <div className="ext-binding-fields">
                      <div className="ext-binding-pair">
                        <Field
                          label="工具名称"
                          help="小写字母开头，可含数字和下划线，最多 32 个字符。"
                        >
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
                        <Field label="工具来源">
                          <select
                            value={binding.kind}
                            onChange={(event) =>
                              update(
                                index,
                                newBinding(
                                  event.target.value as SkillToolBinding['kind'],
                                  binding.name,
                                ),
                              )
                            }
                          >
                            {Object.entries(bindingKinds).map(([value, text]) => (
                              <option key={value} value={value}>
                                {text}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      {binding.kind === 'builtin' ? (
                        <Field label="内置工具">
                          <select
                            value={binding.tool}
                            onChange={(event) =>
                              update(index, {
                                ...binding,
                                tool: event.target.value as typeof binding.tool,
                              })
                            }
                          >
                            {Object.entries(builtinTools).map(([value, text]) => (
                              <option key={value} value={value}>
                                {text} · {value}
                              </option>
                            ))}
                          </select>
                        </Field>
                      ) : binding.kind === 'mcp' ? (
                        <>
                          <div className="ext-binding-pair">
                            <Field label="项目 MCP 服务">
                              <select
                                required
                                value={binding.extensionId}
                                aria-describedby={`${id}-mcp-${index}`}
                                onChange={(event) => {
                                  const selected = servers.find(
                                    (item) => item.id === event.target.value,
                                  );
                                  update(index, {
                                    ...binding,
                                    extensionId: event.target.value,
                                    tool: selected
                                      ? (allowedTools(selected, 'edit')[0]?.name ?? '')
                                      : '',
                                  });
                                }}
                              >
                                <option value="">请选择 MCP 服务</option>
                                {binding.extensionId && !server ? (
                                  <option value={binding.extensionId} disabled>
                                    已移除 · {binding.extensionId}
                                  </option>
                                ) : null}
                                {servers.map((item) => {
                                  const available = allowedTools(item, 'edit').length > 0;
                                  return (
                                    <option key={item.id} value={item.id} disabled={!available}>
                                      {item.name}
                                      {available ? '' : ' · 暂无可用工具'}
                                    </option>
                                  );
                                })}
                              </select>
                            </Field>
                            <Field label="项目已允许的工具">
                              <select
                                required
                                value={binding.tool}
                                disabled={!tools.length}
                                aria-describedby={`${id}-mcp-${index}`}
                                onChange={(event) =>
                                  update(index, { ...binding, tool: event.target.value })
                                }
                              >
                                <option value="">请选择工具</option>
                                {binding.tool &&
                                !tools.some((tool) => tool.name === binding.tool) ? (
                                  <option value={binding.tool} disabled>
                                    不可用 · {binding.tool}
                                  </option>
                                ) : null}
                                {tools.map((tool) => (
                                  <option key={tool.name} value={tool.name}>
                                    {tool.name} · {tool.access === 'read' ? '只读' : '每次审批'}
                                  </option>
                                ))}
                              </select>
                            </Field>
                          </div>
                          <p
                            className={mcpIssue ? 'ext-binding-warning' : 'ext-help'}
                            id={`${id}-mcp-${index}`}
                          >
                            {extensions.isPending
                              ? '正在读取项目 MCP 服务…'
                              : mcpIssue ||
                                '仅列出已连接、已启用的项目 MCP 服务中已发现且已允许的工具。'}
                          </p>
                          {server?.tools.find((tool) => tool.name === binding.tool)?.description ? (
                            <p className="ext-help">
                              {server.tools.find((tool) => tool.name === binding.tool)?.description}
                            </p>
                          ) : null}
                        </>
                      ) : binding.kind === 'http' ? (
                        <>
                          <Field
                            label="固定 HTTPS URL"
                            help="使用公开域名和默认端口，不包含账号、密码或 # 片段。"
                          >
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
                            label="输入参数名"
                            help="作为查询参数键；也可在 URL 的完整路径段中使用同名占位符。"
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
                            label="输入描述"
                            help="说明唯一字符串输入的用途，最多 300 个字符。"
                          >
                            <textarea
                              required
                              rows={2}
                              maxLength={300}
                              placeholder="要查询天气的城市名称，例如 Beijing"
                              value={binding.description}
                              onChange={(event) =>
                                update(index, { ...binding, description: event.target.value })
                              }
                            />
                          </Field>
                          <p className="ext-help">
                            只接受一个 1–200 个字符的字符串输入。例：参数 location 可填入
                            {' https://wttr.in/{location}?format=j1 '}
                            的路径；没有占位符时会添加为查询参数。
                          </p>
                        </>
                      ) : (
                        <>
                          <Field label="命令预设">
                            <select value={binding.preset} disabled>
                              <option value="pdftotext">pdftotext · PDF 转文本</option>
                            </select>
                          </Field>
                          <p className="ext-help">
                            需要编辑模式、本地已安装 pdftotext，并逐次审批。仅处理项目内不超过 16
                            MiB 的 PDF，提取前 10 页。
                          </p>
                        </>
                      )}
                      <div className="ext-binding-actions">
                        <ActionButton
                          danger
                          aria-label={`移除绑定 ${label}`}
                          onClick={() => {
                            focusRow.current = bindings.length > 1 ? Math.max(0, index - 1) : -1;
                            change(bindings.filter((_, position) => position !== index));
                          }}
                        >
                          移除绑定
                        </ActionButton>
                      </div>
                    </div>
                  </fieldset>
                );
              })}
              <div className="ext-binding-actions">
                <ActionButton
                  ref={addButton}
                  disabled={bindings.length >= maxBindings}
                  onClick={() => {
                    focusRow.current = bindings.length;
                    change([...bindings, newBinding('builtin')]);
                  }}
                >
                  添加工具绑定
                </ActionButton>
                <span className="ext-help">
                  {bindings.length} / {maxBindings}
                </span>
              </div>
            </fieldset>
            {hasMcp ? (
              <div className="ext-binding-mcp-status">
                {!servers.length && extensions.data ? (
                  <p className="ext-help">
                    项目尚未安装 MCP 服务。请在「项目扩展 → MCP」中添加、测试并允许工具。
                  </p>
                ) : null}
                <ErrorMessage error={extensions.error} />
                <ActionButton
                  disabled={extensions.isFetching || busy}
                  onClick={() => void extensions.refetch()}
                >
                  {extensions.isFetching ? '正在刷新 MCP…' : '刷新项目 MCP 工具'}
                </ActionButton>
              </div>
            ) : null}
          </>
        ) : null}
        <ErrorMessage error={error} />
        <div className="ext-dialog-actions">
          <span className="ext-save-state" role="status" aria-live="polite">
            {busy ? '正在保存工具绑定…' : dirty ? '有未保存的工具绑定，关闭后将丢弃更改。' : notice}
          </span>
          <ActionButton disabled={busy} onClick={onClose}>
            关闭
          </ActionButton>
          <ActionButton
            type="submit"
            primary
            disabled={busy || !query.data || !dirty || (hasMcp && !extensions.data)}
          >
            保存工具绑定
          </ActionButton>
        </div>
      </form>
    </FeatureDialog>
  );
}

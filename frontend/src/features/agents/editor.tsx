import { useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentCard, AgentConfig } from '@shared/types';
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
      else setNotice('已读取最新项目依赖。当前引用版本无需更新，请检查下方可用性提示。');
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
      if (!found) throw new Error('此智能体已不存在，请关闭编辑器并刷新列表。');
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
      setError('请填写智能体名称和工作指令。');
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
        setError('项目依赖已变化。请处理依赖提示，版本更新需要刷新并确认后才能保存。');
        return;
      }
      const saved = await save.mutateAsync(
        item
          ? { action: 'save', id: item.id, baseRevisionId: item.revisionId, config: prepared }
          : { action: 'create', config: prepared },
      );
      onSaved(`「${saved.config.name}」已保存为 v${saved.version}，新会话将使用此版本。`);
      onClose();
    } catch (cause) {
      setError(`${messageOf(cause)} 当前编辑内容已保留。`);
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
            ? '查看智能体配置'
            : item
              ? '编辑智能体'
              : template
                ? '从模板创建智能体'
                : '创建智能体'
        }
        description={`${projectName}${item ? ` · v${item.version}` : ''} · 配置保存为独立版本，已有会话继续使用原版本。`}
        busy={busy}
        wide
        onClose={close}
      >
        <form onSubmit={(event) => void submit(event)}>
          {archived ? (
            <p className="agent-callout">此智能体已归档，可在列表中复制为新智能体。</p>
          ) : null}
          {missing ? (
            <p className="agent-error" role="alert">
              此智能体已不存在，请关闭编辑器并重新加载列表。
            </p>
          ) : null}
          {revisionChanged ? (
            <div className="agent-callout" role="alert">
              <p>其他操作已更新此智能体，当前输入已保留。加载最新配置后可继续编辑。</p>
              <Button variant="secondary" disabled={busy} onClick={() => void loadLatest()}>
                加载最新配置
              </Button>
            </div>
          ) : null}
          <fieldset
            className="agent-editor-fields"
            disabled={busy || archived || Boolean(refresh || replacement || discard)}
          >
            <section className="agent-editor-section">
              <h3>基本信息</h3>
              <div className="agent-basic-fields">
                <label className="agent-field">
                  <span>
                    智能体名称 <span aria-hidden="true">*</span>
                  </span>
                  <input
                    required
                    value={config.name}
                    placeholder="例如：资料整理助手"
                    onChange={(event) => change({ ...config, name: event.target.value })}
                  />
                </label>
                <label className="agent-field">
                  <span>一句话介绍</span>
                  <input
                    value={config.description}
                    placeholder="这个智能体擅长什么？"
                    onChange={(event) => change({ ...config, description: event.target.value })}
                  />
                </label>
              </div>
              <label className="agent-field">
                <span>
                  工作指令 <span aria-hidden="true">*</span>
                </span>
                <textarea
                  required
                  rows={7}
                  value={config.instructions}
                  placeholder="描述智能体的角色、工作方法、输出要求和边界。"
                  onChange={(event) => change({ ...config, instructions: event.target.value })}
                />
                <small>工作指令会在每次运行时生效；工具访问范围由下面的能力与依赖共同限定。</small>
              </label>
            </section>
            <section className="agent-editor-section">
              <h3>开场建议</h3>
              <p className="agent-help">为新会话准备常用问题，点击后可填入输入框。</p>
              <div className="agent-starters">
                {config.starters.map((starter, index) => (
                  <div className="agent-starter" key={index}>
                    <input
                      aria-label={`开场建议 ${index + 1}`}
                      value={starter}
                      placeholder="输入一条常用问题"
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
                      aria-label={`移除开场建议 ${index + 1}`}
                      onClick={() =>
                        change({
                          ...config,
                          starters: config.starters.filter((_, position) => position !== index),
                        })
                      }
                    >
                      移除
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="secondary"
                onClick={() => change({ ...config, starters: [...config.starters, ''] })}
              >
                添加开场建议
              </Button>
            </section>
            <section className="agent-editor-section">
              <h3>运行模式与能力</h3>
              <label className="agent-field agent-mode-field">
                <span>运行模式</span>
                <select
                  value={config.mode}
                  disabled={!item}
                  onChange={(event) => {
                    const mode = event.target.value === 'edit' ? 'edit' : 'readonly';
                    change({
                      ...config,
                      mode,
                      capabilities:
                        mode === 'readonly'
                          ? config.capabilities.filter((value) => !needsEdit(value))
                          : config.capabilities,
                    });
                  }}
                >
                  <option value="readonly">只读模式</option>
                  <option value="edit">编辑模式（修改与命令需确认）</option>
                </select>
                <small>
                  {item
                    ? '切回只读会关闭修改文件与执行命令。MCP 工具仍需逐项检查。'
                    : '新建智能体从只读模式开始。创建后，可在编辑配置中启用编辑模式。'}
                </small>
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
                <p className="agent-error">只读模式不能启用修改文件或执行命令，请调整运行模式。</p>
              ) : null}
            </section>
            <section
              className="agent-editor-section agent-dependency-status"
              aria-labelledby={`${id}-dependencies`}
            >
              <div>
                <h3 id={`${id}-dependencies`}>项目依赖</h3>
                <p className="agent-help">
                  Skill 与 MCP 按保存时的版本引用。项目扩展更新后，需要检查并确认。
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={extensions.isFetching}
                onClick={() => void refreshDependencies()}
              >
                {extensions.isFetching ? '正在读取…' : '检查并刷新依赖'}
              </Button>
            </section>
            {extensions.isPending ? (
              <p role="status" className="agent-help">
                正在读取项目扩展…
              </p>
            ) : null}
            {extensions.isError ? (
              <p className="agent-error" role="alert">
                {messageOf(extensions.error)} 请点击「检查并刷新依赖」重试。
              </p>
            ) : null}
            {extensions.data ? (
              <AgentDependencies config={config} items={extensions.data} onChange={change} />
            ) : null}
          </fieldset>
          <AgentProblems issues={issues} label="依赖需要处理" />
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
              {archived ? '关闭' : '取消'}
            </Button>
            {!archived ? (
              <Button type="submit" disabled={busy || blocked}>
                {busy ? '正在保存…' : item ? '保存新版本' : '创建智能体'}
              </Button>
            ) : null}
          </footer>
        </form>
      </AgentDialog>
      {refresh ? (
        <AgentDialog
          title="确认更新依赖版本"
          description="请确认这些依赖的新版本。已有会话继续使用原配置。"
          onClose={() => setRefresh(undefined)}
        >
          <ul className="agent-refresh-list">
            {refresh.changes.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
          <p className="agent-help">
            已选 Skill 调用方式与 MCP 工具保持原选择。更新后不可用的引用会继续提示，需要手动处理。
          </p>
          <footer className="agent-dialog-actions">
            <Button variant="secondary" onClick={() => setRefresh(undefined)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setConfig(refresh.config);
                setRefresh(undefined);
                setError('');
                setNotice('依赖版本已更新到当前草稿，请检查后保存。');
              }}
            >
              确认更新到草稿
            </Button>
          </footer>
        </AgentDialog>
      ) : null}
      {replacement ? (
        <AgentDialog
          title="载入最新配置"
          description={`将使用「${replacement.config.name}」v${replacement.version} 替换当前编辑内容。`}
          onClose={() => setReplacement(undefined)}
        >
          <p>尚未保存的修改将丢弃。</p>
          <footer className="agent-dialog-actions">
            <Button variant="secondary" onClick={() => setReplacement(undefined)}>
              保留当前编辑
            </Button>
            <Button
              onClick={() => {
                setItem(replacement);
                setConfig(structuredClone(replacement.config));
                setBaseline(JSON.stringify(replacement.config));
                setReplacement(undefined);
                setError('');
                setNotice('已载入最新配置。');
              }}
            >
              确认载入
            </Button>
          </footer>
        </AgentDialog>
      ) : null}
      {discard ? (
        <AgentDialog
          title="放弃未保存的修改？"
          description="关闭后，本次输入不会保存。"
          onClose={() => setDiscard(false)}
        >
          <footer className="agent-dialog-actions">
            <Button variant="secondary" onClick={() => setDiscard(false)}>
              继续编辑
            </Button>
            <Button variant="destructive" onClick={onClose}>
              放弃修改
            </Button>
          </footer>
        </AgentDialog>
      ) : null}
    </>
  );
}

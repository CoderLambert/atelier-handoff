import type { AgentConfig, Extension } from '@shared/types';
import { Button } from '@/components/ui/button';
import { mcpReason, selectableTools, skillReason } from './api';

export function AgentDependencies({
  config,
  items,
  onChange,
}: {
  config: AgentConfig;
  items: Extension[];
  onChange: (config: AgentConfig) => void;
}) {
  const skills = items.filter((item) => item.kind === 'skill');
  const servers = items.filter((item) => item.kind === 'mcp');
  const skillsById = new Map(config.skills.map((selection) => [selection.id, selection]));
  const mcpById = new Map(config.mcp.map((selection) => [selection.id, selection]));
  const missingSkills = config.skills.filter(
    (selection) => !skills.some((item) => item.id === selection.id),
  );
  const missingMcp = config.mcp.filter(
    (selection) => !servers.some((item) => item.id === selection.id),
  );
  function removeSkill(id: string) {
    onChange({ ...config, skills: config.skills.filter((selection) => selection.id !== id) });
  }
  function removeMcp(id: string) {
    onChange({ ...config, mcp: config.mcp.filter((selection) => selection.id !== id) });
  }
  return (
    <>
      <section className="agent-editor-section" aria-label="Skill 配置">
        <h3>Skills</h3>
        <p className="agent-help">选择项目已安装的 Skill，并为每个 Skill 设置调用方式。</p>
        {!skills.length && !missingSkills.length ? (
          <p className="agent-empty-inline">暂无 Skill，可先在「项目扩展」中安装并启用。</p>
        ) : null}
        <div className="agent-dependency-list">
          {skills.map((item) => {
            const selection = skillsById.get(item.id);
            const autoReason = skillReason(item, 'auto');
            const manualReason = skillReason(item, 'manual');
            const unavailable = Boolean(autoReason && manualReason);
            const stale = Boolean(selection && selection.version !== item.version);
            return (
              <div className="agent-dependency" key={item.id}>
                <div className="agent-dependency-heading">
                  <label className="agent-check">
                    <input
                      type="checkbox"
                      checked={Boolean(selection)}
                      disabled={!selection && unavailable}
                      onChange={(event) => {
                        if (!event.target.checked) removeSkill(item.id);
                        else
                          onChange({
                            ...config,
                            skills: [
                              ...config.skills,
                              {
                                id: item.id,
                                version: item.version,
                                activation: autoReason ? 'manual' : 'auto',
                              },
                            ],
                          });
                      }}
                    />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.description || '暂无描述'}</small>
                    </span>
                  </label>
                  <span className="agent-version">v{selection?.version ?? item.version}</span>
                  {selection ? (
                    <label className="agent-activation">
                      <span className="sr-only">{item.name} 调用方式</span>
                      <select
                        aria-label={`${item.name} 调用方式`}
                        value={selection.activation}
                        disabled={stale}
                        onChange={(event) => {
                          const activation = event.target.value === 'auto' ? 'auto' : 'manual';
                          onChange({
                            ...config,
                            skills: config.skills.map((value) =>
                              value.id === item.id ? { ...value, activation } : value,
                            ),
                          });
                        }}
                      >
                        <option value="auto" disabled={Boolean(autoReason)}>
                          自动调用
                        </option>
                        <option value="manual" disabled={Boolean(manualReason)}>
                          手动调用
                        </option>
                      </select>
                    </label>
                  ) : null}
                </div>
                {stale ? (
                  <p className="agent-dependency-warning">
                    项目版本已更新至 v{item.version}，请刷新依赖并确认。
                  </p>
                ) : null}
                {selection ? (
                  <p
                    className={
                      skillReason(item, selection.activation)
                        ? 'agent-dependency-warning'
                        : 'agent-help'
                    }
                  >
                    {skillReason(item, selection.activation) ||
                      (selection.activation === 'auto'
                        ? '智能体可以按任务需要自动加载。'
                        : '在会话中输入 / 手动选择后加载。')}
                  </p>
                ) : unavailable ? (
                  <p className="agent-dependency-warning">
                    {autoReason}；{manualReason}
                  </p>
                ) : null}
                {selection && !unavailable && (autoReason || manualReason) ? (
                  <p className="agent-help">
                    {autoReason
                      ? `自动调用不可用：${autoReason}。`
                      : `手动调用不可用：${manualReason}。`}
                  </p>
                ) : null}
              </div>
            );
          })}
          {missingSkills.map((selection) => (
            <div className="agent-dependency agent-missing" key={selection.id}>
              <span>
                {selection.id} · v{selection.version} · Skill 已移除
              </span>
              <Button variant="ghost" onClick={() => removeSkill(selection.id)}>
                移除引用
              </Button>
            </div>
          ))}
        </div>
      </section>
      <section className="agent-editor-section" aria-label="MCP 工具配置">
        <h3>MCP 工具</h3>
        <p className="agent-help">逐项选择智能体可用的工具。新发现或新允许的工具需要再次勾选。</p>
        {!servers.length && !missingMcp.length ? (
          <p className="agent-empty-inline">暂无 MCP，可先在「项目扩展」中连接服务并允许工具。</p>
        ) : null}
        <div className="agent-dependency-list">
          {servers.map((item) => {
            const selection = mcpById.get(item.id);
            const reason = mcpReason(item);
            const stale = Boolean(selection && selection.version !== item.version);
            const selectable = new Set(selectableTools(item, config.mode).map((tool) => tool.name));
            const discovered = new Map(item.tools.map((tool) => [tool.name, tool]));
            const accessByName = new Map(item.allowedTools.map((tool) => [tool.name, tool.access]));
            const names = [
              ...new Set([
                ...item.allowedTools.map((tool) => tool.name),
                ...(selection?.tools ?? []),
              ]),
            ];
            return (
              <div className="agent-dependency" key={item.id}>
                <div className="agent-dependency-heading">
                  <div className="agent-dependency-copy">
                    <strong>{item.name}</strong>
                    <p className="agent-help">{item.description || '暂无描述'}</p>
                  </div>
                  <span className="agent-version">v{selection?.version ?? item.version}</span>
                  {selection ? (
                    <Button variant="ghost" onClick={() => removeMcp(item.id)}>
                      移除此 MCP
                    </Button>
                  ) : null}
                </div>
                {reason ? <p className="agent-dependency-warning">{reason}</p> : null}
                {stale ? (
                  <p className="agent-dependency-warning">
                    项目版本已更新至 v{item.version}，请刷新依赖并确认。
                  </p>
                ) : null}
                {!names.length ? (
                  <p className="agent-help">尚无允许的工具，请先在项目扩展中配置。</p>
                ) : null}
                <div className="agent-tools">
                  {names.map((name) => {
                    const checked = Boolean(selection?.tools.includes(name));
                    const allowed = selectable.has(name);
                    const approval = accessByName.get(name) === 'approval';
                    const toolReason =
                      reason ||
                      (!discovered.has(name)
                        ? '工具已不在发现结果中'
                        : !accessByName.has(name)
                          ? '项目已撤销允许'
                          : approval && config.mode === 'readonly'
                            ? '需要编辑模式'
                            : '');
                    return (
                      <label className="agent-check agent-tool" key={name}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && (!allowed || stale)}
                          onChange={(event) => {
                            const tools = event.target.checked
                              ? [...(selection?.tools ?? []), name]
                              : (selection?.tools ?? []).filter((value) => value !== name);
                            const others = config.mcp.filter((value) => value.id !== item.id);
                            onChange({
                              ...config,
                              mcp: tools.length
                                ? [
                                    ...others,
                                    {
                                      id: item.id,
                                      version: selection?.version ?? item.version,
                                      tools,
                                    },
                                  ]
                                : others,
                            });
                          }}
                        />
                        <span>
                          <strong>{name}</strong>
                          <small>{discovered.get(name)?.description || '暂无工具描述'}</small>
                          <small className={!allowed ? 'agent-dependency-warning' : ''}>
                            {toolReason || (approval ? '每次执行需确认' : '只读工具')}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {missingMcp.map((selection) => (
            <div className="agent-dependency agent-missing" key={selection.id}>
              <span>
                {selection.id} · v{selection.version} · MCP 已移除
                <br />
                {selection.tools.join('、')}
              </span>
              <Button variant="ghost" onClick={() => removeMcp(selection.id)}>
                移除引用
              </Button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

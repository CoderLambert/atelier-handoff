/**
 * @file 编辑智能体的技能与 MCP 依赖。
 * @implementation 根据扩展列表展示可选项和依赖状态，通过受控配置回调增删选择及调整工具。
 * @updated 2026-11-23T04:51:34+08:00
 */
import { OptionsSelect } from '@/components/options-select';
import { useUiTranslation } from '@/i18n';
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
  const { t } = useUiTranslation('extensions');
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
      <section className="agent-editor-section" aria-label={t('dependency.skillsLabel')}>
        <h3>{t('common.skills')}</h3>
        <p className="agent-help">{t('dependency.skillsHelp')}</p>
        {!skills.length && !missingSkills.length ? (
          <p className="agent-empty-inline">{t('dependency.noSkills')}</p>
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
                      <small>{item.description || t('common.noDescription')}</small>
                    </span>
                  </label>
                  <span className="agent-version">v{selection?.version ?? item.version}</span>
                  {selection ? (
                    <label className="agent-activation">
                      <span className="sr-only">
                        {t('dependency.activationLabel', { name: item.name })}
                      </span>
                      <OptionsSelect
                        size="sm"
                        aria-label={t('dependency.activationLabel', { name: item.name })}
                        value={selection.activation}
                        disabled={stale}
                        options={[
                          {
                            value: 'auto',
                            label: t('dependency.auto'),
                            disabled: Boolean(autoReason),
                          },
                          {
                            value: 'manual',
                            label: t('dependency.manual'),
                            disabled: Boolean(manualReason),
                          },
                        ]}
                        onValueChange={(activation) => {
                          onChange({
                            ...config,
                            skills: config.skills.map((value) =>
                              value.id === item.id ? { ...value, activation } : value,
                            ),
                          });
                        }}
                      />
                    </label>
                  ) : null}
                </div>
                {stale ? (
                  <p className="agent-dependency-warning">
                    {t('dependency.updatedVersion', { version: item.version })}
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
                        ? t('dependency.autoHelp')
                        : t('dependency.manualHelp'))}
                  </p>
                ) : unavailable ? (
                  <p className="agent-dependency-warning">
                    {autoReason}
                    {t('common.reasonSeparator')}
                    {manualReason}
                  </p>
                ) : null}
                {selection && !unavailable && (autoReason || manualReason) ? (
                  <p className="agent-help">
                    {autoReason
                      ? t('dependency.autoUnavailable', { reason: autoReason })
                      : t('dependency.manualUnavailable', { reason: manualReason })}
                  </p>
                ) : null}
              </div>
            );
          })}
          {missingSkills.map((selection) => (
            <div className="agent-dependency agent-missing" key={selection.id}>
              <span>
                {t('dependency.removedSkill', { name: selection.id, version: selection.version })}
              </span>
              <Button variant="ghost" size="sm" onClick={() => removeSkill(selection.id)}>
                {t('dependency.removeReference')}
              </Button>
            </div>
          ))}
        </div>
      </section>
      <section className="agent-editor-section" aria-label={t('dependency.mcpLabel')}>
        <h3>{t('common.mcpTools')}</h3>
        <p className="agent-help">{t('dependency.mcpHelp')}</p>
        {!servers.length && !missingMcp.length ? (
          <p className="agent-empty-inline">{t('dependency.noMcp')}</p>
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
                    <p className="agent-help">{item.description || t('common.noDescription')}</p>
                  </div>
                  <span className="agent-version">v{selection?.version ?? item.version}</span>
                  {selection ? (
                    <Button variant="ghost" size="sm" onClick={() => removeMcp(item.id)}>
                      {t('dependency.removeMcp')}
                    </Button>
                  ) : null}
                </div>
                {reason ? <p className="agent-dependency-warning">{reason}</p> : null}
                {stale ? (
                  <p className="agent-dependency-warning">
                    {t('dependency.updatedVersion', { version: item.version })}
                  </p>
                ) : null}
                {!names.length ? (
                  <p className="agent-help">{t('dependency.noAllowedTools')}</p>
                ) : null}
                <div className="agent-tools">
                  {names.map((name) => {
                    const checked = Boolean(selection?.tools.includes(name));
                    const allowed = selectable.has(name);
                    const approval = accessByName.get(name) === 'approval';
                    const toolReason =
                      reason ||
                      (!discovered.has(name)
                        ? t('dependency.toolMissing')
                        : !accessByName.has(name)
                          ? t('dependency.permissionRevoked')
                          : approval && config.mode === 'readonly'
                            ? t('dependency.editRequired')
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
                          <small>
                            {discovered.get(name)?.description || t('dependency.noToolDescription')}
                          </small>
                          <small className={!allowed ? 'agent-dependency-warning' : ''}>
                            {toolReason ||
                              (approval ? t('dependency.approvalHelp') : t('common.readonlyTool'))}
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
                {t('dependency.removedMcp', { name: selection.id, version: selection.version })}
                <br />
                {selection.tools.join(t('common.separator'))}
              </span>
              <Button variant="ghost" size="sm" onClick={() => removeMcp(selection.id)}>
                {t('dependency.removeReference')}
              </Button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

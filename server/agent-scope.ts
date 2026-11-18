import {
  AppError,
  type AgentCapability,
  type AgentRevision,
  type ExtensionSelection,
  type Mode,
} from '../shared/types.js';
import { ProjectExtensions } from './extensions.js';

export function agentCapabilitiesFor(revision: AgentRevision, mode: Mode, retry: boolean) {
  return revision.config.capabilities.filter((capability) => {
    if (capability === 'write' || capability === 'command') return !retry && mode === 'edit';
    if (retry && capability === 'attachments') return false;
    return true;
  });
}

export function agentRunInfo(revision: AgentRevision, capabilities: AgentCapability[]) {
  return {
    id: revision.agentId,
    revisionId: revision.id,
    name: revision.config.name,
    version: revision.version,
    capabilities,
  };
}

export function resolveAgentExtensions(
  extensions: ProjectExtensions,
  revision: AgentRevision,
  mode: Mode,
  text: string,
  selections: ExtensionSelection[],
) {
  const { projectId, config } = revision;
  const skills = new Map(config.skills.map((skill) => [skill.id, skill]));
  const services = new Map(config.mcp.map((item) => [item.id, item]));
  const explicit = new Map<string, ExtensionSelection>();
  const deny = () =>
    new AppError('AGENT_CAPABILITY_DENIED', '所选扩展或工具不在此智能体的授权范围内。', 403);
  for (const selection of selections) {
    const skill = skills.get(selection.id);
    const service = services.get(selection.id);
    if ((!skill && !service) || selection.version !== (skill ?? service)?.version) throw deny();
    if (skill && selection.tools !== undefined) throw deny();
    if (service && selection.tools?.some((name) => !service.tools.includes(name))) throw deny();
    explicit.set(selection.id, selection);
  }
  for (const service of services.values()) {
    const current = extensions.get(projectId, service.id);
    if (current.kind !== 'mcp') throw deny();
    const available = current.allowedTools
      .filter(
        (tool) => service.tools.includes(tool.name) && (mode === 'edit' || tool.access === 'read'),
      )
      .map((tool) => tool.name);
    const selected = explicit.get(service.id);
    if (selected?.tools?.some((tool) => !available.includes(tool))) throw deny();
    const tools = selected?.tools ?? available;
    if (tools.length) explicit.set(service.id, { id: service.id, version: service.version, tools });
    else explicit.delete(service.id);
  }
  return extensions.resolve(
    projectId,
    mode,
    text,
    [...explicit.values()],
    new Set([...skills.keys(), ...services.keys()]),
  );
}

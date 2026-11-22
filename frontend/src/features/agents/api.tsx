/**
 * @file 提供智能体配置的前端数据操作和依赖检查。
 * @implementation 管理项目智能体查询与变更，定义能力说明和初始配置，并检查及刷新扩展依赖版本。
 * @updated 2026-11-20T12:10:16+08:00
 */
import { getTranslator } from '@/i18n';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentCapability, AgentCard, AgentConfig, Extension } from '@shared/types';
import { api } from '@/api/client';
import { autoEnabled, extensionDetail, extensionKeys } from '@/features/extensions/api';

export const agentKeys = {
  list: (projectId: string) => ['agents', projectId, 'list'] as const,
  mutations: (projectId: string) => ['agents', projectId, 'mutation'] as const,
};
export const agentEndpoint = (projectId: string, suffix?: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/agents${suffix ? `/${suffix}` : ''}`;
export const agentsQuery = (projectId: string) =>
  queryOptions({
    queryKey: agentKeys.list(projectId),
    enabled: Boolean(projectId),
    queryFn: async ({ signal }) => {
      const result = await api<{ items: AgentCard[] }>(agentEndpoint(projectId), { signal });
      if (!Array.isArray(result?.items)) throw new Error('智能体列表响应缺少 items，请重新加载。');
      return result.items;
    },
  });

type AgentOperation =
  | { action: 'create'; config: AgentConfig }
  | { action: 'save'; id: string; baseRevisionId: string; config: AgentConfig }
  | { action: 'archive' | 'duplicate'; id: string; baseRevisionId: string };

export function useAgentMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: agentKeys.mutations(projectId),
    scope: { id: `agents:${projectId}` },
    mutationFn: async (operation: AgentOperation) => {
      const suffix =
        operation.action === 'create'
          ? undefined
          : `${encodeURIComponent(operation.id)}${operation.action === 'save' ? '' : `/${operation.action}`}`;
      const body =
        operation.action === 'create'
          ? operation.config
          : operation.action === 'save'
            ? { baseRevisionId: operation.baseRevisionId, config: operation.config }
            : { baseRevisionId: operation.baseRevisionId };
      const result = await api<{ agent: AgentCard }>(agentEndpoint(projectId, suffix), {
        method: operation.action === 'save' ? 'PATCH' : 'POST',
        body,
      });
      if (!result?.agent?.id) throw new Error('操作响应缺少智能体信息，请刷新列表确认结果。');
      return result.agent;
    },
    onMutate: () => client.cancelQueries({ queryKey: agentKeys.list(projectId) }),
    onSuccess: (agent) => {
      client.setQueryData<AgentCard[]>(agentKeys.list(projectId), (items) =>
        items?.some((value) => value.id === agent.id)
          ? items.map((value) => (value.id === agent.id ? agent : value))
          : [...(items ?? []), agent],
      );
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: agentKeys.list(projectId) }),
        client.invalidateQueries({ queryKey: extensionKeys.list(projectId) }),
      ]);
    },
  });
}

export const capabilityLabels: Record<AgentCapability, { label: string; description: string }> = {
  read: {
    get label() {
      return getTranslator('extensions')('capability.readLabel');
    },
    get description() {
      return getTranslator('extensions')('capability.readDescription');
    },
  },
  search: {
    get label() {
      return getTranslator('extensions')('capability.searchLabel');
    },
    get description() {
      return getTranslator('extensions')('capability.searchDescription');
    },
  },
  context: {
    get label() {
      return getTranslator('extensions')('capability.contextLabel');
    },
    get description() {
      return getTranslator('extensions')('capability.contextDescription');
    },
  },
  attachments: {
    get label() {
      return getTranslator('extensions')('capability.attachmentsLabel');
    },
    get description() {
      return getTranslator('extensions')('capability.attachmentsDescription');
    },
  },
  plan: {
    get label() {
      return getTranslator('extensions')('capability.planLabel');
    },
    get description() {
      return getTranslator('extensions')('capability.planDescription');
    },
  },
  artifact: {
    get label() {
      return getTranslator('extensions')('capability.artifactLabel');
    },
    get description() {
      return getTranslator('extensions')('capability.artifactDescription');
    },
  },
  write: {
    get label() {
      return getTranslator('extensions')('capability.writeLabel');
    },
    get description() {
      return getTranslator('extensions')('capability.writeDescription');
    },
  },
  command: {
    get label() {
      return getTranslator('extensions')('capability.commandLabel');
    },
    get description() {
      return getTranslator('extensions')('capability.commandDescription');
    },
  },
  browser: {
    get label() {
      return getTranslator('extensions')('capability.browserLabel');
    },
    get description() {
      return getTranslator('extensions')('capability.browserDescription');
    },
  },
};
export const capabilityOptions = Object.keys(capabilityLabels) as AgentCapability[];
export const needsEdit = (capability: AgentCapability) =>
  capability === 'write' || capability === 'command';

export function initialConfig(template = false): AgentConfig {
  return {
    name: template ? '资料整理助手' : '',
    description: template ? '梳理项目文件与附件，形成有来源的摘要、资料清单和待办。' : '',
    instructions: template
      ? '你是这个项目的资料整理助手。先确认整理目标，再阅读用户提供的项目文件与附件。按主题归类资料，提炼关键事实、结论和待办，并标注文件路径或资料来源。明确区分原始事实、推断和待核实信息；遇到缺失资料时说明缺口，不编造内容。优先用简洁的中文呈现，必要时生成结构清晰的交付物。'
      : '',
    starters: template
      ? [
          '梳理这个项目的资料，整理一份主题清单。',
          '总结我上传的附件，并列出关键结论和来源。',
          '找出资料中的待办、分歧与待核实问题。',
        ]
      : [],
    mode: 'readonly',
    capabilities: ['read', 'search', 'context', 'attachments', 'plan', 'artifact'],
    skills: [],
    mcp: [],
  };
}
export function skillReason(item: Extension | undefined, activation: 'auto' | 'manual') {
  const t = getTranslator('extensions');
  if (!item || item.kind !== 'skill') return t('dependency.skillMissing');
  if (!item.enabled) return t('dependency.skillDisabled');
  if (!item.supported)
    return extensionDetail(item.compatibility) || t('dependency.skillUnsupported');
  if (activation === 'auto' && !autoEnabled(item)) return t('dependency.autoNotAllowed');
  if (activation === 'manual' && item.userInvocable === false)
    return t('dependency.manualUnsupported');
  return '';
}
export function mcpReason(item: Extension | undefined) {
  const t = getTranslator('extensions');
  if (!item || item.kind !== 'mcp') return t('dependency.mcpMissing');
  if (!item.enabled) return t('dependency.mcpDisabled');
  if (item.status !== 'connected') return t('dependency.mcpNotConnected');
  return '';
}
export function selectableTools(item: Extension, mode: AgentConfig['mode']) {
  if (item.kind !== 'mcp' || mcpReason(item)) return [];
  const discovered = new Set(item.tools.map((tool) => tool.name));
  return item.allowedTools.filter(
    (tool, index, all) =>
      discovered.has(tool.name) &&
      (mode === 'edit' || tool.access === 'read') &&
      all.findIndex((other) => other.name === tool.name) === index,
  );
}
const agentIssueMessages = new Map([
  ['智能体已归档。', 'agentIssue.archived'],
  ['智能体依赖的历史快照无效，请重新发布配置。', 'agentIssue.invalidSnapshot'],
  ['智能体依赖的历史快照与配置不一致，请重新发布配置。', 'agentIssue.snapshotMismatch'],
  [
    '桌面端已改用原生浏览器，请移除 Playwright 依赖并在新版本启用浏览器能力。',
    'agentIssue.legacyBrowser',
  ],
] as const);

/** Translate the server's known diagnostics while retaining dependency names as data. */
export function agentIssueMessage(message: string): string {
  const t = getTranslator('extensions');
  for (const [source, key] of agentIssueMessages) {
    if (message === source) return t(key);
  }
  const dependencies = [
    [/^(Skill|MCP) (.+) 的内容或授权已变化，请重新选择并发布新版本。$/, 'agentIssue.changed'],
    [/^(Skill|MCP) (.+) 已移除或不属于当前项目。$/, 'agentIssue.missing'],
    [/^(Skill|MCP) (.+) 已停用或更新，请重新选择。$/, 'agentIssue.disabled'],
  ] as const;
  for (const [pattern, key] of dependencies) {
    const match = pattern.exec(message);
    if (match?.[1] && match[2]) return t(key, { kind: match[1], name: match[2] });
  }
  const skills = [
    [/^Skill (.+) 的内容不兼容，请检查扩展配置。$/, 'agentIssue.incompatible'],
    [/^Skill (.+) 不允许手动调用。$/, 'agentIssue.manualForbidden'],
    [/^Skill (.+) 当前不允许按需调用或缺少用途描述。$/, 'agentIssue.autoForbidden'],
  ] as const;
  for (const [pattern, key] of skills) {
    const match = pattern.exec(message);
    if (match?.[1]) return t(key, { name: match[1] });
  }
  const tools = [
    [/^MCP (.+) 的工具 (.+) 已移除或撤销授权。$/, 'agentIssue.toolUnavailable'],
    [/^MCP (.+) 的工具 (.+) 需要受控修改模式。$/, 'agentIssue.toolRequiresEdit'],
  ] as const;
  for (const [pattern, key] of tools) {
    const match = pattern.exec(message);
    if (match?.[1] && match[2]) return t(key, { name: match[1], tool: match[2] });
  }
  return message;
}

export function dependencyIssues(config: AgentConfig, items: Extension[]) {
  const t = getTranslator('extensions');
  const byId = new Map(items.map((item) => [item.id, item]));
  const issues: string[] = [];
  for (const selection of config.skills) {
    const item = byId.get(selection.id);
    const label = item?.name || selection.id;
    const reason = skillReason(item, selection.activation);
    if (reason) issues.push(t('dependency.reason', { name: label, reason: reason }));
    if (item && item.version !== selection.version)
      issues.push(
        t('dependency.versionChanged', {
          name: label,
          previousVersion: selection.version,
          version: item.version,
        }),
      );
  }
  for (const selection of config.mcp) {
    const item = byId.get(selection.id);
    const label = item?.name || selection.id;
    const reason = mcpReason(item);
    if (reason) issues.push(t('dependency.reason', { name: label, reason: reason }));
    if (item && item.version !== selection.version)
      issues.push(
        t('dependency.versionChanged', {
          name: label,
          previousVersion: selection.version,
          version: item.version,
        }),
      );
    if (item?.kind === 'mcp' && !reason) {
      const allowed = new Set(selectableTools(item, config.mode).map((tool) => tool.name));
      const unavailable = selection.tools.filter((tool) => !allowed.has(tool));
      if (unavailable.length)
        issues.push(
          t('dependency.toolsUnavailable', {
            name: label,
            tools: unavailable.join(t('common.separator')),
          }),
        );
    }
    if (!selection.tools.length) issues.push(t('dependency.toolRequired', { name: label }));
  }
  return issues;
}
export function dependencyRefresh(config: AgentConfig, items: Extension[]) {
  const t = getTranslator('extensions');
  const byId = new Map(items.map((item) => [item.id, item]));
  const changes: string[] = [];
  const update = <T extends { id: string; version: number }>(
    selection: T,
    kind: 'skill' | 'mcp',
  ) => {
    const item = byId.get(selection.id);
    if (!item || item.kind !== kind || item.version === selection.version) return selection;
    changes.push(
      t('dependency.versionUpdate', {
        name: item.name,
        previousVersion: selection.version,
        version: item.version,
      }),
    );
    return { ...selection, version: item.version };
  };
  return {
    config: {
      ...config,
      skills: config.skills.map((selection) => update(selection, 'skill')),
      mcp: config.mcp.map((selection) => update(selection, 'mcp')),
    },
    changes,
  };
}

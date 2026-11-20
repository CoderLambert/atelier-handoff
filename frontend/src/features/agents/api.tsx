/**
 * @file 提供智能体配置的前端数据操作和依赖检查。
 * @implementation 管理项目智能体查询与变更，定义能力说明和初始配置，并检查及刷新扩展依赖版本。
 * @updated 2026-11-20T12:10:16+08:00
 */
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentCapability, AgentCard, AgentConfig, Extension } from '@shared/types';
import { api } from '@/api/client';
import { autoEnabled, extensionKeys } from '@/features/extensions/api';

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
  read: { label: '读取文件', description: '读取项目内的文件内容' },
  search: { label: '搜索项目', description: '查找文件与文本' },
  context: { label: '项目上下文', description: '使用会话中选择的项目文件' },
  attachments: { label: '读取附件', description: '使用会话中上传的资料' },
  plan: { label: '任务计划', description: '维护任务步骤与进度' },
  artifact: { label: '生成交付物', description: '生成可查看和下载的结果' },
  write: { label: '修改文件', description: '经确认后修改项目文件' },
  command: { label: '执行命令', description: '经确认后执行项目命令' },
  browser: {
    label: '内置浏览器',
    description: '项目启用后可读取网页和截图，点击、输入需逐次审批；网页内容可能发送给模型',
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
  if (!item || item.kind !== 'skill') return 'Skill 已移除或类型已改变';
  if (!item.enabled) return 'Skill 已停用';
  if (!item.supported) return item.compatibility || 'Skill 暂不兼容';
  if (activation === 'auto' && !autoEnabled(item)) return '项目未允许自动调用';
  if (activation === 'manual' && item.userInvocable === false) return 'Skill 不支持手动调用';
  return '';
}
export function mcpReason(item: Extension | undefined) {
  if (!item || item.kind !== 'mcp') return 'MCP 已移除或类型已改变';
  if (!item.enabled) return 'MCP 已停用';
  if (item.status !== 'connected') return '请先在项目扩展中测试并连接 MCP';
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
export function dependencyIssues(config: AgentConfig, items: Extension[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const issues: string[] = [];
  for (const selection of config.skills) {
    const item = byId.get(selection.id);
    const label = item?.name || selection.id;
    const reason = skillReason(item, selection.activation);
    if (reason) issues.push(`${label}：${reason}。`);
    if (item && item.version !== selection.version)
      issues.push(
        `${label}：已从 v${selection.version} 更新至 v${item.version}，请刷新依赖并确认。`,
      );
  }
  for (const selection of config.mcp) {
    const item = byId.get(selection.id);
    const label = item?.name || selection.id;
    const reason = mcpReason(item);
    if (reason) issues.push(`${label}：${reason}。`);
    if (item && item.version !== selection.version)
      issues.push(
        `${label}：已从 v${selection.version} 更新至 v${item.version}，请刷新依赖并确认。`,
      );
    if (item?.kind === 'mcp' && !reason) {
      const allowed = new Set(selectableTools(item, config.mode).map((tool) => tool.name));
      const unavailable = selection.tools.filter((tool) => !allowed.has(tool));
      if (unavailable.length)
        issues.push(
          `${label}：${unavailable.join('、')} 当前不可用，请移除或调整模式与项目工具权限。`,
        );
    }
    if (!selection.tools.length) issues.push(`${label}：请至少选择一个工具，或移除此 MCP。`);
  }
  return issues;
}
export function dependencyRefresh(config: AgentConfig, items: Extension[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const changes: string[] = [];
  const update = <T extends { id: string; version: number }>(
    selection: T,
    kind: 'skill' | 'mcp',
  ) => {
    const item = byId.get(selection.id);
    if (!item || item.kind !== kind || item.version === selection.version) return selection;
    changes.push(`${item.name}：v${selection.version} → v${item.version}`);
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

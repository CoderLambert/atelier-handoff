/**
 * @file 定义工作台智能体配置、版本快照与能力契约。
 * @implementation 描述运行模式、工具能力清单及智能体引用结构，不依赖 Zod 或其他共享模块。
 * @updated 2026-11-27T21:25:00+08:00
 */
export type Mode = 'readonly' | 'edit';

export const agentCapabilities = [
  'read',
  'search',
  'context',
  'attachments',
  'plan',
  'artifact',
  'browser',
  'write',
  'command',
] as const;

export type AgentCapability = (typeof agentCapabilities)[number];

export interface AgentSkillRef {
  id: string;
  version: number;
  activation: 'auto' | 'manual';
}

export interface AgentMcpRef {
  id: string;
  version: number;
  tools: string[];
}

export interface AgentConfig {
  name: string;
  description: string;
  instructions: string;
  starters: string[];
  mode: Mode;
  capabilities: AgentCapability[];
  skills: AgentSkillRef[];
  mcp: AgentMcpRef[];
}

export interface AgentProfile {
  id: string;
  projectId: string;
  revisionId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRevision {
  id: string;
  agentId: string;
  projectId: string;
  version: number;
  config: AgentConfig;
  createdAt: string;
  dependencies: unknown;
}

export interface AgentCard {
  id: string;
  projectId: string;
  revisionId: string;
  archived: boolean;
  version: number;
  config: AgentConfig;
  issues: string[];
}

export interface AgentRunInfo {
  id: string;
  revisionId: string;
  name: string;
  version: number;
  capabilities: AgentCapability[];
}

export interface AgentSessionInfo extends AgentRunInfo {
  canUpgrade?: boolean;
  mode: Mode;
  starters: string[];
  skills: AgentSkillRef[];
  mcp: AgentMcpRef[];
  issues: string[];
}

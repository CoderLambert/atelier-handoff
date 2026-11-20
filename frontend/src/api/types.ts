/**
 * @file 定义前端工作台 API 的响应类型。
 * @implementation 组合共享领域记录，描述启动信息、会话快照及内置网关状态。
 * @updated 2026-11-20T17:28:00+08:00
 */
import type {
  AppConfig,
  AgentSessionInfo,
  Artifact,
  Attachment,
  Message,
  Permission,
  Project,
  Run,
  RunEvent,
  Session,
  ToolCall,
} from '@shared/types';

export interface Page<T> {
  items: T[];
  total: number;
  nextOffset: number | null;
}

export interface ConfigInfo {
  config: AppConfig;
  capabilities: { commands: boolean };
  connection: { available: boolean; message: string };
  managedGateway?: { configPath: string; accountPresent: boolean; externalGateway: string };
}

export interface Bootstrap extends ConfigInfo {
  csrfToken: string;
  cursor: number;
  projects: Project[];
  sessions: Session[];
  runs: Run[];
  artifacts: Artifact[];
}

export interface Snapshot {
  agent?: AgentSessionInfo;
  session: Session;
  project: Project;
  messages: Message[];
  runs: Run[];
  tools: ToolCall[];
  permissions: Permission[];
  artifacts: Artifact[];
  attachments: Attachment[];
  events: RunEvent[];
  cursor: number;
}

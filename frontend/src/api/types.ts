/**
 * @file 定义前端工作台 API 的响应类型。
 * @implementation 组合共享领域记录，描述启动信息、含兼容性可选消息队列及子任务的会话快照和内置网关状态。
 * @updated 2026-11-21T02:17:11+08:00
 */
import type { GitSessionWorkspace } from '@shared/git-workbench';
import type { Subagent } from '@shared/subagents';
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
  SessionMessageQueue,
  ToolCall,
} from '@shared/types';

export interface Page<T> {
  items: T[];
  total: number;
  nextOffset: number | null;
}

export interface ConfigInfo {
  config: AppConfig;
  capabilities: { commands: boolean; nativeExecution?: boolean };
  connection: { available: boolean; message: string };
  managedGateway?: { configPath: string; accountPresent: boolean; externalGateway: string };
}

export interface Bootstrap extends ConfigInfo {
  csrfToken: string;
  workspaceLocation?: string;
  workspaceLastSession?: string;
  cursor: number;
  projects: Project[];
  sessions: Session[];
  runs: Run[];
  artifacts: Artifact[];
}

export interface Snapshot {
  workspace?: GitSessionWorkspace;
  agent?: AgentSessionInfo;
  session: Session;
  messageQueue?: SessionMessageQueue;
  project: Project;
  messages: Message[];
  inheritedMessages?: Session['inheritedMessages'];
  runs: Run[];
  tools: ToolCall[];
  subagents?: Subagent[];
  permissions: Permission[];
  artifacts: Artifact[];
  attachments: Attachment[];
  events: RunEvent[];
  cursor: number;
}

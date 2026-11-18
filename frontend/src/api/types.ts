import type {
  AppConfig,
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

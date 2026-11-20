/**
 * @file 定义工作台共享业务类型和基础辅助方法。
 * @implementation 描述项目、会话、运行、扩展及文件等数据结构，并提供状态、错误和常用数据处理方法。
 * @updated 2026-11-20T03:13:21+08:00
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_permission'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'interrupted';
export type Mode = 'readonly' | 'edit';
export const activeStatuses: RunStatus[] = ['queued', 'running', 'awaiting_permission', 'stopping'];
export interface Project {
  desktopBrowser?: { enabled: boolean; revision: string };
  id: string;
  name: string;
  path: string;
  branch: string;
  available: boolean;
  createdAt: string;
}
export interface ExtensionSelection {
  id: string;
  version: number;
  tools?: string[];
}
export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}
export interface AllowedMcpTool {
  name: string;
  access: 'read' | 'approval';
}
export type McpTransport =
  | { type: 'http'; url: string; tokenEnv?: string }
  | { type: 'stdio'; command: string; args: string[]; envNames: string[]; keepAlive?: boolean };
export interface ExtensionOrigin {
  location: string;
  key: string;
  revision: string;
  sha256?: string;
  upstreamVersion?: string;
}
export interface ExtensionBase {
  id: string;
  projectId: string;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  version: number;
  origin?: ExtensionOrigin;
}
export interface SkillPackage {
  digest: string;
  files: { path: string; data: string }[];
}
export type Extension = ExtensionBase &
  (
    | {
        kind: 'command' | 'skill';
        body: string;
        supported: boolean;
        compatibility?: string;
        userInvocable: boolean;
        modelInvocable?: boolean;
        autoInvoke?: boolean;
        package?: SkillPackage;
      }
    | {
        kind: 'mcp';
        provider?: 'mcp' | 'playwright-browser';
        browserOrigins?: string[];
        autoUseInChat?: boolean;
        transport: McpTransport;
        allowedTools: AllowedMcpTool[];
        tools: DiscoveredTool[];
        status?: 'connected' | 'needs-auth' | 'failed';
        statusMessage?: string;
      }
  );
export type SkillToolBinding =
  | { name: string; kind: 'builtin'; tool: 'list_files' | 'search_files' | 'publish_artifact' }
  | { name: string; kind: 'mcp'; extensionId: string; tool: string }
  | { name: string; kind: 'http'; url: string; parameter: string; description: string }
  | { name: string; kind: 'command'; preset: 'pdftotext' };

export interface UsedExtension {
  id: string;
  kind: Extension['kind'];
  name: string;
  version: number;
  tools?: string[];
}
export function retainedSkillSelections(
  extensions: UsedExtension[] | undefined,
): ExtensionSelection[] {
  return (extensions ?? [])
    .filter(({ kind }) => kind === 'skill')
    .map(({ id, version }) => ({ id, version }));
}
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

export const reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

export interface Draft {
  text: string;
  contextPaths: string[];
  attachmentIds: string[];
  mode: Mode;
  approvalMode?: 'automatic';
  model?: string;
  effort?: ReasoningEffort;
  extensionSelections?: ExtensionSelection[];
}
export interface Session {
  id: string;
  projectId: string;
  agentRevisionId?: string;
  title: string;
  status: 'active' | 'archived';
  sdkSessionId: string | null;
  sdkCostTotal?: number;
  sdkMode?: Mode;
  sdkConfigKey?: string;
  createdAt: string;
  updatedAt: string;
  draft: Draft;
}
export interface Step {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface Usage {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  sdkEstimateUsd: number | null;
  costEstimateUsd: null;
  pricingBasis: 'unknown';
  complete: boolean;
}
export interface Run {
  approvalMode?: 'automatic';
  maxSearchChargeFen?: number;
  browserRevision?: string;
  id: string;
  sessionId: string;
  projectId: string;
  prompt: string;
  status: RunStatus;
  mode: Mode;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  reason: string | null;
  error: string | null;
  retryOf: string | null;
  contextPaths: string[];
  attachmentIds: string[];
  plan: Step[];
  usage: Usage | null;
  config: AppConfig;
  extensions?: UsedExtension[];
  agent?: AgentRunInfo;
}
export interface QueuedSessionMessage {
  id: string;
  text: string;
  createdAt: string;
  error: string | null;
  extensions?: Run['extensions'];
}
export interface SessionMessageQueue {
  items: QueuedSessionMessage[];
  paused: boolean;
}
export type SendSessionMessageResult =
  { run: Run; queuedMessage?: never } | { queuedMessage: QueuedSessionMessage; run?: never };

export interface Message {
  id: string;
  sessionId: string;
  runId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}
export interface ToolCall {
  id: string;
  runId: string;
  sessionId: string;
  name: string;
  inputSummary: string;
  status: 'running' | 'awaiting_permission' | 'succeeded' | 'failed' | 'denied' | 'canceled';
  output: string;
  outputLength?: number;
  outputTruncated?: boolean;
  startedAt: string;
  endedAt: string | null;
  permissionId?: string;
}
export interface Permission {
  id: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  kind: 'write' | 'edit' | 'delete' | 'command' | 'mcp' | 'browser';
  path: string | null;
  command: string | null;
  before: string | null;
  after: string | null;
  diff: string;
  baseFingerprint: string | null;
  version: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired' | 'canceled';
  createdAt: string;
  expiresAt: string;
  reason: string;
  resolutionReason?: string;
  decisionSource?: 'automatic';
}
export interface Artifact {
  id: string;
  runId: string;
  sessionId: string;
  projectId: string;
  name: string;
  mime: string;
  size: number;
  fingerprint: string;
  availability: 'available' | 'unavailable';
  createdAt: string;
}
export const maxImageAttachmentBytes = 5 * 1024 * 1024;
export type AttachmentImageMime = 'image/png' | 'image/jpeg';
export function attachmentImageMime(name: string): AttachmentImageMime | undefined {
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
}

export interface Attachment {
  id: string;
  sessionId: string;
  name: string;
  mime: string;
  size: number;
  status: 'ready' | 'used';
  createdAt: string;
  removed?: boolean;
}
export interface RunEvent {
  id: number;
  runId: string;
  sessionId: string;
  seq: number;
  type: string;
  at: string;
  payload: Record<string, unknown>;
}
export interface GatewayModelCatalog {
  defaultModel: string;
  routesAvailable: boolean;
  models: Array<{
    id: string;
    displayName?: string;
    supportedEfforts?: ReasoningEffort[];
    provider?: string;
    effort?: string;
    serviceTier?: string;
  }>;
}
export interface AppConfig {
  gateway: string;
  managedGateway?: boolean;
  model: string;
  effort?: ReasoningEffort;
  limitExecution?: boolean;
  maxTurns: number;
  timeoutMs: number;
}
export interface Tables {
  projects: Project;
  sessions: Session;
  runs: Run;
  messages: Message;
  tools: ToolCall;
  permissions: Permission;
  artifacts: Artifact;
  attachments: Attachment;
  extensions: Extension;
  agents: AgentProfile;
  agentRevisions: AgentRevision;
}
export type Table = keyof Tables;
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly retryable = false,
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString();
export const emptyDraft = (): Draft => ({
  text: '',
  contextPaths: [],
  attachmentIds: [],
  mode: 'readonly',
});

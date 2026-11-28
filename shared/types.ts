/**
 * @file 定义工作台核心业务类型并重导出分域契约。
 * @implementation 描述项目、会话、运行、消息及核心记录表结构，同时保留分域后的错误、模型、扩展和智能体兼容导出。
 * @updated 2026-11-27T21:25:00+08:00
 */
import type { AgentProfile, AgentRevision, AgentRunInfo, Mode } from './agents.js';
import type { BashExecution } from './bash-execution.js';
import type { ContextUsage } from './context-usage.js';
import type { Extension, ExtensionSelection, UsedExtension } from './extensions.js';
import type { MessageQuote } from './message-quotes.js';
import type { AppConfig, ReasoningEffort } from './models.js';
import type { RunTranscript, TranscriptPart } from './ordered-transcript.js';
import type { RunRequestTiming } from './request-timing.js';
import type { RtkTrace } from './rtk-trace.js';
import type { RunScheduleMeta } from './schedules.js';

export * from './errors.js';
export * from './models.js';
export * from './extensions.js';
export * from './agents.js';
export * from './schedules.js';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_permission'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'interrupted';
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

export interface Draft {
  text: string;
  messageQuotes?: MessageQuote[];
  contextPaths: string[];
  attachmentIds: string[];
  mode: Mode;
  approvalMode?: 'automatic';
  executionPreference?: 'native-v1' | 'project-v1';
  model?: string;
  effort?: ReasoningEffort;
  extensionSelections?: ExtensionSelection[];
}

export interface SessionForkOrigin {
  sourceSessionId: string;
  sourceMessageId: string;
  sourceTitle: string;
  kind?: 'rewind';
}

export interface Session {
  id: string;
  projectId: string;
  agentRevisionId?: string;
  fork?: SessionForkOrigin;
  inheritedMessages?: InheritedMessage[];
  creatingFork?: true;
  createdFromDraft?: true;
  origin?: 'schedule';
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
  transcript?: RunTranscript;
  workspacePath?: string;
  executor?: 'native-v1' | 'project-v1';
  approvalMode?: 'automatic';
  maxSearchChargeFen?: number;
  browserRevision?: string;
  inputScope?: string;
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
  contextUsage?: ContextUsage;
  requestTiming?: RunRequestTiming;
  config: AppConfig;
  extensions?: UsedExtension[];
  agent?: AgentRunInfo;
  scheduleMeta?: RunScheduleMeta;
}

export interface QueuedSessionMessage {
  id: string;
  text: string;
  createdAt: string;
  error: string | null;
  scopeChanged?: true;
  extensions?: Run['extensions'];
  insertion?: 'live' | 'priority';
  delivery?: 'waiting' | 'sending' | 'unknown';
}

export interface SessionMessageQueue {
  items: QueuedSessionMessage[];
  paused: boolean;
}

export type SendSessionMessageResult =
  { run: Run; queuedMessage?: never } | { queuedMessage: QueuedSessionMessage; run?: never };

export interface Message {
  transcriptOrder?: number;
  transcriptParts?: TranscriptPart[];
  id: string;
  sessionId: string;
  runId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  forkAnchor?: { sdkSessionId: string; messageId: string; configKey?: string };
}

export type InheritedMessage = Pick<Message, 'id' | 'role' | 'text' | 'createdAt'>;

export interface ToolCall {
  transcriptOrder?: number;
  /** Promoted if the run closes before consuming the native call frame. */
  transcriptHookOrder?: number;
  id: string;
  runId: string;
  sessionId: string;
  subagentId?: string;
  name: string;
  inputSummary: string;
  /** Original command when the general input preview would truncate it. */
  command?: string;
  /** Added only after a matching receipt confirms the rewritten command executed. */
  rtk?: RtkTrace;
  status: 'running' | 'awaiting_permission' | 'succeeded' | 'failed' | 'denied' | 'canceled';
  output: string;
  outputLength?: number;
  outputTruncated?: boolean;
  bashExecution?: BashExecution;
  /** Scope of the separately retained native Bash log. Sizes are UTF-8 bytes. */
  bashLog?: {
    status: 'complete' | 'partial' | 'unavailable' | 'receipt-only';
    bytes?: number;
    sourceBytes?: number;
  };
  startedAt: string;
  endedAt: string | null;
  permissionId?: string;
}

export interface Permission {
  id: string;
  runId: string;
  sessionId: string;
  subagentId?: string;
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

export const emptyDraft = (): Draft => ({
  text: '',
  contextPaths: [],
  attachmentIds: [],
  mode: 'readonly',
});

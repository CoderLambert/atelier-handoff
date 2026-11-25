/**
 * @file 解码旧版 SQLite 快照记录。
 * @implementation 校验 JSON 字段和记录主键，保留已有可选字段，读取失败返回脱敏错误。
 * @updated 2026-11-21T01:00:00+08:00
 */
import { z } from 'zod';
import { contextUsageSchema } from '../../../shared/context-usage.js';
import { bashExecutionSchema } from '../../../shared/bash-execution.js';
import { messageQuotesSchema } from '../../../shared/message-quotes.js';
import {
  AppError,
  agentCapabilities,
  reasoningEfforts,
  type Tables,
} from '../../../shared/types.js';

const str = z.string();
const num = z.number();
const nullable = str.nullable();
const strings = z.array(str);
const obj = z.looseObject;
const mode = z.enum(['readonly', 'edit']);
const effort = z.enum(reasoningEfforts).optional();
const approvalMode = z.literal('automatic').optional();
const executor = z.enum(['native-v1', 'project-v1']).optional();
const identity = { id: str };
const scoped = { ...identity, sessionId: str };
const toolScope = { ...scoped, runId: str };
const selection = { id: str, version: num, tools: strings.optional() };
const config = obj({
  gateway: str,
  model: str,
  maxTurns: num,
  timeoutMs: num,
  managedGateway: z.boolean().optional(),
  magpieEnabled: z.boolean().optional(),
  limitExecution: z.boolean().optional(),
  effort,
});
const usage = obj({
  model: str,
  inputTokens: num.nullable(),
  outputTokens: num.nullable(),
  cacheReadTokens: num.nullable(),
  cacheCreationTokens: num.nullable(),
  sdkEstimateUsd: num.nullable(),
  costEstimateUsd: z.null(),
  pricingBasis: z.literal('unknown'),
  complete: z.boolean(),
});

export const records = {
  projects: obj({
    ...identity,
    name: str,
    path: str,
    branch: str,
    available: z.boolean(),
    createdAt: str,
    desktopBrowser: obj({ enabled: z.boolean(), revision: str }).optional(),
  }),
  sessions: obj({
    ...identity,
    projectId: str,
    title: str,
    status: z.enum(['active', 'archived']),
    agentRevisionId: str.optional(),
    sdkSessionId: nullable,
    sdkMode: mode.optional(),
    sdkCostTotal: num.optional(),
    sdkConfigKey: str.optional(),
    fork: obj({
      sourceSessionId: str,
      sourceMessageId: str,
      sourceTitle: str,
      kind: z.literal('rewind').optional(),
    }).optional(),
    inheritedMessages: z
      .array(
        obj({
          ...identity,
          role: z.enum(['user', 'assistant']),
          text: str,
          createdAt: str,
        }),
      )
      .optional(),
    creatingFork: z.literal(true).optional(),
    createdAt: str,
    updatedAt: str,
    draft: obj({
      text: str,
      messageQuotes: messageQuotesSchema.optional(),
      mode,
      contextPaths: strings,
      attachmentIds: strings,
      approvalMode,
      executionPreference: executor,
      effort,
      model: str.optional(),
      extensionSelections: z.array(obj(selection)).optional(),
    }),
  }),
  runs: obj({
    ...scoped,
    projectId: str,
    prompt: str,
    mode,
    status: z.enum([
      'queued',
      'running',
      'awaiting_permission',
      'stopping',
      'completed',
      'stopped',
      'failed',
      'interrupted',
    ]),
    createdAt: str,
    startedAt: nullable,
    endedAt: nullable,
    reason: nullable,
    error: nullable,
    retryOf: nullable,
    contextPaths: strings,
    attachmentIds: strings,
    plan: z.array(obj({ content: str, status: z.enum(['pending', 'in_progress', 'completed']) })),
    config,
    usage: usage.nullable(),
    contextUsage: contextUsageSchema.optional().catch(undefined),
    approvalMode,
    executor,
    maxSearchChargeFen: num.optional(),
    browserRevision: str.optional(),
    inputScope: str.optional(),
    extensions: z
      .array(obj({ ...selection, name: str, kind: z.enum(['skill', 'command', 'mcp']) }))
      .optional(),
    agent: obj({
      id: str,
      name: str,
      revisionId: str,
      version: num,
      capabilities: z.array(z.enum(agentCapabilities)),
    }).optional(),
  }),
  messages: obj({
    ...toolScope,
    role: z.enum(['user', 'assistant']),
    text: str,
    createdAt: str,
    forkAnchor: obj({ sdkSessionId: str, messageId: str, configKey: str.optional() }).optional(),
  }),
  tools: obj({
    ...toolScope,
    name: str,
    inputSummary: str,
    command: str.optional(),
    status: z.enum(['running', 'awaiting_permission', 'succeeded', 'failed', 'denied', 'canceled']),
    output: str,
    startedAt: str,
    endedAt: nullable,
    outputLength: num.optional(),
    outputTruncated: z.boolean().optional(),
    bashExecution: bashExecutionSchema.optional(),
    bashLog: obj({
      status: z.enum(['complete', 'partial', 'unavailable', 'receipt-only']),
      bytes: z.int().nonnegative().optional(),
      sourceBytes: z.int().nonnegative().optional(),
    }).optional(),
    permissionId: str.optional(),
  }),
  permissions: obj({
    ...toolScope,
    toolCallId: str,
    kind: z.enum(['write', 'edit', 'delete', 'command', 'mcp', 'browser']),
    path: nullable,
    command: nullable,
    before: nullable,
    after: nullable,
    diff: str,
    baseFingerprint: nullable,
    version: str,
    status: z.enum(['pending', 'allowed', 'denied', 'expired', 'canceled']),
    createdAt: str,
    expiresAt: str,
    reason: str,
    resolutionReason: str.optional(),
    decisionSource: z.literal('automatic').optional(),
  }),
  artifacts: obj({
    ...toolScope,
    projectId: str,
    name: str,
    mime: str,
    size: num,
    fingerprint: str,
    availability: z.enum(['available', 'unavailable']),
    createdAt: str,
  }),
  attachments: obj({
    ...scoped,
    name: str,
    mime: str,
    size: num,
    status: z.enum(['ready', 'used']),
    createdAt: str,
    removed: z.boolean().optional(),
  }),
} satisfies {
  [K in Exclude<keyof Tables, 'agents' | 'extensions' | 'agentRevisions'>]: z.ZodType<Tables[K]>;
};

function parse<T>(schema: z.ZodType<T>, text: string): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new AppError('INVALID_STORED_RECORD', '会话记录格式异常。', 500);
  }
}
export function decodeRecord<T extends { id: string }>(
  schema: z.ZodType<T>,
  row: { data: string; id: string },
): T {
  const value = parse(schema, row.data);
  if (value.id !== row.id) throw new AppError('INVALID_STORED_RECORD', '会话记录标识异常。', 500);
  return value;
}
const payload = z.record(str, z.unknown());
export const decodePayload = (text: string) => parse(payload, text);

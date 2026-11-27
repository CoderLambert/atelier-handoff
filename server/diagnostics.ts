/**
 * @file 构建脱敏的运行诊断数据。
 * @implementation 按白名单汇总运行配置、用量、事件和工具，通过共享 schema 校验并导出请求计时。
 * @updated 2026-11-27T03:02:10+08:00
 */
import { now, type Run, type RunEvent, type ToolCall } from '../shared/types.js';
import { runRequestTimingSchema } from '../shared/request-timing.js';

const eventFields: Record<string, readonly string[]> = {
  'run.created': ['status'],
  'run.status_changed': ['status'],
  'run.finished': ['status'],
  'process.spawned': ['pid'],
  'process.exited': ['code', 'signal', 'stderrBytes'],
  'sdk.initialized': ['model', 'version', 'resumed'],
  'sdk.first_text': ['elapsedMs'],
  'sdk.api_retry': ['attempt', 'maxRetries', 'retryDelayMs', 'httpStatus', 'error'],
  'sdk.error': ['stage', 'code'],
  'sdk.result': [
    'subtype',
    'isError',
    'terminalReason',
    'stopReason',
    'httpStatus',
    'turns',
    'durationMs',
    'apiDurationMs',
    'ttftMs',
    'deniedTools',
  ],
  'sdk.notice': ['type', 'subtype'],
  'skills.discovered': ['count', 'missingCount'],
  'skill.invoked': ['extensionId', 'name', 'version'],
  'tool.started': ['toolCallId'],
  'tool.finished': ['toolCallId', 'status'],
  'tool.blocked': ['toolCallId', 'tool', 'code'],
  'permission.requested': ['permissionId'],
  'permission.resolved': ['permissionId', 'status', 'decisionSource'],
};

function label(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !/^[\w][\w.:/-]{0,255}$/.test(value) ||
    value.includes('://') ||
    /(?:^|[/:])(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)/i.test(value)
  )
    return null;
  const secrets = [
    process.env.ATELIER_GATEWAY_TOKEN,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
  ];
  return secrets.some((secret) => secret && value.includes(secret)) ? null : value;
}

function eventDetails(event: RunEvent) {
  const details: Record<string, string | number | boolean | null> = {};
  for (const field of Object.hasOwn(eventFields, event.type) ? eventFields[event.type]! : []) {
    const value = event.payload[field];
    if (value === null || typeof value === 'boolean' || typeof value === 'number')
      details[field] = value;
    if (typeof value === 'string') details[field] = label(value);
  }
  return { sequence: event.seq, timestamp: event.at, type: label(event.type), details };
}

export function buildRunDiagnostics(
  run: Run,
  history: { events: RunEvent[]; eventCount: number },
  tools: ToolCall[],
) {
  let gateway = null;
  try {
    const url = new URL(run.config.gateway);
    if (url.protocol === 'http:' || url.protocol === 'https:') gateway = url.origin;
  } catch {
    /* Older or invalid configuration. */
  }
  const usage = run.usage;
  return {
    schemaVersion: 1,
    exportedAt: now(),
    run: {
      id: run.id,
      retryOf: run.retryOf,
      ...(run.agent
        ? {
            agent: {
              id: run.agent.id,
              revisionId: run.agent.revisionId,
              version: run.agent.version,
              capabilities: run.agent.capabilities,
            },
          }
        : {}),
      status: run.status,
      mode: run.mode,
      ...(run.approvalMode ? { approvalMode: run.approvalMode } : {}),
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      model: label(run.config?.model),
      gateway,
      limitExecution: run.config?.limitExecution,
      ...(run.config?.limitExecution !== false
        ? { maxTurns: run.config?.maxTurns, timeoutMs: run.config?.timeoutMs }
        : {}),
    },
    usage: usage && {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      sdkEstimateUsd: usage.sdkEstimateUsd,
      complete: usage.complete,
    },
    requestTiming: runRequestTimingSchema.safeParse(run.requestTiming).data,
    eventCount: history.eventCount,
    omittedEventCount: history.eventCount - history.events.length,
    events: history.events.map(eventDetails),
    tools: tools.map((tool) => ({
      id: label(tool.id),
      name: label(tool.name),
      status: tool.status,
      startedAt: tool.startedAt,
      endedAt: tool.endedAt,
    })),
  };
}

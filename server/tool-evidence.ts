/**
 * @file 提供无状态工具证据分类、来源指纹与恢复摘要投影辅助方法。
 * @implementation 将工具操作类型、结果判定、来源脱敏和检查点摘录从停滞观察器拆离，供运行观察与会话恢复共用。
 * @updated 2026-11-27T19:48:00+08:00
 */
import { createHash } from 'node:crypto';
import type { ToolCall } from '../shared/types.js';
import { redactSecrets } from './secret-redaction.js';

export type ProgressOperation = 'read' | 'search' | 'write' | 'wait' | 'unknown';
export type ProgressOutcome =
  'completed' | 'temporary_failure' | 'permanent_failure' | 'running' | 'uncertain' | 'canceled';
export type ProgressMode = 'observe' | 'feedback' | 'pause-branch';

/** Only supply semantics/version hints from verified execution metadata, never model guesses. */
export interface ProgressHints {
  operation?: ProgressOperation;
  targetKey?: string;
  preconditionVersion?: string;
  /** Verified response/conclusion version; disables heuristics based only on recurring URLs. */
  resultVersion?: string;
  taskId?: string;
  outcome?: ProgressOutcome;
  idempotent?: boolean;
}

export interface ProgressSource {
  /** Display locator omits credentials, query and fragment. Digest still distinguishes sources. */
  url: string;
  fingerprint: string;
}

export interface ProgressEvidence {
  runId: string;
  toolCallId: string;
  actorId: string;
  tool: string;
  startedAt: string | null;
  endedAt: string | null;
  outcome: ProgressOutcome;
  operation: ProgressOperation;
  output: { toolCallId: string; truncated: boolean };
  sources: ProgressSource[];
  taskId?: string;
}

export interface ProgressSignal {
  id: string;
  reason:
    | 'repeated_result'
    | 'repeated_failure'
    | 'repeated_uncertain'
    | 'recurring_source'
    | 'repeated_shell_output';
  /** Uncertain side effects and recurring discovery can never authorize pause or result reuse. */
  advisoryOnly: boolean;
  action: 'observe' | 'feedback' | 'pause';
  actorId: string;
  repeatCount: number;
  elapsedMs: number;
  evidence: ProgressEvidence[];
  /** Generated from metadata only; never contains input/output text. */
  message: string;
}

export interface ProgressObservation {
  evidence: ProgressEvidence;
  /** Advisory only. The observer never executes or schedules retries. */
  retry: 'safe' | 'wait' | 'verify' | 'none';
  sideEffect: 'none' | 'confirmed' | 'unverified';
  signal?: ProgressSignal;
}

export const MAX_TOOL_EVIDENCE_INPUT = 8_192;
export const MAX_TOOL_EVIDENCE_OUTPUT = 65_536;
const MAX_SOURCES = 16;

export function evidenceDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function checkpointUserExcerpt(value: string, maxChars = 768): string {
  const safe = redactSecrets(value, 'checkpoint');
  if (safe.length <= maxChars) return safe;
  const marker = '\n[…节选…]\n';
  const room = maxChars - marker.length;
  const first = Math.ceil(room / 2);
  return safe.slice(0, first) + marker + safe.slice(-(room - first));
}

export function checkpointReference(value: string): string {
  return /^[\w][\w.:/-]{0,127}$/.test(value) && redactSecrets(value, 'checkpoint') === value
    ? value
    : `ref:${evidenceDigest(value).slice(0, 24)}`;
}

function timestamp(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseBoundedJson(value: string, limit: number): unknown {
  if (value.length > limit) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function toolName(name: string): string {
  return name.startsWith('mcp__atelier__') ? name.slice('mcp__atelier__'.length) : name;
}

function operationOf(tool: ToolCall, hints: ProgressHints): ProgressOperation {
  if (hints.operation) return hints.operation;
  const name = toolName(tool.name);
  if (['WebSearch', 'Grep', 'Glob', 'web_search', 'search_files'].includes(name)) return 'search';
  if (['Read', 'WebFetch', 'read_file', 'list_files'].includes(name)) return 'read';
  if (
    [
      'Write',
      'Edit',
      'NotebookEdit',
      'write_file',
      'edit_file',
      'delete_file',
      'publish_artifact',
    ].includes(name)
  )
    return 'write';
  if (['TaskOutput', 'task_output'].includes(name)) return 'wait';
  return 'unknown';
}

function outcomeOf(
  tool: ToolCall,
  operation: ProgressOperation,
  hints: ProgressHints,
): ProgressOutcome {
  if (tool.status === 'running' || tool.status === 'awaiting_permission') return 'running';
  if (tool.status === 'denied') return 'permanent_failure';
  if (hints.outcome) return hints.outcome;
  if (tool.status === 'canceled')
    return operation === 'write' || operation === 'unknown' ? 'uncertain' : 'canceled';
  if (tool.status === 'succeeded') {
    const result = asRecord(parseBoundedJson(tool.output, MAX_TOOL_EVIDENCE_OUTPUT));
    if (
      (operation === 'wait' || hints.taskId || result?.task_id || result?.job_id) &&
      ['running', 'pending', 'in_progress', 'queued'].includes(String(result?.status))
    )
      return 'running';
    return 'completed';
  }
  // A failed process/transport does not prove that its writes did not happen.
  if ((operation === 'unknown' || operation === 'write') && hints.idempotent !== true)
    return 'uncertain';
  return /\b(?:ENOENT|EACCES|EPERM|not found|permission denied|invalid argument|HTTP\s*(?:400|401|403|404|422))\b/i.test(
    tool.output.slice(0, MAX_TOOL_EVIDENCE_OUTPUT),
  )
    ? 'permanent_failure'
    : 'temporary_failure';
}

export function boundedProgressHints(hints: ProgressHints): ProgressHints {
  return {
    ...(hints.operation ? { operation: hints.operation } : {}),
    ...(hints.outcome ? { outcome: hints.outcome } : {}),
    ...(hints.idempotent !== undefined ? { idempotent: hints.idempotent } : {}),
    ...(hints.targetKey !== undefined ? { targetKey: evidenceDigest(hints.targetKey) } : {}),
    ...(hints.preconditionVersion !== undefined
      ? { preconditionVersion: evidenceDigest(hints.preconditionVersion) }
      : {}),
    ...(hints.resultVersion !== undefined
      ? { resultVersion: evidenceDigest(hints.resultVersion) }
      : {}),
    ...(hints.taskId !== undefined ? { taskId: checkpointReference(hints.taskId) } : {}),
  };
}

function sourceOf(value: string): ProgressSource | undefined {
  if (value.length > 4_096) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    const fingerprint = evidenceDigest(url.href);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return { url: redactSecrets(url.href, 'checkpoint').slice(0, 512), fingerprint };
  } catch {
    return undefined;
  }
}

function discoveredSources(tool: ToolCall): ProgressSource[] {
  if (!['web_search', 'WebSearch'].includes(toolName(tool.name))) return [];
  const result = asRecord(parseBoundedJson(tool.output, MAX_TOOL_EVIDENCE_OUTPUT));
  if (!Array.isArray(result?.sources)) return [];
  const sources: ProgressSource[] = [];
  for (const candidate of result.sources.slice(0, 128)) {
    const raw = asRecord(candidate)?.url;
    const source = typeof raw === 'string' ? sourceOf(raw) : undefined;
    if (source) sources.push(source);
    if (sources.length === MAX_SOURCES) break;
  }
  return sources;
}

function sourcesOf(tool: ToolCall): ProgressSource[] {
  const structured = asRecord(parseBoundedJson(tool.output, MAX_TOOL_EVIDENCE_OUTPUT));
  if (Array.isArray(structured?.sources)) return discoveredSources(tool);
  const sources = new Map<string, ProgressSource>();
  // Output is never retained. Scan a bounded preview, including native SDK text wrappers.
  for (const match of tool.output
    .slice(0, MAX_TOOL_EVIDENCE_OUTPUT)
    .matchAll(/https?:\/\/[^\s<>"'\\)\]}]+/g)) {
    const source = sourceOf(match[0].replace(/[.,;]+$/, ''));
    if (source) sources.set(source.fingerprint, source);
    if (sources.size >= MAX_SOURCES) break;
  }
  return [...sources.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
}

/** Only a completed native fetch links its requested URL to a persisted receipt. */
function fetchedSource(tool: ToolCall): ProgressSource | undefined {
  if (tool.name !== 'WebFetch' || tool.status !== 'succeeded') return undefined;
  const input = asRecord(parseBoundedJson(tool.inputSummary, MAX_TOOL_EVIDENCE_INPUT));
  return typeof input?.url === 'string' ? sourceOf(input.url) : undefined;
}

export function observeToolEvidence(tool: ToolCall, hints: ProgressHints): ProgressObservation {
  const operation = operationOf(tool, hints);
  const outcome = outcomeOf(tool, operation, hints);
  const mutating = operation === 'write' || operation === 'unknown';
  return {
    evidence: {
      runId: checkpointReference(tool.runId),
      toolCallId: checkpointReference(tool.id),
      actorId: tool.subagentId ? checkpointReference(tool.subagentId) : 'main',
      tool: checkpointReference(tool.name),
      startedAt: timestamp(tool.startedAt),
      endedAt: timestamp(tool.endedAt),
      outcome,
      operation,
      output: {
        toolCallId: checkpointReference(tool.id),
        truncated: tool.outputTruncated === true,
      },
      sources: operation === 'search' || operation === 'read' ? sourcesOf(tool) : [],
      ...(hints.taskId ? { taskId: checkpointReference(hints.taskId) } : {}),
    },
    retry:
      outcome === 'running'
        ? 'wait'
        : outcome === 'uncertain'
          ? 'verify'
          : outcome === 'temporary_failure'
            ? !mutating || hints.idempotent === true
              ? 'safe'
              : 'verify'
            : 'none',
    sideEffect:
      !mutating || tool.status === 'denied'
        ? 'none'
        : operation === 'write' && outcome === 'completed'
          ? 'confirmed'
          : 'unverified',
  };
}

export function checkpointToolRecord(tool: ToolCall) {
  return {
    ...observeToolEvidence(tool, {}),
    discoveredSources: discoveredSources(tool),
    fetchedSource: fetchedSource(tool),
  };
}

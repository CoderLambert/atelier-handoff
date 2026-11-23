/**
 * @file 观察同一运行内各执行者的工具进展，并投影安全的恢复检查点。
 * @implementation 按执行者跟踪工具进展和反馈投递，通过前台 Bash 回执识别重复输出，并从持久记录投影恢复检查点。
 * @updated 2026-11-22T17:41:05+08:00
 */
import { createHash } from 'node:crypto';
import type { Message, Run, ToolCall } from '../shared/types.js';

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

export interface HarnessProgressOptions {
  mode?: ProgressMode;
  minRepeatCount?: number;
  minElapsedMs?: number;
  repeatsAfterFeedback?: number;
  maxHistory?: number;
  maxTargets?: number;
}

export interface ProgressSnapshot {
  mode: ProgressMode;
  mutationVersion: number;
  active: ProgressEvidence[];
  recent: ProgressObservation[];
  trackedTargets: number;
}

type RunIdentity = Pick<Run, 'id' | 'sessionId'>;
type Group = {
  count: number;
  firstAt: number;
  lastAt: number;
  samples: ProgressEvidence[];
  actors: Map<string, { id: string; count: number; feedbackCount?: number; paused: boolean }>;
};
type Pending = {
  evidence: ProgressEvidence;
  hints: ProgressHints;
  version: number;
  bashEpoch: number;
};

const MAX_INPUT = 8_192;
const MAX_OUTPUT = 65_536;
const MAX_SOURCES = 16;
const MAX_SAMPLES = 8;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value ?? fallback)))
    : fallback;
}

function redact(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[redacted key]',
    )
    .replace(/\b(?:sk-|sk_ant_|sk-ant-)[A-Za-z0-9_-]{8,}/g, '[redacted token]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted key]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '$1 [redacted]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|authorization)\s*["']?\s*[:=]\s*)["']?[^\s,"';<>]+["']?/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.href;
      } catch {
        return '[redacted URL]';
      }
    })
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function checkpointUserExcerpt(value: string, maxChars = 768): string {
  const safe = redact(value);
  if (safe.length <= maxChars) return safe;
  const marker = '\n[…节选…]\n';
  const room = maxChars - marker.length;
  const first = Math.ceil(room / 2);
  return safe.slice(0, first) + marker + safe.slice(-(room - first));
}

export function checkpointReference(value: string): string {
  return /^[\w][\w.:/-]{0,127}$/.test(value) && redact(value) === value
    ? value
    : `ref:${digest(value).slice(0, 24)}`;
}

function timestamp(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parse(value: string, limit: number): unknown {
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
    const result = object(parse(tool.output, MAX_OUTPUT));
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
    tool.output.slice(0, MAX_OUTPUT),
  )
    ? 'permanent_failure'
    : 'temporary_failure';
}

function boundedHints(hints: ProgressHints): ProgressHints {
  return {
    ...(hints.operation ? { operation: hints.operation } : {}),
    ...(hints.outcome ? { outcome: hints.outcome } : {}),
    ...(hints.idempotent !== undefined ? { idempotent: hints.idempotent } : {}),
    ...(hints.targetKey !== undefined ? { targetKey: digest(hints.targetKey) } : {}),
    ...(hints.preconditionVersion !== undefined
      ? { preconditionVersion: digest(hints.preconditionVersion) }
      : {}),
    ...(hints.resultVersion !== undefined ? { resultVersion: digest(hints.resultVersion) } : {}),
    ...(hints.taskId !== undefined ? { taskId: checkpointReference(hints.taskId) } : {}),
  };
}

function sourceOf(value: string): ProgressSource | undefined {
  if (value.length > 4_096) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    const fingerprint = digest(url.href);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return { url: redact(url.href).slice(0, 512), fingerprint };
  } catch {
    return undefined;
  }
}

function sourcesOf(tool: ToolCall): ProgressSource[] {
  const structured = object(parse(tool.output, MAX_OUTPUT));
  if (Array.isArray(structured?.sources)) return discoveredSources(tool);
  const sources = new Map<string, ProgressSource>();
  // Output is never retained. Scan a bounded preview, including native SDK text wrappers.
  for (const match of tool.output.slice(0, MAX_OUTPUT).matchAll(/https?:\/\/[^\s<>"'\\)\]}]+/g)) {
    const source = sourceOf(match[0].replace(/[.,;]+$/, ''));
    if (source) sources.set(source.fingerprint, source);
    if (sources.size >= MAX_SOURCES) break;
  }
  return [...sources.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
}

function discoveredSources(tool: ToolCall): ProgressSource[] {
  if (!['web_search', 'WebSearch'].includes(toolName(tool.name))) return [];
  const result = object(parse(tool.output, MAX_OUTPUT));
  if (!Array.isArray(result?.sources)) return [];
  const sources: ProgressSource[] = [];
  for (const candidate of result.sources.slice(0, 128)) {
    const raw = object(candidate)?.url;
    const source = typeof raw === 'string' ? sourceOf(raw) : undefined;
    if (source) sources.push(source);
    if (sources.length === MAX_SOURCES) break;
  }
  return sources;
}

/** Only a completed native fetch links its requested URL to a persisted receipt. */
function fetchedSource(tool: ToolCall): ProgressSource | undefined {
  if (tool.name !== 'WebFetch' || tool.status !== 'succeeded') return undefined;
  const input = object(parse(tool.inputSummary, MAX_INPUT));
  return typeof input?.url === 'string' ? sourceOf(input.url) : undefined;
}

export function checkpointToolRecord(tool: ToolCall) {
  return {
    ...observationOf(tool, {}),
    discoveredSources: discoveredSources(tool),
    fetchedSource: fetchedSource(tool),
  };
}

function observationOf(tool: ToolCall, hints: ProgressHints): ProgressObservation {
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

/** Bounded, sorted JSON; query echo is not evidence of a changed search result. */
function canonical(
  value: unknown,
  search: boolean,
  budget = { remaining: 2_048 },
  depth = 0,
): string {
  if (--budget.remaining < 0 || depth > 10) return '[incomplete]';
  if (Array.isArray(value)) {
    if (value.length > 128) return '[incomplete]';
    const items = value.map((item) => canonical(item, search, budget, depth + 1));
    if (search) items.sort();
    return `[${items.join(',')}]`;
  }
  const record = object(value);
  if (record && Object.keys(record).length > 128) return '[incomplete]';
  if (record)
    return `{${Object.keys(record)
      .sort()
      .slice(0, 128)
      .filter(
        (key) =>
          !search || !/^(?:q|query|search_query|searchQuery|search_terms|searchTerms)$/.test(key),
      )
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], search, budget, depth + 1)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** A match describes visible output only. It never classifies a command as read-only or idempotent. */
function foregroundBashFingerprint(tool: ToolCall, hints: ProgressHints): string | undefined {
  if (tool.outputTruncated || tool.output.length > MAX_OUTPUT || hints.taskId) return;
  const input = object(parse(tool.inputSummary, MAX_INPUT));
  if (
    !input ||
    typeof input.command !== 'string' ||
    !input.command.trim() ||
    input.run_in_background
  )
    return;
  const { description: _label, ...execution } = input;
  const args = canonical(execution, false);
  if (args.includes('[incomplete]')) return;
  const result = object(parse(tool.output, MAX_OUTPUT));
  if (
    result &&
    (typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string' ||
      result.interrupted !== false ||
      result.backgroundTaskId ||
      result.backgroundedByUser ||
      result.timedOutAfterMs ||
      result.isImage ||
      result.rawOutputPath ||
      result.persistedOutputPath ||
      result.persistedOutputSize ||
      result.noOutputExpected ||
      result.staleReadFileStateHint ||
      result.gitOperation ||
      result.structuredContent ||
      (!result.stdout.trim() && !result.stderr.trim()))
  )
    return;
  if (!tool.output.trim()) return;
  return digest(
    JSON.stringify([
      args,
      tool.output,
      hints.targetKey,
      hints.preconditionVersion,
      hints.resultVersion,
    ]),
  );
}

function comparison(
  tool: ToolCall,
  hints: ProgressHints,
  version: number,
  observation: ProgressObservation,
): string | undefined {
  const { operation, outcome } = observation.evidence;
  const uncertainFailure = outcome === 'uncertain' && tool.status === 'failed';
  if (
    outcome !== 'completed' &&
    outcome !== 'temporary_failure' &&
    outcome !== 'permanent_failure' &&
    !uncertainFailure
  )
    return undefined;
  if (
    operation === 'wait' ||
    (operation === 'unknown' && hints.idempotent !== true && !uncertainFailure)
  )
    return undefined;
  if (observation.sideEffect !== 'none' && hints.idempotent !== true && !uncertainFailure)
    return undefined;
  if (!hints.resultVersion && (tool.outputTruncated || tool.output.length > MAX_OUTPUT))
    return undefined;
  const input = object(parse(tool.inputSummary, MAX_INPUT));
  const search = operation === 'search';
  const target =
    hints.targetKey ??
    (search
      ? canonical(
          {
            tool: tool.name,
            domain: input?.domain,
            allowed_domains: input?.allowed_domains,
            blocked_domains: input?.blocked_domains,
            path: input?.path,
            glob: input?.glob,
          },
          false,
        )
      : `${tool.name}:${canonical(input ?? tool.inputSummary.slice(0, MAX_INPUT), false)}`);
  const parsed = parse(tool.output, MAX_OUTPUT);
  const result =
    hints.resultVersion ??
    (search && !object(parsed) && observation.evidence.sources.length
      ? canonical(
          observation.evidence.sources.map((source) => source.fingerprint),
          false,
        )
      : parsed === undefined
        ? tool.output
        : canonical(parsed, search));
  if (target.includes('[incomplete]') || result.includes('[incomplete]')) return undefined;
  return digest(
    `${digest(target)}:${digest(hints.preconditionVersion ?? `mutation:${version}`)}:${outcome}:${digest(result)}`,
  );
}

/**
 * One instance per Run, shared by all actors. Invoke started/finished after persisting ToolCall.
 * A feedback signal is an offer. Call takeFeedback when returning it in the SDK hook;
 * `pause` is merely a request to the host to stop that child, never the entire Run.
 */
export class HarnessProgress {
  readonly #run: RunIdentity;
  readonly #mode: ProgressMode;
  readonly #minRepeatCount: number;
  readonly #minElapsedMs: number;
  readonly #repeatsAfterFeedback: number;
  readonly #maxHistory: number;
  readonly #maxTargets: number;
  #version = 0;
  #recent: ProgressObservation[] = [];
  #seen = new Set<string>();
  #active = new Map<string, Pending>();
  #groups = new Map<string, Group>();
  #bashEpoch = 0;
  #bashSeries = new Map<string, { fingerprint: string; key: string; endedAt: number }>();
  #lastFeedbackAt = new Map<string, number>();

  constructor(run: RunIdentity, options: HarnessProgressOptions = {}) {
    this.#run = { id: run.id, sessionId: run.sessionId };
    this.#mode = options.mode ?? 'observe';
    this.#minRepeatCount = bounded(options.minRepeatCount, 6, 2, 1_000);
    this.#minElapsedMs = bounded(options.minElapsedMs, 60_000, 0, 86_400_000);
    this.#repeatsAfterFeedback = bounded(options.repeatsAfterFeedback, 3, 1, 1_000);
    this.#maxHistory = bounded(options.maxHistory, 64, 1, 512);
    this.#maxTargets = bounded(options.maxTargets, 128, 1, 512);
  }

  #owns(tool: ToolCall): boolean {
    return tool.runId === this.#run.id && tool.sessionId === this.#run.sessionId;
  }

  started(tool: ToolCall, hints: ProgressHints = {}): ProgressObservation | null {
    if (!this.#owns(tool) || this.#seen.has(tool.id)) return null;
    const semantics = boundedHints(hints);
    const observation = observationOf(
      { ...tool, status: 'running', output: '', endedAt: null },
      semantics,
    );
    if (!this.#active.has(tool.id)) {
      this.#active.set(tool.id, {
        evidence: observation.evidence,
        hints: semantics,
        version: this.#version,
        bashEpoch: this.#bashEpoch,
      });
      this.#trim(this.#active, this.#maxHistory);
    }
    return structuredClone(observation);
  }

  finished(tool: ToolCall, hints: ProgressHints = {}): ProgressObservation | null {
    if (!this.#owns(tool) || this.#seen.has(tool.id)) return null;
    if (tool.status === 'running' || tool.status === 'awaiting_permission')
      return this.started(tool, hints);
    const pending = this.#active.get(tool.id);
    const semantics = { ...pending?.hints, ...boundedHints(hints) };
    const observation = observationOf(tool, semantics);
    this.#active.delete(tool.id);
    this.#seen.add(tool.id);
    while (this.#seen.size > this.#maxHistory) {
      const first = this.#seen.values().next().value;
      if (first === undefined) break;
      this.#seen.delete(first);
    }
    const { actorId, operation, outcome } = observation.evidence;
    if (
      tool.name === 'Bash' &&
      operation === 'unknown' &&
      outcome === 'completed' &&
      semantics.idempotent !== true
    ) {
      const signature = foregroundBashFingerprint(tool, semantics);
      const start = Date.parse(tool.startedAt);
      const end = Date.parse(tool.endedAt ?? '');
      if (
        signature &&
        Number.isFinite(start) &&
        end >= start &&
        (!pending || pending.bashEpoch === this.#bashEpoch)
      ) {
        let series = this.#bashSeries.get(actorId);
        if (series?.fingerprint !== signature || series.endedAt > start) {
          series = { fingerprint: signature, key: `bash:${digest(tool.id)}`, endedAt: end };
        } else {
          series.endedAt = end;
        }
        this.#bashSeries.delete(actorId);
        this.#bashSeries.set(actorId, series);
        this.#trim(this.#bashSeries, this.#maxTargets);
        observation.signal = this.#track(series.key, observation, 'repeated_shell_output');
      } else {
        // A non-comparable receipt can represent a write, interruption or outstanding work.
        this.#bashEpoch++;
        this.#bashSeries.clear();
      }
    } else if (operation === 'write' || operation === 'unknown') {
      // An intervening edit or a call with uncertain effects breaks previous shell comparisons.
      this.#bashEpoch++;
      this.#bashSeries.clear();
    }
    const key = comparison(tool, semantics, pending?.version ?? this.#version, observation);
    if (key)
      observation.signal = this.#track(
        key,
        observation,
        undefined,
        tool.status === 'denied' || semantics.outcome === 'permanent_failure',
      );
    if (
      !observation.signal &&
      observation.evidence.operation === 'search' &&
      observation.evidence.outcome === 'completed' &&
      !semantics.resultVersion &&
      !tool.outputTruncated &&
      tool.output.length <= MAX_OUTPUT
    ) {
      // Discovery belongs to the source, even when actors alternate query domains.
      // An explicit target can still separate unrelated investigations in the same Run.
      const scope = semantics.targetKey ?? 'run-search';
      const coreSources = new Set<string>();
      for (const source of observation.evidence.sources) {
        if (coreSources.has(source.url)) continue;
        coreSources.add(source.url);
        const sourceKey = digest(
          `source:${scope}:${semantics.preconditionVersion ?? `mutation:${pending?.version ?? this.#version}`}:${digest(source.url)}`,
        );
        const signal = this.#track(sourceKey, observation, 'recurring_source');
        if (signal) {
          observation.signal = signal;
          break;
        }
      }
    }
    // Successful arbitrary tools may have changed state too. Invalidate implicit freshness.
    if (
      observation.evidence.outcome === 'completed' &&
      ['write', 'unknown'].includes(observation.evidence.operation)
    )
      this.#version++;
    this.#recent.push(observation);
    if (this.#recent.length > this.#maxHistory) this.#recent.shift();
    return structuredClone(observation);
  }

  #track(
    key: string,
    observation: ProgressObservation,
    reasonOverride?: 'recurring_source' | 'repeated_shell_output',
    provenPermanent = false,
  ): ProgressSignal | undefined {
    const evidence = observation.evidence;
    const at = Date.parse(evidence.endedAt ?? evidence.startedAt ?? '');
    if (!Number.isFinite(at)) return undefined;
    const startedAt = Date.parse(evidence.startedAt ?? '');
    const firstAt = Number.isFinite(startedAt) ? startedAt : at;
    let group = this.#groups.get(key);
    if (!group) {
      group = {
        count: 0,
        firstAt,
        lastAt: at,
        samples: [],
        actors: new Map(),
      };
    }
    // LRU eviction bounds memory even when targets, actors or outputs keep changing.
    this.#groups.delete(key);
    this.#groups.set(key, group);
    this.#trim(this.#groups, this.#maxTargets);
    group.count++;
    group.firstAt = Math.min(group.firstAt, firstAt);
    group.lastAt = Math.max(group.lastAt, at);
    group.samples.push(evidence);
    if (group.samples.length > MAX_SAMPLES) group.samples.shift();
    const actor = group.actors.get(evidence.actorId) ?? {
      // Include the first tool call so a late hook cannot acknowledge a re-created LRU entry.
      id: `progress:${digest(JSON.stringify([key, evidence.actorId, evidence.toolCallId])).slice(0, 32)}`,
      count: 0,
      paused: false,
    };
    actor.count++;
    group.actors.delete(evidence.actorId);
    group.actors.set(evidence.actorId, actor);
    this.#trim(group.actors, MAX_SAMPLES);
    const elapsedMs = Math.max(0, group.lastAt - group.firstAt);
    if (group.count < this.#minRepeatCount || elapsedMs < this.#minElapsedMs) return undefined;
    const failure = evidence.outcome !== 'completed';
    const reason =
      reasonOverride ??
      (evidence.outcome === 'uncertain'
        ? 'repeated_uncertain'
        : failure
          ? 'repeated_failure'
          : 'repeated_result');
    const advisoryOnly =
      reason === 'recurring_source' ||
      reason === 'repeated_shell_output' ||
      reason === 'repeated_uncertain' ||
      observation.sideEffect === 'unverified' ||
      (evidence.outcome === 'permanent_failure' && !provenPermanent);
    let action: ProgressSignal['action'] = 'observe';
    if (this.#mode !== 'observe' && actor.feedbackCount === undefined) {
      action = 'feedback';
    } else if (
      this.#mode === 'pause-branch' &&
      !advisoryOnly &&
      evidence.outcome === 'permanent_failure' &&
      evidence.actorId !== 'main' &&
      actor.feedbackCount !== undefined &&
      !actor.paused &&
      actor.count - actor.feedbackCount >= this.#repeatsAfterFeedback
    ) {
      action = 'pause';
      actor.paused = true;
    }
    return {
      id: actor.id,
      reason,
      advisoryOnly,
      action,
      actorId: evidence.actorId,
      repeatCount: group.count,
      elapsedMs,
      evidence: group.samples.slice(),
      message: `${
        reason === 'repeated_shell_output'
          ? '当前分支多次运行相同 Bash 命令，返回的输出相同。若在等待作业，可按其进度继续等待；否则可核对当前状态或使用已有结果。'
          : reason === 'recurring_source'
            ? '同一来源反复被发现，搜索回执尚未证明已核实其中内容；若已有独立的新结论可继续验证。'
            : reason === 'repeated_uncertain'
              ? '相同不透明调用持续失败，副作用仍待核对；先查询真实状态，不自动重试或暂停分支。'
              : `同一目标、前置状态和${failure ? '失败' : '结果'}重复。`
      }累计 ${group.count} 次（${elapsedMs} ms）。证据工具：${group.samples.map((sample) => sample.toolCallId).join(', ')}。请根据已有证据提出新的可验证假设、改用其他方法，或等待具体事件。`,
    };
  }

  /** Claim an offer while constructing this actor's SDK hook reply. A cooled offer remains eligible on the next matching result. */
  takeFeedback(offer: ProgressSignal, nowMs = performance.now()): boolean {
    if (this.#mode === 'observe' || offer.action !== 'feedback') return false;
    const last = this.#lastFeedbackAt.get(offer.actorId);
    if (last !== undefined && nowMs - last < 90_000) return false;
    for (const group of this.#groups.values()) {
      const actor = group.actors.get(offer.actorId);
      if (actor?.id !== offer.id) continue;
      if (actor.feedbackCount !== undefined) return false;
      actor.feedbackCount = actor.count;
      this.#lastFeedbackAt.delete(offer.actorId);
      this.#lastFeedbackAt.set(offer.actorId, nowMs);
      this.#trim(this.#lastFeedbackAt, this.#maxTargets);
      return true;
    }
    return false;
  }

  #trim<T>(map: Map<string, T>, limit: number): void {
    while (map.size > limit) {
      const first = map.keys().next().value;
      if (first === undefined) break;
      map.delete(first);
    }
  }

  snapshot(): ProgressSnapshot {
    return structuredClone({
      mode: this.#mode,
      mutationVersion: this.#version,
      active: [...this.#active.values()].map((entry) => entry.evidence),
      recent: this.#recent,
      trackedTargets: this.#groups.size,
    });
  }

  clear(): void {
    this.#recent = [];
    this.#seen.clear();
    this.#active.clear();
    this.#groups.clear();
    this.#bashSeries.clear();
    this.#lastFeedbackAt.clear();
    this.#bashEpoch = 0;
    this.#version = 0;
  }
}

export interface HarnessCheckpointOptions {
  /** Serialized JSON character limit, clamped to 2,048–32,768. */
  maxChars?: number;
  maxItems?: number;
  maxTextChars?: number;
  /** Host can remove additional local secrets before the built-in scrubber runs. */
  redactText?: (text: string) => string;
}

export interface HarnessCheckpoint {
  schemaVersion: 1;
  run: { id: string; sessionId: string; status: Run['status']; retryOf: string | null };
  goal: { text: string; messageId: string | null; updatedAt: string | null };
  plan: { content: string; status: Run['plan'][number]['status'] }[];
  /** Confirms tool completion only; result content must be retrieved and verified by evidence ID. */
  facts: { evidence: ProgressEvidence; needsRevalidation: boolean }[];
  discoveredSources: {
    source: ProgressSource;
    toolCallId: string;
    actorId: string;
    status: 'discovered_only';
    needsRevalidation: true;
  }[];
  sideEffects: { evidence: ProgressEvidence; state: 'confirmed' | 'unverified' }[];
  unresolved: ProgressEvidence[];
  omitted: {
    facts: number;
    discoveredSources: number;
    sideEffects: number;
    unresolved: number;
    plan: number;
  };
  truncated: boolean;
}

/**
 * Pure projection of persisted records, without DB/network access or assistant/output injection.
 * Latest user message supersedes the original goal. Prior facts are marked for revalidation.
 * Active writes/unknown tools remain unverified, including after interruption or retry.
 */
export function buildHarnessCheckpoint(
  run: Pick<Run, 'id' | 'sessionId' | 'status' | 'retryOf' | 'prompt' | 'createdAt' | 'plan'>,
  messages: readonly Message[],
  tools: readonly ToolCall[],
  options: HarnessCheckpointOptions = {},
): HarnessCheckpoint {
  const maxChars = bounded(options.maxChars, 12_000, 2_048, 32_768);
  const maxItems = bounded(options.maxItems, 16, 1, 64);
  const maxTextChars = bounded(options.maxTextChars, 1_200, 64, 4_096);
  let truncated = false;
  const text = (raw: string) => {
    // Scrub before truncation so a cut cannot expose part of a recognized credential.
    const cleaned = redact(options.redactText?.(raw) ?? raw);
    if (cleaned.length > maxTextChars) truncated = true;
    return cleaned.slice(0, maxTextChars);
  };
  let latest: Message | undefined;
  for (const message of messages) {
    if (message.runId !== run.id || message.sessionId !== run.sessionId || message.role !== 'user')
      continue;
    if (!latest || (Date.parse(message.createdAt) || 0) >= (Date.parse(latest.createdAt) || 0))
      latest = message;
  }
  const goalAt = timestamp(latest?.createdAt ?? run.createdAt);
  const checkpoint: HarnessCheckpoint = {
    schemaVersion: 1,
    run: {
      id: checkpointReference(run.id),
      sessionId: checkpointReference(run.sessionId),
      status: run.status,
      retryOf: run.retryOf ? checkpointReference(run.retryOf) : null,
    },
    goal: {
      text: text(latest?.text ?? run.prompt),
      messageId: latest ? checkpointReference(latest.id) : null,
      updatedAt: goalAt,
    },
    plan: [],
    facts: [],
    discoveredSources: [],
    sideEffects: [],
    unresolved: [],
    omitted: { facts: 0, discoveredSources: 0, sideEffects: 0, unresolved: 0, plan: 0 },
    truncated: false,
  };
  for (const step of run.plan) {
    if (checkpoint.plan.length < maxItems)
      checkpoint.plan.push({ content: text(step.content), status: step.status });
    else checkpoint.omitted.plan++;
  }
  const retain = <T>(
    items: T[],
    item: T,
    kind: keyof HarnessCheckpoint['omitted'],
    at: (entry: T) => string | null,
  ) => {
    // Keep the most recent items with bounded auxiliary memory regardless of input ordering.
    const time = Date.parse(at(item) ?? '') || 0;
    const index = items.findIndex((entry) => (Date.parse(at(entry) ?? '') || 0) > time);
    items.splice(index < 0 ? items.length : index, 0, item);
    if (items.length > maxItems) {
      items.shift();
      checkpoint.omitted[kind]++;
    }
  };
  for (const tool of tools) {
    if (tool.runId !== run.id || tool.sessionId !== run.sessionId) continue;
    const observation = checkpointToolRecord(tool);
    const evidence = observation.evidence;
    // Keep first-discovered distinct sources: later empty searches must not erase an early URL.
    for (const source of observation.discoveredSources) {
      if (checkpoint.discoveredSources.some((entry) => entry.source.url === source.url)) continue;
      if (checkpoint.discoveredSources.length < maxItems)
        checkpoint.discoveredSources.push({
          source,
          toolCallId: evidence.toolCallId,
          actorId: evidence.actorId,
          status: 'discovered_only',
          needsRevalidation: true,
        });
      else checkpoint.omitted.discoveredSources++;
    }
    if (observation.sideEffect !== 'none')
      retain(
        checkpoint.sideEffects,
        { evidence, state: observation.sideEffect },
        'sideEffects',
        (entry) => entry.evidence.startedAt,
      );
    if (evidence.outcome === 'completed' && observation.sideEffect === 'none')
      retain(
        checkpoint.facts,
        {
          evidence,
          needsRevalidation:
            goalAt !== null && (Date.parse(evidence.startedAt ?? '') || 0) < Date.parse(goalAt),
        },
        'facts',
        (entry) => entry.evidence.startedAt,
      );
    if (evidence.outcome !== 'completed')
      retain(checkpoint.unresolved, evidence, 'unresolved', (entry) => entry.startedAt);
  }
  checkpoint.truncated = truncated || Object.values(checkpoint.omitted).some((count) => count > 0);
  // Preserve unknown side effects longest when fitting the final context budget.
  while (JSON.stringify(checkpoint).length > maxChars) {
    checkpoint.truncated = true;
    if (checkpoint.facts.length) {
      checkpoint.facts.shift();
      checkpoint.omitted.facts++;
    } else if (checkpoint.plan.length) {
      checkpoint.plan.pop();
      checkpoint.omitted.plan++;
    } else if (checkpoint.unresolved.length) {
      checkpoint.unresolved.shift();
      checkpoint.omitted.unresolved++;
    } else if (checkpoint.discoveredSources.length) {
      checkpoint.discoveredSources.pop();
      checkpoint.omitted.discoveredSources++;
    } else if (checkpoint.sideEffects.length) {
      checkpoint.sideEffects.shift();
      checkpoint.omitted.sideEffects++;
    } else {
      checkpoint.goal.text = checkpoint.goal.text.slice(
        0,
        Math.floor(checkpoint.goal.text.length / 2),
      );
    }
  }
  return checkpoint;
}

/** Pass as context data, not as a system instruction or authority to repeat side effects. */
export function renderHarnessCheckpoint(checkpoint: HarnessCheckpoint): string {
  return `恢复检查点（历史资料；以最新用户目标为准。工具成功只证明调用完成，按证据 ID 取回必要结果。先核对未确认副作用，勿自动重放；较早事实需重新验证。）\n${JSON.stringify(checkpoint)}`;
}

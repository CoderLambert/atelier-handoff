/**
 * @file 观察同一运行内各执行者的工具进展与停滞信号。
 * @implementation 复用无状态 tool-evidence 投影按执行者跟踪重复结果、重复失败与前台 Bash 重复输出，并维护反馈投递冷却。
 * @updated 2026-11-27T19:48:00+08:00
 */
import type { Run, ToolCall } from '../shared/types.js';
import {
  asRecord,
  boundedProgressHints,
  checkpointReference,
  checkpointToolRecord,
  checkpointUserExcerpt,
  evidenceDigest,
  MAX_TOOL_EVIDENCE_INPUT,
  MAX_TOOL_EVIDENCE_OUTPUT,
  observeToolEvidence,
  parseBoundedJson,
  type ProgressEvidence,
  type ProgressHints,
  type ProgressMode,
  type ProgressObservation,
  type ProgressOperation,
  type ProgressOutcome,
  type ProgressSignal,
  type ProgressSource,
} from './tool-evidence.js';

export {
  checkpointReference,
  checkpointToolRecord,
  checkpointUserExcerpt,
  type ProgressEvidence,
  type ProgressHints,
  type ProgressMode,
  type ProgressObservation,
  type ProgressOperation,
  type ProgressOutcome,
  type ProgressSignal,
  type ProgressSource,
};

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

const MAX_INPUT = MAX_TOOL_EVIDENCE_INPUT;
const MAX_OUTPUT = MAX_TOOL_EVIDENCE_OUTPUT;
const MAX_SAMPLES = 8;
const digest = evidenceDigest;
const object = asRecord;
const parse = parseBoundedJson;
const boundedHints = boundedProgressHints;
const observationOf = observeToolEvidence;

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value ?? fallback)))
    : fallback;
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

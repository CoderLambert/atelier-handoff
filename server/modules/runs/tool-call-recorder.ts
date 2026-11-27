/**
 * @file 记录智能体工具调用生命周期、输出截断与 Bash 日志捕获。
 * @implementation 统一创建与结束工具记录，更新进度/停滞信号、请求计时与 Skill 调用事件，并安全落盘大输出和 Bash 日志。
 * @updated 2026-11-27T12:52:00-06:00
 */
import { now, type Run, type ToolCall } from '../../../shared/types.js';
import type { FileRecords } from '../../artifacts.js';
import type { HarnessProgress, ProgressSignal } from '../../harness-progress.js';
import type { BashTaskReceipt, NativeBashTasks } from '../../native-bash.js';
import type { RequestTiming } from '../../request-timing.js';
import type { RunSkill } from '../../run-skills.js';
import type { Store } from '../../store.js';
import type { SubagentRun } from '../../subagent-run.js';
import type { LiveTurnCoordinator } from './live-turn-coordinator.js';
import type { RunTranscriptLedger } from './run-transcript-ledger.js';
import type { SdkTaskCoordinator } from './sdk-task-coordinator.js';

export interface ToolCallRecorderDeps {
  run: Run;
  sessionId: string;
  sdkDirectory: string;
  sdkSessionId: string;
  signal: AbortSignal;
  store: Store;
  files: FileRecords;
  ledger: RunTranscriptLedger;
  tasks: SdkTaskCoordinator;
  progress: HarnessProgress;
  progressMode: 'observe' | 'feedback' | 'pause-branch';
  requestTiming: RequestTiming;
  subagents: SubagentRun;
  turn: LiveTurnCoordinator;
  bash?: NativeBashTasks;
  skillCalls: Map<string, RunSkill>;
  reconcile: Set<string>;
  notices: Map<string, ProgressSignal>;
  toolWork: Map<Promise<unknown>, string | undefined>;
  getStopSubagent: () => ((id: string) => Promise<void>) | undefined;
  cleanError: (error: unknown, maxChars?: number) => string;
}

export function createToolCallRecorder(deps: ToolCallRecorderDeps) {
  const {
    run,
    sessionId,
    sdkDirectory,
    sdkSessionId,
    signal,
    store,
    files,
    ledger,
    tasks,
    progress,
    progressMode,
    requestTiming,
    subagents,
    turn,
    bash,
    skillCalls,
    reconcile,
    notices,
    toolWork,
    getStopSubagent,
    cleanError,
  } = deps;

  const pagedOutputIds = new Set<string>();
  const capturing = new Set<string>();

  const appToolId = (id: string, agentId?: string) =>
    agentId ? `${run.id}:${agentId}:${id}` : `${run.id}:${id}`;

  const createTool = (
    id: string,
    name: string,
    args: unknown,
    subagentId?: string,
    useId?: string,
    sdkActorId?: string,
  ) => {
    if (ledger.hasSeenTool(id)) return store.get('tools', id);
    ledger.flush();
    const input = JSON.stringify(args);
    const command =
      (name === 'Bash' || name === 'mcp__atelier__run_command') &&
      input.length > 4000 &&
      typeof args === 'object' &&
      args !== null &&
      'command' in args &&
      typeof args.command === 'string'
        ? args.command
        : undefined;
    const topLevel = !subagentId && !sdkActorId;
    const value = ledger.createTool(id, topLevel, (orders) => ({
      id,
      runId: run.id,
      sessionId: run.sessionId,
      name,
      ...(subagentId ? { subagentId } : {}),
      ...orders,
      inputSummary: input.slice(0, 4000),
      ...(command === undefined ? {} : { command }),
      ...(name === 'Bash' &&
        useId &&
        bash && {
          bashExecution: bash.register(id, useId, subagentId, sdkActorId),
        }),
      status: 'running',
      output: '',
      startedAt: now(),
      endedAt: null,
    }));
    tasks.trackTool(id, { useId, subagentId });
    progress.started(value);
    store.event(run.id, run.sessionId, 'tool.started', { toolCallId: id });
    return value;
  };

  const finishTool = (
    id: string,
    ok: boolean | 'stopped' | 'unknown',
    output: string,
    bashLog?: ToolCall['bashLog'],
  ) => {
    let prior: ToolCall;
    try {
      prior = store.get('tools', id);
    } catch {
      return;
    }
    const status = ['denied', 'canceled'].includes(prior.status)
      ? prior.status
      : ok === 'stopped' || ok === 'unknown'
        ? 'canceled'
        : ok
          ? 'succeeded'
          : 'failed';
    if (prior.status !== 'running' && prior.status !== 'awaiting_permission' && prior.endedAt)
      return;
    bash?.complete(id);
    tasks.untrackTool(id);
    if (!prior.subagentId) turn.onToolBoundary();
    const skill = skillCalls.get(id);
    if (skill) output = ok ? `已加载 /${skill.name} · v${skill.version}` : 'Skill 加载失败';
    if (output.length > 32000) files.saveOutput(id, output);
    const finished = store.update('tools', id, {
      status,
      output:
        output.slice(0, 32000) +
        (output.length > 32000 ? '\n[预览已截断，可查看或下载完整工具输出]' : ''),
      outputLength: output.length,
      outputTruncated: output.length > 32000,
      ...(bashLog ? { bashLog } : {}),
      ...(prior.bashExecution && {
        bashExecution: {
          ...prior.bashExecution,
          phase: ok === 'unknown' || ok === 'stopped' ? ok : prior.bashExecution.phase,
          controllable: false,
          lastObservedAt: now(),
        },
      }),
      endedAt: now(),
    });
    const observed = progress.finished(finished);
    if (progressMode !== 'observe' && observed?.retry === 'verify') {
      if (reconcile.size >= 64) reconcile.delete(reconcile.values().next().value ?? '');
      reconcile.add(id);
      store.event(run.id, sessionId, 'harness.progress', {
        kind: 'uncertain',
        summary: `${prior.name} 的副作用待核对，可通过工具结果与目标状态确认。`,
        toolCallId: id,
      });
    }
    const notice = observed?.signal;
    if (notice) {
      store.event(run.id, run.sessionId, 'harness.progress', {
        kind: notice.action === 'feedback' ? 'feedback_pending' : notice.action,
        summary:
          notice.action === 'feedback' ? `待投递停滞提示。${notice.message}` : notice.message,
        signalId: notice.id,
        toolCallId: id,
        actorId: notice.actorId,
        repeatCount: notice.repeatCount,
        elapsedMs: notice.elapsedMs,
      });
      if (notice.action === 'feedback') {
        if (notices.size >= 64) notices.delete(notices.keys().next().value ?? '');
        notices.set(id, notice);
      } else {
        const stop = getStopSubagent();
        if (notice.action === 'pause' && finished.subagentId && stop) {
          const branch = finished.subagentId;
          setImmediate(() => {
            if (!turn.isClosing && !signal.aborted) void stop(branch).catch(() => undefined);
          });
        }
      }
    }
    if (!prior.subagentId && finished.endedAt && !turn.isClosing)
      requestTiming.finishedMainTool(Date.parse(finished.endedAt));
    store.event(run.id, run.sessionId, 'tool.finished', { toolCallId: id, status });
    if (skill && status === 'succeeded') {
      const { id: extensionId, name, version, source } = skill;
      store.event(run.id, run.sessionId, 'skill.invoked', {
        extensionId,
        name,
        version,
        ...(source ? { source } : {}),
      });
    }
    return finished;
  };

  const finishWithBashLog = async (
    id: string,
    useId: string,
    response: unknown,
    raw: string,
    hookSession: string,
    outcome: true | 'stopped',
  ) => {
    if (!ledger.hasSeenTool(id) || capturing.has(id) || turn.isClosing) return;
    const call = store.get('tools', id);
    if (call.name !== 'Bash' || call.endedAt) return;
    capturing.add(id);
    const branchSignal = call.subagentId ? subagents.branchSignal(call.subagentId) : undefined;
    const sdkActorId = call.subagentId ? subagents.taskId(call.subagentId) : undefined;
    const scope = branchSignal ? AbortSignal.any([signal, branchSignal]) : signal;
    const work =
      hookSession === sdkSessionId
        ? files.captureBashLog(id, sdkDirectory, sdkSessionId, useId, response, scope, sdkActorId)
        : Promise.resolve<ToolCall['bashLog']>({ status: 'unavailable' });
    toolWork.set(work, call.subagentId);
    let captured: ToolCall['bashLog'];
    let committed = false;
    try {
      captured = await work;
      toolWork.delete(work);
      if (scope.aborted || turn.isClosing) return;
      const saved = finishTool(id, outcome, raw, captured);
      committed = !!saved;
      return saved;
    } finally {
      toolWork.delete(work);
      capturing.delete(id);
      if (!committed && (captured?.status === 'complete' || captured?.status === 'partial'))
        await files.discardBashLog(id);
      turn.sendInsertion();
    }
  };

  const finishBashTask = async (task: BashTaskReceipt, sdkTemp?: string) => {
    const { id, useId, sdkActorId, receipt } = task;
    const captured =
      sdkTemp && receipt.output_file && !signal.aborted
        ? await files
            .captureBashLog(id, sdkDirectory, sdkSessionId, useId, undefined, signal, sdkActorId, {
              scratch: sdkTemp,
              id: receipt.task_id,
              outputFile: receipt.output_file,
            })
            .catch((): ToolCall['bashLog'] => ({ status: 'unavailable' }))
        : undefined;
    const outcome =
      receipt.reason === 'worker_restart'
        ? 'unknown'
        : receipt.status === 'stopped'
          ? 'stopped'
          : task.failure === undefined && receipt.status === 'completed';
    finishTool(
      id,
      outcome,
      outcome === 'unknown'
        ? ''
        : cleanError((outcome === false ? task.failure : undefined) ?? receipt.summary, Infinity),
      captured,
    );
    turn.sendInsertion();
  };

  return {
    appToolId,
    createTool,
    finishTool,
    finishWithBashLog,
    finishBashTask,
    pagedOutputIds,
    capturing,
  };
}

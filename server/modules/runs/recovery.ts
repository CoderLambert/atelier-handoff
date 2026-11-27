/**
 * @file 在服务重启时收尾被中断的运行状态，并为运行结束复用未完成工具的终结。
 * @implementation 单个事务内中断子任务、恢复待处理消息投递、提升保存的转录顺序、取消未结束工具与审批并终结活动运行，查询均走状态索引。
 * @updated 2026-11-27T20:10:00+08:00
 */
import { finalizeRunTranscript } from '../../../shared/ordered-transcript.js';
import { now, type ToolCall } from '../../../shared/types.js';
import type { Store } from '../../store.js';

type RecoveryStore = Pick<Store, 'transaction' | 'update' | 'event' | 'repos'>;
type ToolFinalizationStore = Pick<Store, 'update' | 'event' | 'repos'>;

const interruptedReason =
  '服务已重启，之前的运行中断。已发生的文件修改不会自动撤销，请先检查记录。';

/** Closes tools of one run that never reached a terminal state; Bash tools may be delegated. */
export function finalizeUnfinishedRunTools(
  store: ToolFinalizationStore,
  runId: string,
  options: {
    onBashTool?: (tool: ToolCall) => void;
    output?: string;
    emitFinishedEvent?: boolean;
  } = {},
): void {
  for (const tool of store.repos.tools.listActiveByRun(runId)) {
    if (tool.bashExecution && options.onBashTool) {
      options.onBashTool(tool);
      continue;
    }
    store.update('tools', tool.id, {
      status: 'canceled',
      endedAt: now(),
      ...(options.output !== undefined ? { output: options.output } : {}),
    });
    if (options.emitFinishedEvent)
      store.event(tool.runId, tool.sessionId, 'tool.finished', {
        toolCallId: tool.id,
        status: 'canceled',
      });
  }
}

export function recoverInterruptedRuntime(store: RecoveryStore): void {
  const { repos } = store;
  store.transaction(() => {
    for (const subagent of repos.subagents.interruptRunning(now()))
      store.event(subagent.runId, subagent.sessionId, 'subagent.finished', { subagent });
    repos.messageQueue.recoverInterrupted();
    const activeRuns = repos.runs.listActive();
    const orderedInterruptions = new Set(
      activeRuns.filter((run) => run.transcript).map(({ id }) => id),
    );
    for (const runId of orderedInterruptions)
      for (const tool of repos.tools.listByRun(runId))
        if (tool.transcriptOrder === undefined && tool.transcriptHookOrder !== undefined)
          store.update('tools', tool.id, {
            transcriptOrder: tool.transcriptHookOrder,
            transcriptHookOrder: undefined,
          });
    for (const tool of repos.tools.listActive()) {
      const interruptedBash = tool.bashExecution && tool.status === 'running';
      if (tool.endedAt || (!interruptedBash && !orderedInterruptions.has(tool.runId))) continue;
      store.update('tools', tool.id, {
        status: 'canceled',
        endedAt: now(),
        ...(tool.bashExecution && {
          bashExecution: { ...tool.bashExecution, phase: 'unknown', controllable: false },
        }),
      });
      store.event(tool.runId, tool.sessionId, 'tool.finished', {
        toolCallId: tool.id,
        status: 'canceled',
      });
    }
    for (const run of activeRuns) {
      store.update('runs', run.id, {
        ...(run.transcript && { transcript: finalizeRunTranscript(run.transcript) }),
        status: 'interrupted',
        endedAt: now(),
        reason: interruptedReason,
      });
      store.update('sessions', run.sessionId, { sdkConfigKey: undefined });
      for (const permission of repos.permissions.listPendingByRun(run.id))
        store.update('permissions', permission.id, {
          status: 'canceled',
          resolutionReason: '运行已中断，旧审批无效。',
        });
      finalizeUnfinishedRunTools(store, run.id, {
        output: '运行已中断，请检查此操作是否已产生结果。',
      });
      store.event(run.id, run.sessionId, 'run.finished', { status: 'interrupted' });
    }
  });
}

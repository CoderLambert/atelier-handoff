/**
 * @file 校验并执行运行、Bash 及子任务控制。
 * @implementation 核对工具和子任务归属，保留幂等停止及原有只读续接输入。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { BashControl } from '../../../shared/bash-execution.js';
import { AppError, activeStatuses, type Run } from '../../../shared/types.js';
import type { Runner } from '../../agent.js';
import type { Store } from '../../store.js';
import type { StartRun } from './create-run.js';

export function createRunControls({
  store,
  runner,
  nativeExecution,
  createRun,
}: {
  store: Pick<Store, 'get' | 'sessionSnapshots'>;
  runner: Pick<Runner, 'stop' | 'controlBash' | 'stopSubagent'>;
  nativeExecution: boolean;
  createRun: StartRun;
}) {
  return {
    stop(run: Run) {
      if (activeStatuses.includes(run.status)) runner.stop(run.id);
      return store.get('runs', run.id);
    },
    async controlBash(run: Run, toolId: string, action: BashControl['action']) {
      const tool = store.get('tools', toolId);
      if (tool.name !== 'Bash' || tool.runId !== run.id || tool.sessionId !== run.sessionId)
        throw new AppError('NOT_FOUND', '命令不属于当前运行。', 404);
      if (tool.endedAt) return;
      if (
        !nativeExecution ||
        run.executor !== 'native-v1' ||
        !tool.bashExecution ||
        !['running', 'awaiting_permission'].includes(run.status) ||
        !runner.controlBash
      )
        throw new AppError('BASH_CONTROL_UNAVAILABLE', '当前命令无法接受控制请求。', 409);
      await runner.controlBash(run.id, toolId, action);
    },
    async stopSubagent(run: Run, subagentId: string) {
      const subagent = store.sessionSnapshots
        .read(run.sessionId)
        .subagents.find(
          (item) =>
            item.id === subagentId && item.runId === run.id && item.sessionId === run.sessionId,
        );
      if (!subagent) throw new AppError('NOT_FOUND', '子任务不属于当前运行。', 404);
      if (subagent.status !== 'running') return;
      if (!activeStatuses.includes(run.status))
        throw new AppError('RUN_NOT_ACTIVE', '所属运行已结束，请刷新执行轨迹。', 409);
      if (!runner.stopSubagent)
        throw new AppError('SUBAGENT_STOP_UNAVAILABLE', '当前运行不支持单独停止子任务。', 409);
      await runner.stopSubagent(run.id, subagentId);
    },
    retry(run: Run, idempotencyKey: string) {
      return createRun(
        run.sessionId,
        {
          text: `请以只读方式续接上次任务。根据已有信息直接交付原任务要求的结果，保留已经完成的部分。只使用必要的读取工具，禁止重放写入或命令。\n\n原任务：${run.prompt}`,
          mode: 'readonly',
          contextPaths: [],
          attachmentIds: [],
          idempotencyKey,
        },
        run.id,
      );
    },
  };
}

export type RunControls = ReturnType<typeof createRunControls>;

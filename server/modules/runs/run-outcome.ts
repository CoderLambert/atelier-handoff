/**
 * @file 判定运行完成、失败、停止和中断的优先级。
 * @implementation 将进程清理、取消原因、SDK 回执和失败信息转换为持久化终态与诊断字段。
 * @updated 2026-11-27T18:09:00+08:00
 */
import type { RunStatus } from '../../../shared/types.js';

interface RunOutcomeInput {
  cleanupUncertain: boolean;
  cancelReason?: 'user' | 'timeout' | 'shutdown';
  hasFinalResult: boolean;
  failure: string | null;
}

interface RunOutcome {
  status: RunStatus;
  reason: string | null;
  error: string | null;
}

const cancellationOutcomes = {
  user: { status: 'stopped', reason: '用户停止，进程已退出；已发生的修改保留。' },
  shutdown: { status: 'interrupted', reason: '服务关闭，运行中断。' },
  timeout: { status: 'failed', reason: '执行超过设定时限，已停止。' },
} satisfies Record<
  NonNullable<RunOutcomeInput['cancelReason']>,
  Pick<RunOutcome, 'status' | 'reason'>
>;

function outcome(status: RunStatus, reason: string | null): RunOutcome {
  return {
    status,
    reason,
    error: status === 'failed' || status === 'interrupted' ? reason : null,
  };
}

export function resolveRunOutcome({
  cleanupUncertain,
  cancelReason,
  hasFinalResult,
  failure,
}: RunOutcomeInput): RunOutcome {
  if (cleanupUncertain) return outcome('interrupted', failure);
  if (cancelReason) {
    const { status, reason } = cancellationOutcomes[cancelReason];
    return outcome(status, reason);
  }
  if (!hasFinalResult) return outcome('interrupted', failure);
  if (failure) return outcome('failed', failure);
  return outcome('completed', failure);
}

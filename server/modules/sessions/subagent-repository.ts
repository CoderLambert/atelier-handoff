/**
 * @file 定义子任务持久化的具名操作。
 * @implementation 以运行归属和运行中状态约束开始、终结与重启恢复，由调用方将记录和事件放入同一事务。
 * @updated 2026-11-21T12:00:00+00:00
 */
import type { Subagent } from '../../../shared/subagents.js';

export interface SubagentRepository {
  start(value: Subagent): boolean;
  finish(
    id: string,
    runId: string,
    status: Exclude<Subagent['status'], 'running'>,
    summary: string | null,
    endedAt: string,
  ): Subagent | undefined;
  interruptRunning(endedAt: string): Subagent[];
}

/**
 * @file 装配定时任务领域服务与调度器。
 * @implementation 统一创建 ScheduleService 与 ScheduleScheduler，暴露启动、停止与会话归档/删除联动钩子。
 * @updated 2026-11-27T13:20:00+08:00
 */
import type { AgentProfiles } from '../../agent-profiles.js';
import type { Store } from '../../store.js';
import type { StartRun } from '../runs/create-run.js';
import type { Session } from '../../../shared/types.js';
import { createScheduleScheduler } from './scheduler.js';
import { createScheduleService } from './service.js';

export function createSchedulesRuntime(options: {
  store: Pick<Store, 'get' | 'list' | 'update' | 'transaction' | 'event' | 'events' | 'repos'>;
  agents: Pick<AgentProfiles, 'requireReady'>;
  sameSessionRunning(sessionId: string): boolean;
  isShuttingDown(): boolean;
}) {
  let rescheduleTasks: (() => void) | undefined;
  const service = createScheduleService({
    store: options.store,
    agents: options.agents,
    onChanged: () => rescheduleTasks?.(),
  });
  let scheduler: ReturnType<typeof createScheduleScheduler> | undefined;

  function attach(deps: {
    createSession(input: {
      projectId: string;
      agentRevisionId?: string;
      title?: string;
      origin?: 'schedule';
    }): Promise<Session>;
    createRun: StartRun;
  }) {
    scheduler = createScheduleScheduler({
      store: options.store,
      createSession: deps.createSession,
      createRun: deps.createRun,
      sameSessionRunning: options.sameSessionRunning,
      isShuttingDown: options.isShuttingDown,
    });
    rescheduleTasks = scheduler.reschedule;
    scheduler.start();
    return scheduler;
  }

  return { service, attach };
}

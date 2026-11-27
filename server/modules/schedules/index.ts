/**
 * @file 装配定时任务领域服务与调度器。
 * @implementation 统一创建 ScheduleService 与 ScheduleScheduler，并通过 mcpHost 桥接服务与延迟挂载的触发器，避免循环依赖。
 * @updated 2026-11-27T15:05:00+08:00
 */
import { AppError } from '../../../shared/errors.js';
import type { Session } from '../../../shared/types.js';
import type { AgentProfiles } from '../../agent-profiles.js';
import type { Store } from '../../store.js';
import type { StartRun } from '../runs/create-run.js';
import { createScheduleScheduler, type TriggerScheduleOptions } from './scheduler.js';
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

  const mcpHost = {
    list: service.list,
    get: service.get,
    resolve: service.resolve,
    getRun: service.getRun,
    create: service.create,
    update: service.update,
    remove: service.remove,
    trigger: (idOrSlug: string, triggerOptions: TriggerScheduleOptions) => {
      if (!scheduler) {
        throw new AppError('SCHEDULE_NOT_READY', '定时任务调度器尚未就绪。', 503);
      }
      return scheduler.trigger(idOrSlug, triggerOptions);
    },
  };

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

  return { service, mcpHost, attach };
}

/**
 * @file 装配运行的任务规划权限、提示与持久化。
 * @implementation 在当前运行有效时原子替换清单并记录事件，两种工具共用此入口。
 * @updated 2026-11-28T21:12:24+08:00
 */
import { AppError } from '../../../shared/errors.js';
import type { AgentCapability, Run } from '../../../shared/types.js';
import type { Store } from '../../store.js';
import { buildTaskPlanGuidance, nativeTaskPlanningTools } from './task-plan-guidance.js';

export function createRunPlanning(
  store: Pick<Store, 'transaction' | 'update' | 'event'>,
  run: Run,
  verifyCurrent: () => void,
) {
  const hasCapability = (capability: AgentCapability) =>
    !run.agent || run.agent.capabilities.includes(capability);
  const canPlan = run.taskPlanning?.mode !== 'off' && hasCapability('plan');
  const planGuidance = buildTaskPlanGuidance(
    canPlan ? (run.taskPlanning ?? { mode: 'auto' }) : { mode: 'off' },
  );
  return {
    enabledNativeTools: canPlan ? ['TodoWrite'] : [],
    disabledNativeTools: canPlan ? [] : nativeTaskPlanningTools,
    planGuidance,
    allowed: (capability: AgentCapability) =>
      capability === 'plan' ? canPlan : hasCapability(capability),
    updatePlan(plan: Run['plan']) {
      verifyCurrent();
      if (!canPlan) throw new AppError('AGENT_CAPABILITY_DENIED', '本轮未开放任务清单。', 403);
      store.transaction(() => {
        store.update('runs', run.id, { plan });
        store.event(run.id, run.sessionId, 'plan.updated', { plan });
      });
    },
  };
}

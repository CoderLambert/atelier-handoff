/**
 * @file 解析本轮规划策略并生成工具和系统提示共用的模式约束。
 * @implementation 在模型覆盖与全局设置间取值，智能体工具权限优先，拆分提示词可按工作台偏好替换。
 * @updated 2026-11-28T21:12:24+08:00
 */
import { z } from 'zod';
import {
  defaultTaskPlanningPrompt,
  type TaskPlanningMode,
  type TaskPlanningPolicy,
  type TaskPlanningSettings,
} from '../../../shared/task-planning.js';
import type { Run } from '../../../shared/types.js';

export const taskPlanSteps = z
  .array(
    z.object({
      content: z.string().trim().min(1).max(1000),
      status: z.enum(['pending', 'in_progress', 'completed']),
    }),
  )
  .max(30);

export const nativeTaskPlanningTools = [
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
];

export function resolveTaskPlanning(
  settings: TaskPlanningSettings,
  model: string,
  agent: Run['agent'],
): TaskPlanningPolicy {
  const mode =
    agent && !agent.capabilities.includes('plan')
      ? 'off'
      : (settings.modelOverrides.find((override) => override.model === model)?.mode ??
        settings.mode);
  return {
    mode,
    ...(mode !== 'off' && settings.prompt !== null ? { prompt: settings.prompt } : {}),
  };
}

const modeGuidance = {
  auto: '用户明确要求列任务或跟踪进度时建立清单。遇到值得追踪的依赖和验收步骤时也建立清单。例如需要制作交付物并分场景验收时，先调用清单工具记录交付与实际检查，再开始执行。简单任务直接按用户要求的格式给出结果，例如一句话翻译直接回复译文。执行中发现任务变复杂时，可以补建清单。',
  'on-request':
    '仅在用户明确要求列任务或跟踪进度时使用清单工具。没有明确要求时，直接执行任务，即使任务有多步。',
  off: '本轮关闭进度清单工具。用户要求方案时，可在回复中写出方案。',
} satisfies Record<TaskPlanningMode, string>;

export function buildTaskPlanGuidance({ mode, prompt }: TaskPlanningPolicy): string {
  if (mode === 'off') return modeGuidance.off;
  return [
    '任务清单：' + modeGuidance[mode],
    '使用 update_plan 或 TodoWrite 写入同一份清单，每次提交整份更新，无需重复调用另一个工具。拆分提示只适用于应建立清单的任务。',
    prompt ?? defaultTaskPlanningPrompt,
    '例如用户要求桌面、移动端和 A4 验收时，清单写出打开 HTML 检查两种窗口宽度，并打印核对 A4 分页。只在用户明确要求单页时才把页数设为验收条件。',
  ].join('\n');
}

export const taskPlanToolDescription =
  'Record or replace the task checklist. Write each step as a concrete action with an observable completion check. Use the same checklist for update_plan and TodoWrite.';

export const describeTaskPlanTool = (mode: TaskPlanningMode) =>
  taskPlanToolDescription + ' ' + modeGuidance[mode];

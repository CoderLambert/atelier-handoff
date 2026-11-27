/**
 * @file 定义定时任务领域 TanStack Query 键与端点。
 * @implementation 按全局列表、项目筛选、远程令牌管理与单任务运行记录划分缓存键。
 * @updated 2026-11-27T15:15:00+08:00
 */
export const scheduleKeys = {
  all: ['schedules'] as const,
  list: (projectId?: string) => ['schedules', 'list', projectId ?? 'all'] as const,
  runs: (taskId: string) => ['schedules', 'runs', taskId] as const,
};

export function scheduleListEndpoint(projectId?: string): string {
  return projectId ? `/api/schedules?projectId=${encodeURIComponent(projectId)}` : '/api/schedules';
}

export function scheduleDetailEndpoint(taskId: string): string {
  return `/api/schedules/${encodeURIComponent(taskId)}`;
}

export function scheduleRunNowEndpoint(taskId: string): string {
  return `/api/schedules/${encodeURIComponent(taskId)}/run`;
}

export function scheduleTriggerTokenEndpoint(taskId: string): string {
  return `/api/schedules/${encodeURIComponent(taskId)}/trigger-token`;
}

export function scheduleRunsEndpoint(taskId: string, limit = 50): string {
  return `/api/schedules/${encodeURIComponent(taskId)}/runs?limit=${limit}`;
}

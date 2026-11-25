/**
 * @file 定义运行列表、轨迹和操作的查询键。
 * @implementation 使用筛选条件或运行 ID 区分列表、轨迹、停止和重试。
 * @updated 2026-11-20T14:44:21+08:00
 */
export interface RunListFilters {
  projectId: string;
  sessionId: string;
  status: string;
  limit: number;
  offset: number;
}

export const runKeys = {
  list: (filters: RunListFilters | undefined) => ['runs', filters] as const,
  trace: (id: string) => ['trace', id] as const,
  stop: (id: string) => ['runs', id, 'stop'] as const,
  stopSubagent: (id: string) => ['runs', id, 'subagents', 'stop'] as const,
  bash: (id: string) => ['runs', id, 'tools', 'bash'] as const,
  retry: (id: string) => ['runs', id, 'retry'] as const,
};

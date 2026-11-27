/**
 * @file 定义智能体列表与变更的查询键和接口地址。
 * @implementation 按项目隔离列表与变更作用域键，统一生成后端接口路径。
 * @updated 2026-11-27T22:35:00+08:00
 */
export const agentKeys = {
  list: (projectId: string) => ['agents', projectId, 'list'] as const,
  mutations: (projectId: string) => ['agents', projectId, 'mutation'] as const,
};

export const agentEndpoint = (projectId: string, suffix?: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/agents${suffix ? `/${suffix}` : ''}`;

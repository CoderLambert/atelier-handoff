/**
 * @file 集中定义项目查询与变更键。
 * @implementation 按项目、会话和路径或关键词隔离文件列表、内容及搜索缓存。
 * @updated 2026-11-24T03:39:03+08:00
 */
export const projectKeys = {
  files: (projectId: string, path: string, sessionId?: string) =>
    ['project-files', projectId, path, sessionId] as const,
  file: (projectId: string, path: string | null, sessionId?: string) =>
    ['project-file', projectId, path, sessionId] as const,
  searchFiles: (projectId: string, query: string, sessionId?: string) =>
    ['project-files-search', projectId, query, sessionId] as const,
  bind: ['projects', 'bind'] as const,
  pickDirectory: ['projects', 'pick-directory'] as const,
};

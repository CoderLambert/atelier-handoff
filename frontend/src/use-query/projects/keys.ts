/**
 * @file 集中定义项目相关查询和变更键。
 * @implementation 按项目和路径生成文件键，并提供绑定及目录选择键。
 * @updated 2026-11-20T02:00+08:00
 */
export const projectKeys = {
  files: (projectId: string, path: string) => ['project-files', projectId, path] as const,
  file: (projectId: string, path: string | null) => ['project-file', projectId, path] as const,
  bind: ['projects', 'bind'] as const,
  pickDirectory: ['projects', 'pick-directory'] as const,
};

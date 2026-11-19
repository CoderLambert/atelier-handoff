/**
 * @file 定义交付物内容、已保存副本和文件操作的查询键。
 * @implementation 以交付物 ID 区分内容查询、原生保存状态及文件操作 mutation。
 * @updated 2026-11-20T03:34:05+08:00
 */
export const artifactKeys = {
  content: (id: string) => ['artifacts', id, 'content'] as const,
  savedCopy: (id: string) => ['artifact-saved-copy', id] as const,
  fileAction: (id: string) => ['artifact-file-action', id] as const,
};

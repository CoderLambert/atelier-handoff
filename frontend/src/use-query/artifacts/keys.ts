/**
 * @file 定义交付物内容与已保存副本的缓存键。
 * @implementation 内容沿用现有交付物键，原生保存状态按不可变交付物 ID 隔离。
 * @updated 2026-11-20T11:00:00+08:00
 */
export const artifactKeys = {
  content: (id: string) => ['artifacts', id, 'content'] as const,
  savedCopy: (id: string) => ['artifact-saved-copy', id] as const,
  fileAction: (id: string) => ['artifact-file-action', id] as const,
};

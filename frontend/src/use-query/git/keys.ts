/**
 * @file 定义 Git 查询键与授权项目入口。
 * @implementation 按项目、工作树、提交、变更层及文件版本与路径隔离缓存，按分析编号与快照版本区分进度。
 * @updated 2026-11-25T16:53:09+08:00
 */
import type { GitDiffLayer, GitHistoryQuery } from '@shared/git-workbench';

const project = (id: string) => ['git', id] as const;
const diffs = (id: string, tree?: string) => [...project(id), 'diff', tree] as const;
export const gitKeys = {
  project,
  overview: (id: string) => [...project(id), 'overview'] as const,
  files: (id: string, tree?: string) => [...project(id), 'files', tree] as const,
  diffs,
  diff: (id: string, tree?: string, path?: string, layer?: GitDiffLayer) =>
    [...diffs(id, tree), path, layer] as const,
  history: (id: string, oid?: string, filters?: GitHistoryQuery) =>
    [
      ...project(id),
      'history',
      oid,
      filters?.query ?? '',
      filters?.author ?? '',
      filters?.since ?? '',
    ] as const,
  commit: (id: string, oid?: string) => [...project(id), 'commit', oid] as const,
  fileContent: (id: string, revision: string, source: string, path: string) =>
    [...project(id), 'file-content', revision, source, path] as const,
  repoStatus: (cwd?: string) => ['desktop-git', 'status', cwd ?? ''] as const,
  analysisProgress: (id: string, tree: string, analysisId?: string, version?: string) =>
    [...project(id), 'analysis-progress', tree, analysisId, version] as const,
};
export const gitUrl = (projectId: string) =>
  '/api/projects/' + encodeURIComponent(projectId) + '/git';
export const gitTreeUrl = (projectId: string, treeId: string) =>
  gitUrl(projectId) + '/worktrees/' + encodeURIComponent(treeId);

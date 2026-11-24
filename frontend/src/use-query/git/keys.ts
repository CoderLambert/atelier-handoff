/**
 * @file 定义 Git 查询键与授权项目入口。
 * @implementation 按项目、工作树、提交和差异层隔离缓存，按分析编号与快照版本区分进度。
 * @updated 2026-11-24T22:06:05+08:00
 */
import type { GitDiffLayer } from '@shared/git-workbench';

const project = (id: string) => ['git', id] as const;
const diffs = (id: string, tree?: string) => [...project(id), 'diff', tree] as const;
export const gitKeys = {
  project,
  overview: (id: string) => [...project(id), 'overview'] as const,
  files: (id: string, tree?: string) => [...project(id), 'files', tree] as const,
  diffs,
  diff: (id: string, tree?: string, path?: string, layer?: GitDiffLayer) =>
    [...diffs(id, tree), path, layer] as const,
  history: (id: string, oid?: string) => [...project(id), 'history', oid] as const,
  commit: (id: string, oid?: string) => [...project(id), 'commit', oid] as const,
  analysisProgress: (id: string, tree: string, analysisId?: string, version?: string) =>
    [...project(id), 'analysis-progress', tree, analysisId, version] as const,
};
export const gitUrl = (projectId: string) =>
  '/api/projects/' + encodeURIComponent(projectId) + '/git';
export const gitTreeUrl = (projectId: string, treeId: string) =>
  gitUrl(projectId) + '/worktrees/' + encodeURIComponent(treeId);

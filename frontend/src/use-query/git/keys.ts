/**
 * @file 定义 Git 查询键与授权项目入口。
 * @implementation 按项目分离可失效的工作树查询和按提交固定的历史缓存，再按路径、变更层及分析快照细分查询键。
 * @updated 2026-11-26T21:32:56+08:00
 */
import type { GitDiffLayer, GitHistoryQuery } from '@shared/git-workbench';

const project = (id: string) => ['git', id] as const;
const live = (id: string) => [...project(id), 'live'] as const;
const diffs = (id: string, tree?: string) => [...live(id), 'diff', tree] as const;
export const gitKeys = {
  project,
  live,
  overview: (id: string) => [...live(id), 'overview'] as const,
  files: (id: string, tree?: string) => [...live(id), 'files', tree] as const,
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
  workingFileContent: (id: string, tree: string, source: string, path: string) =>
    [...live(id), 'file-content', tree, source, path] as const,
  commitFileContent: (id: string, oid: string, source: string, path: string) =>
    [...project(id), 'file-content', oid, source, path] as const,
  repoStatus: (id: string, cwd?: string) => [...live(id), 'desktop-status', cwd] as const,
  analysisProgress: (id: string, tree: string, analysisId?: string, version?: string) =>
    [...project(id), 'analysis-progress', tree, analysisId, version] as const,
};
export const gitUrl = (projectId: string) =>
  '/api/projects/' + encodeURIComponent(projectId) + '/git';
export const gitTreeUrl = (projectId: string, treeId: string) =>
  gitUrl(projectId) + '/worktrees/' + encodeURIComponent(treeId);

/**
 * @file 注册项目 Git HTTP 路由。
 * @implementation 按既有方法与路径范围查找项目和工作树标识，再分发查询、开发会话和工作树操作。
 * @updated 2026-11-26T23:24:11+08:00
 */
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { GatewayService } from '../../modules/gateway/service.js';
import type { CommitAnalysisSessions } from '../../modules/git/commit-analysis-sessions.js';
import type { DevelopmentWorktrees } from '../../modules/git/development-worktrees.js';
import type { Store } from '../../store.js';
import type { RouteHandler } from '../types.js';
import { postCommitPlan } from './commit-plan.js';
import { postGitDevelopment } from './development.js';
import { readProjectGit } from './read.js';
import { postWorktreeWrite } from './worktree-writes.js';

export interface GitRouteOptions {
  store: Pick<Store, 'get' | 'directory' | 'gitCommitOperations'>;
  worktrees: Pick<
    DevelopmentWorktrees,
    | 'preview'
    | 'create'
    | 'sessionWorkspace'
    | 'checkout'
    | 'writeCheckout'
    | 'markRebuildable'
    | 'reclaim'
    | 'overview'
  >;
  commitAnalyses: Pick<CommitAnalysisSessions, 'analyze' | 'progress'>;
  gateway: Pick<GatewayService, 'effectiveConfig' | 'magpie' | 'requireMagpieEnabled'>;
  desktopPaired: boolean;
  streams: Set<ServerResponse>;
  isShuttingDown: () => boolean;
}

export function createGitRoutes(options: GitRouteOptions): RouteHandler {
  const { store, worktrees } = options;
  return (request) => {
    const { parts, method } = request;
    const [api, projects, projectId, resource, section, worktreeId, action] = parts;
    if (api !== 'api' || projects !== 'projects' || !projectId || resource !== 'git') return false;

    if (method === 'GET') return readProjectGit(options, request, store.get('projects', projectId));
    if (method !== 'POST') return false;
    // Look up the project (and validate the POST worktree ID) before matching the action.
    if (parts.length === 5)
      return postGitDevelopment(worktrees, request, store.get('projects', projectId));
    if (parts.length === 7 && section === 'worktrees' && worktreeId) {
      const project = store.get('projects', projectId);
      const id = z.uuid().parse(worktreeId);
      return action?.startsWith('commit-plan')
        ? postCommitPlan(options, request, project, id)
        : postWorktreeWrite(options, request, project, id);
    }
    return false;
  };
}

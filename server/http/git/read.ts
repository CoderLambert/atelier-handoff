/**
 * @file 提供项目 Git 概览、工作树读取、历史和变更订阅接口。
 * @implementation 保留检出和路径授权顺序；为查询传递断开信号，将 SSE 响应纳入运行时关闭管理。
 * @updated 2026-11-26T23:24:11+08:00
 */
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { multiCommitProgressRequest } from '../../../shared/git-multi-commit.js';
import {
  gitCommitFileSource,
  gitDiffLayer,
  gitOid,
  gitPath,
  gitWorkingFileSource,
} from '../../../shared/git-workbench.js';
import type { Project } from '../../../shared/types.js';
import { resolveProjectPath } from '../../files.js';
import type { CommitAnalysisSessions } from '../../modules/git/commit-analysis-sessions.js';
import {
  listPendingCommitPlans,
  type CommitPlanStore,
} from '../../modules/git/commit-plan-operations.js';
import type { DevelopmentWorktrees } from '../../modules/git/development-worktrees.js';
import { gitError, LocalGit } from '../../modules/git/git-cli.js';
import { readGitFileContent } from '../../modules/git/git-file-content.js';
import {
  readCommitDiff,
  readFileDiff,
  readGitHistory,
  readGitStatus,
} from '../../modules/git/git-reader.js';
import { json } from '../response.js';
import type { RouteRequest } from '../types.js';
import { streamGitChanges } from './changes.js';
import { withGitDisconnect } from './disconnect.js';

interface GitReadOptions {
  store: CommitPlanStore;
  worktrees: Pick<DevelopmentWorktrees, 'checkout' | 'overview'>;
  commitAnalyses: Pick<CommitAnalysisSessions, 'progress'>;
  desktopPaired: boolean;
  streams: Set<ServerResponse>;
  isShuttingDown: () => boolean;
}

export function readProjectGit(
  { store, worktrees, commitAnalyses, desktopPaired, streams, isShuttingDown }: GitReadOptions,
  { res, url, parts }: RouteRequest,
  project: Project,
) {
  const [, , , , section, id, action] = parts;
  if (
    parts.length === 7 &&
    section === 'worktrees' &&
    id &&
    action === 'commit-analysis-progress'
  ) {
    // Progress is an in-memory, version-scoped read; it does not reopen Git.
    const worktreeId = z.uuid().parse(id);
    const { analysisId, version } = multiCommitProgressRequest.parse({
      analysisId: url.searchParams.get('analysisId'),
      version: url.searchParams.get('version'),
    });
    return json(res, {
      progress: commitAnalyses.progress({ projectId: project.id, worktreeId, version }, analysisId),
    });
  }

  return withGitDisconnect(res, async (signal) => {
    if (parts.length === 7 && section === 'worktrees' && id) {
      // All other worktree reads check out first, even an unknown or desktop-only action.
      const { git, rebuildable } = await worktrees.checkout(project, id, signal);
      if (action === 'commit-plan-pending')
        return json(res, { items: await listPendingCommitPlans(store, project.id, git) });
      if (action === 'status')
        return json(res, { ...(await readGitStatus(git, signal)), rebuildable });
      if (action === 'changes') {
        await streamGitChanges(git, res, streams, signal);
        if (isShuttingDown()) res.end();
        return true;
      }
      if (action === 'file-content') {
        const path = gitPath.parse(url.searchParams.get('path'));
        const source = gitWorkingFileSource.parse(url.searchParams.get('source'));
        return json(res, await readGitFileContent(git, path, source, signal));
      }
      if (action === 'file-location' && desktopPaired) {
        const path = gitPath.parse(url.searchParams.get('path'));
        return json(res, { location: await resolveProjectPath(git.root, path) });
      }
      if (action === 'diff') {
        const path = gitPath.parse(url.searchParams.get('path'));
        const layer = gitDiffLayer.parse(url.searchParams.get('layer'));
        return json(res, await readFileDiff(git, path, layer, signal));
      }
    }
    // Fallback also probes the project repository before reporting an unknown Git path.
    const git = await LocalGit.open(project.path, signal);
    if (parts.length === 4) return json(res, await worktrees.overview(project, git, signal));
    if (parts.length === 5 && section === 'history') {
      const oid = gitOid.parse(url.searchParams.get('oid'));
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(100_000)
        .parse(url.searchParams.get('offset') ?? '0');
      const query = url.searchParams.get('query')?.trim() || undefined;
      const author = url.searchParams.get('author')?.trim() || undefined;
      const since = url.searchParams.get('since')?.trim() || undefined;
      return json(res, await readGitHistory(git, oid, offset, { query, author, since }, signal));
    }
    if (parts.length === 7 && section === 'commits' && action === 'file-content') {
      const oid = gitOid.parse(id);
      const path = gitPath.parse(url.searchParams.get('path'));
      const source = gitCommitFileSource.parse(url.searchParams.get('source'));
      return json(
        res,
        await readGitFileContent(git, path, { oid, parent: source === 'parent' }, signal),
      );
    }
    if (parts.length === 6 && section === 'commits')
      return json(res, await readCommitDiff(git, gitOid.parse(id), signal));
    throw gitError('WORKTREE_MISSING', '所选工作树不属于此项目。', 404);
  });
}

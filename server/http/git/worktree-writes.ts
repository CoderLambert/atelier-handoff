/**
 * @file 提供工作树文件、暂存、单提交和回收写接口。
 * @implementation 解析共享请求并调用工作树用例，仅提交草稿随客户端断开取消。
 * @updated 2026-11-26T23:24:11+08:00
 */
import {
  gitCacheRequest,
  gitCommitDraftRequest,
  gitCommitRequest,
  gitFileDiscardRequest,
  gitFileIndexRequest,
  gitReclaimRequest,
} from '../../../shared/git-workbench.js';
import type { Project } from '../../../shared/types.js';
import type { GatewayService } from '../../modules/gateway/service.js';
import type { DevelopmentWorktrees } from '../../modules/git/development-worktrees.js';
import {
  commitWorktreeIndex,
  discardWorktreeFiles,
  draftWorktreeCommit,
  updateWorktreeIndex,
} from '../../modules/git/worktree-writes.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteRequest } from '../types.js';
import { withGitDisconnect } from './disconnect.js';

interface WorktreeWriteOptions {
  worktrees: Pick<
    DevelopmentWorktrees,
    'checkout' | 'writeCheckout' | 'markRebuildable' | 'reclaim'
  >;
  gateway: Pick<GatewayService, 'effectiveConfig' | 'magpie'>;
}

export async function postWorktreeWrite(
  { worktrees, gateway }: WorktreeWriteOptions,
  { req, res, parts }: RouteRequest,
  project: Project,
  id: string,
) {
  switch (parts[6]) {
    case 'file-discard': {
      const input = gitFileDiscardRequest.parse(await body(req));
      return json(res, await discardWorktreeFiles(worktrees, project, id, input));
    }
    case 'file-index': {
      const input = gitFileIndexRequest.parse(await body(req));
      return json(res, await updateWorktreeIndex(worktrees, project, id, input));
    }
    case 'commit-draft': {
      const input = gitCommitDraftRequest.parse(await body(req));
      return withGitDisconnect(res, async (signal) =>
        json(res, await draftWorktreeCommit(worktrees, gateway, project, id, input, signal)),
      );
    }
    case 'commit': {
      const input = gitCommitRequest.parse(await body(req));
      return json(res, await commitWorktreeIndex(worktrees, project, id, input), 201);
    }
    case 'cache': {
      const { path, rebuildable } = gitCacheRequest.parse(await body(req));
      return json(res, await worktrees.markRebuildable(project, id, path, rebuildable));
    }
    case 'reclaim': {
      const { requestId } = gitReclaimRequest.parse(await body(req));
      return json(res, { workspace: await worktrees.reclaim(project, id, requestId) });
    }
    default:
      return false;
  }
}

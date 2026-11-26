/**
 * @file 提供项目 Git 开发会话的预览和创建接口。
 * @implementation 校验来源与分支请求；创建成功后返回公开会话及工作区状态。
 * @updated 2026-11-26T23:24:11+08:00
 */
import { developmentCreate, developmentPreview } from '../../../shared/git-workbench.js';
import type { Project } from '../../../shared/types.js';
import type { DevelopmentWorktrees } from '../../modules/git/development-worktrees.js';
import { publicSession } from '../../session-forks.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteRequest } from '../types.js';

export async function postGitDevelopment(
  worktrees: Pick<DevelopmentWorktrees, 'preview' | 'create' | 'sessionWorkspace'>,
  { req, res, parts }: RouteRequest,
  project: Project,
) {
  if (parts[4] === 'preview')
    return json(res, await worktrees.preview(project, developmentPreview.parse(await body(req))));
  if (parts[4] === 'sessions') {
    const session = await worktrees.create(project, developmentCreate.parse(await body(req)));
    return json(
      res,
      {
        session: publicSession(session),
        workspace: await worktrees.sessionWorkspace(session),
      },
      201,
    );
  }
  return false;
}

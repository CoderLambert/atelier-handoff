/**
 * @file 提供工作区位置、布局、主题与 Git 多提交偏好的 HTTP 接口。
 * @implementation 按精确路径匹配，复用共享 schema 和既有偏好读写操作。
 * @updated 2026-11-26T22:26:22+08:00
 */
import { z } from 'zod';
import { uiThemeSchema, type UiTheme } from '../../../shared/desktop-ui-theme.js';
import {
  gitMultiCommitPreferences,
  type GitMultiCommitPreferences,
} from '../../../shared/git-multi-commit.js';
import { workspaceLayoutSchema, type WorkspaceLayout } from '../../../shared/workspace-layout.js';
import { workspaceLocationSchema } from '../../../shared/workspace-location.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

const uiThemePatch = z.strictObject({ theme: uiThemeSchema });

export interface WorkspacePreferenceOptions {
  workspaceLayout: {
    saveLocation(path: string): { path: string };
    read(): WorkspaceLayout;
    save(layout: WorkspaceLayout): WorkspaceLayout;
    readTheme(): UiTheme;
    saveTheme(theme: UiTheme): UiTheme;
  };
  gitMultiCommitPreferences: {
    read(): GitMultiCommitPreferences;
    save(preferences: GitMultiCommitPreferences): GitMultiCommitPreferences;
  };
}

export function createWorkspacePreferenceRoutes({
  workspaceLayout,
  gitMultiCommitPreferences: preferences,
}: WorkspacePreferenceOptions): RouteHandler {
  return async ({ req, res, url, method }) => {
    switch (url.pathname) {
      case '/api/settings/workspace-location': {
        if (method !== 'PATCH') return false;
        const { path } = workspaceLocationSchema.parse(await body(req));
        return json(res, workspaceLayout.saveLocation(path));
      }
      case '/api/settings/workspace-layout':
        if (method === 'GET') return json(res, workspaceLayout.read());
        if (method === 'PATCH')
          return json(res, workspaceLayout.save(workspaceLayoutSchema.parse(await body(req))));
        return false;
      case '/api/settings/git-multi-commit-preferences':
        if (method === 'GET') return json(res, preferences.read());
        if (method === 'PATCH')
          return json(res, preferences.save(gitMultiCommitPreferences.parse(await body(req))));
        return false;
      case '/api/settings/ui-theme': {
        if (method === 'GET') return json(res, { theme: workspaceLayout.readTheme() });
        if (method !== 'PATCH') return false;
        const { theme } = uiThemePatch.parse(await body(req));
        return json(res, { theme: workspaceLayout.saveTheme(theme) });
      }
      default:
        return false;
    }
  };
}

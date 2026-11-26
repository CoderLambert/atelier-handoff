/**
 * @file 注册工作台设置 HTTP 路由。
 * @implementation 分发独立快捷偏好、工作区偏好与网关请求，RTK 设置在校验范围后探测内置资源并读写策略。
 * @updated 2026-11-27T01:26:00+08:00
 */
import { rtkSettingsPatchSchema, rtkSettingsScopeSchema } from '../../../shared/rtk-settings.js';
import { builtinRtkAvailable } from '../../builtin-rtk.js';
import type { RtkSettings } from '../../rtk-settings.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';
import { createGatewayRoutes, type GatewayRouteOptions } from './gateway.js';
import { createShortcutPreferenceRoutes, type ShortcutPreferenceOptions } from './shortcuts.js';
import {
  createWorkspacePreferenceRoutes,
  type WorkspacePreferenceOptions,
} from './workspace-preferences.js';

export interface SettingsRoutesOptions
  extends GatewayRouteOptions, WorkspacePreferenceOptions, ShortcutPreferenceOptions {
  rtkSettings: Pick<RtkSettings, 'view' | 'update'>;
  rtkBinary?: string;
  nativeExecution: boolean;
  requireProject(projectId: string): void;
}

export function createSettingsRoutes(options: SettingsRoutesOptions): RouteHandler {
  const gatewayRoutes = createGatewayRoutes(options);
  const preferences = createWorkspacePreferenceRoutes(options);
  const shortcuts = createShortcutPreferenceRoutes(options);
  const { rtkSettings, rtkBinary, nativeExecution, requireProject } = options;

  return async (request) => {
    const { req, res, url, method } = request;
    if (url.pathname === '/api/rtk-settings' && (method === 'GET' || method === 'PATCH')) {
      const { projectId } = rtkSettingsScopeSchema.parse(Object.fromEntries(url.searchParams));
      if (projectId) requireProject(projectId);
      const available = await builtinRtkAvailable(rtkBinary);
      if (method === 'PATCH')
        rtkSettings.update(projectId, rtkSettingsPatchSchema.parse(await body(req)));
      return json(res, rtkSettings.view(projectId, available, nativeExecution));
    }
    if (url.pathname.startsWith('/api/settings/'))
      return (await shortcuts(request)) || preferences(request);
    return gatewayRoutes(request);
  };
}

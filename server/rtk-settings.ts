/**
 * @file 解析和更新内置 RTK 的有效设置。
 * @implementation 由运行时 Store 保存全局默认与项目覆盖，逐次读取设置并验证项目身份，能力状态与用户偏好分别返回。
 * @updated 2026-11-27T21:25:00+08:00
 */
import type { RtkSettingsPatch, RtkSettingsView } from '../shared/rtk-settings.js';
import { AppError } from '../shared/errors.js';
import type { Store } from './store.js';

export class RtkSettings {
  constructor(private readonly store: Store) {}

  enabled(projectId: string): boolean {
    return this.view(projectId, true, true).effectiveEnabled;
  }

  view(
    projectId: string | undefined,
    resourceAvailable: boolean,
    nativeAvailable: boolean,
  ): RtkSettingsView {
    if (projectId) this.store.get('projects', projectId);
    return this.store.readTransaction(() => {
      const globalEnabled = this.store.rtkSettings.readGlobal();
      const projectMode = projectId ? this.store.rtkSettings.projectMode(projectId) : 'follow';
      return {
        globalEnabled,
        projectMode,
        effectiveEnabled: projectMode === 'follow' ? globalEnabled : projectMode === 'on',
        source: projectMode === 'follow' ? 'global' : 'project',
        available: resourceAvailable && nativeAvailable,
        ...(!nativeAvailable
          ? { unavailableReason: 'native-unavailable' as const }
          : !resourceAvailable
            ? { unavailableReason: 'resource-unavailable' as const }
            : {}),
      };
    });
  }

  update(projectId: string | undefined, patch: RtkSettingsPatch): void {
    if (projectId) this.store.get('projects', projectId);
    if ((patch.type === 'global') !== (projectId === undefined))
      throw new AppError('INVALID_INPUT', 'RTK 设置范围无效。', 400);
    if (patch.type === 'global') this.store.rtkSettings.setGlobal(patch.enabled);
    else if (projectId) this.store.rtkSettings.setProjectMode(projectId, patch.mode);
  }
}

/**
 * @file 定义 RTK 设置的查询身份与端点。
 * @implementation 区分全局与每个项目的缓存和 URL，避免项目切换时复用其他项目的设置。
 * @updated 2026-11-26T01:39:35+08:00
 */
export const rtkSettingsKeys = {
  all: ['rtk-settings'] as const,
  view: (projectId?: string) => ['rtk-settings', projectId ?? null] as const,
  update: ['rtk-settings-update'] as const,
};

export function rtkSettingsEndpoint(projectId?: string) {
  return '/api/rtk-settings' + (projectId ? `?${new URLSearchParams({ projectId })}` : '');
}

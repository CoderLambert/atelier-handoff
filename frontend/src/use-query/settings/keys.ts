/**
 * @file 定义应用设置的查询与修改键。
 * @implementation 集中提供配置快照、模型和快捷偏好的缓存键及配置保存的 mutation key。
 * @updated 2026-11-26T21:58:23+08:00
 */
export const settingsKeys = {
  config: ['config'] as const,
  models: ['models'] as const,
  updateConfig: ['config', 'update'] as const,
  gatewayLogin: ['config', 'gateway-login'] as const,
  shortcuts: ['settings', 'shortcuts'] as const,
};

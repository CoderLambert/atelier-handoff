/**
 * @file 定义应用设置的查询与修改键。
 * @implementation 复用配置快照缓存键，为配置保存提供独立 mutation key。
 * @updated 2026-11-20T15:07:56+08:00
 */
export const settingsKeys = {
  config: ['config'] as const,
  models: ['models'] as const,
  updateConfig: ['config', 'update'] as const,
  gatewayLogin: ['config', 'gateway-login'] as const,
};

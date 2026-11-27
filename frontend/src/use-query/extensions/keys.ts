/**
 * @file 定义扩展与 GitHub 连接的 API 地址和缓存键。
 * @implementation 按项目生成目录、预览、SkillHub 搜索和工具绑定的键，单独维护 picker 目录与全局 GitHub 连接的键。
 * @updated 2026-11-27T21:25:00+08:00
 */
import type { PublicPreviewInput } from '@shared/public-extensions';

export const endpoint = (projectId: string, suffix?: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/extensions${suffix ? `/${suffix}` : ''}`;
export const extensionKeys = {
  all: (projectId: string) => ['extensions', projectId] as const,
  list: (projectId: string) => ['extensions', projectId, 'list'] as const,
  mutations: (projectId: string) => ['extensions', projectId, 'mutation'] as const,
  publicPreview: (projectId: string, input: PublicPreviewInput) =>
    ['extensions', projectId, 'public-preview', input] as const,
  skillHubSearch: (projectId: string, query: string) =>
    ['extensions', projectId, 'skillhub-search', query] as const,
  toolBindings: (projectId: string, skillId: string) =>
    ['extensions', projectId, 'tool-bindings', skillId] as const,
};

export const extensionPickerKeys = {
  all: ['extension-picker'] as const,
  list: (projectId: string) => [...extensionPickerKeys.all, projectId] as const,
};

export const githubConnection = {
  key: ['github-public-connection'] as const,
  endpoint: '/api/extensions/github-connection',
};
